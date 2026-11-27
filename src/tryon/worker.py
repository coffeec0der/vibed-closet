#!/usr/bin/env python3
"""
Libre Closet try-on worker.

Runs CatVTON-style virtual try-on (Stable Diffusion 1.5 inpainting + CatVTON
self-attention weights) on CPU or GPU. Used two ways:

  * locally, one job per process, spawned by the Libre Closet server:
        python worker.py run --models DIR --job job.json
  * remotely, as a small HTTP server on another machine (e.g. a gaming PC):
        python worker.py serve --models DIR --port 8188 [--token SECRET]

Other commands:
        python worker.py download --models DIR   # fetch all model weights
        python worker.py check --models DIR      # verify an installation
        python worker.py selftest                # tiny random models, no download

Progress is reported on stdout as lines of the form
        PROGRESS <stage> <current> <total>
and the final line of a successful `run` is `DONE <output path>`.

Model weights are downloaded from Hugging Face at install time and are NOT
part of Libre Closet. CatVTON weights are licensed CC BY-NC-SA 4.0
(non-commercial); Stable Diffusion 1.5 inpainting is CreativeML OpenRAIL-M.
"""

from __future__ import annotations

import argparse
import base64
import gc
import io
import json
import os
import sys
import threading
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Model sources
# ---------------------------------------------------------------------------

CATVTON_REPO = "zhengchong/CatVTON"
# "mix" supports upper / lower / overall garments (trained on VITON-HD,
# DressCode and DeepFashion).
CATVTON_VERSION = "mix-48k-1024"
# The original runwayml repo is gone; these are mirrors of the same weights,
# tried in order.
INPAINT_REPOS = [
    "booksforcharlie/stable-diffusion-inpainting",
    "stable-diffusion-v1-5/stable-diffusion-inpainting",
    "botp/stable-diffusion-v1-5-inpainting",
]
VAE_REPO = "stabilityai/sd-vae-ft-mse"
# Clothes segmentation (MIT) used to build the try-on mask automatically.
SEGFORMER_REPO = "mattmdjaga/segformer_b2_clothes"

# segformer_b2_clothes labels
LBL = {
    "background": 0, "hat": 1, "hair": 2, "sunglasses": 3, "upper": 4,
    "skirt": 5, "pants": 6, "dress": 7, "belt": 8, "lshoe": 9, "rshoe": 10,
    "face": 11, "lleg": 12, "rleg": 13, "larm": 14, "rarm": 15, "bag": 16,
    "scarf": 17,
}
MASK_LABELS = {
    # Arms are included so sleeve length can change.
    "upper": ["upper", "larm", "rarm", "scarf"],
    "lower": ["skirt", "pants", "lleg", "rleg", "belt"],
    "overall": ["upper", "skirt", "pants", "dress", "belt", "larm", "rarm",
                "lleg", "rleg", "scarf"],
}
# Fallback mask boxes (fractions of the image) when segmentation finds nothing.
FALLBACK_BOX = {
    "upper": (0.15, 0.18, 0.85, 0.62),
    "lower": (0.18, 0.45, 0.82, 0.97),
    "overall": (0.12, 0.18, 0.88, 0.97),
}
# CatVTON concatenates person and garment along the height axis.
CONCAT_DIM = -2


def log_progress(stage: str, current: int, total: int) -> None:
    print(f"PROGRESS {stage} {current} {total}", flush=True)


def log(msg: str) -> None:
    print(f"LOG {msg}", flush=True)


def mem_report(stage: str) -> None:
    """Logs this process's memory and the machine's available memory, so an
    out-of-memory failure can be traced to a phase from the add-on log."""
    def read(path: str, keys: tuple[str, ...]) -> dict[str, int]:
        out = {}
        try:
            for line in open(path):
                k, _, v = line.partition(":")
                if k in keys:
                    out[k] = int(v.split()[0]) // 1024
        except OSError:
            pass
        return out

    me = read("/proc/self/status", ("VmRSS", "RssAnon"))
    sysm = read("/proc/meminfo", ("MemTotal", "MemAvailable", "SwapFree"))
    log(f"MEM {stage}: process {me.get('RssAnon', '?')} MB "
        f"(rss {me.get('VmRSS', '?')} MB), machine available "
        f"{sysm.get('MemAvailable', '?')}/{sysm.get('MemTotal', '?')} MB, "
        f"swap free {sysm.get('SwapFree', '?')} MB")


def release_memory() -> None:
    """Frees Python objects and hands freed heap pages back to the OS, so a
    model that was just deleted doesn't keep counting against RAM."""
    gc.collect()
    try:
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------


def _pick(files: list[str], prefix: str, names: list[str]) -> str | None:
    for n in names:
        if f"{prefix}{n}" in files:
            return f"{prefix}{n}"
    return None


def download(models: Path) -> None:
    from huggingface_hub import HfApi, snapshot_download

    api = HfApi()
    models.mkdir(parents=True, exist_ok=True)
    total = 4

    # 1. SD 1.5 inpainting UNet + scheduler (prefer the fp16 file: half size)
    log_progress("download", 0, total)
    last_err = None
    for repo in INPAINT_REPOS:
        try:
            files = api.list_repo_files(repo)
            unet = _pick(files, "unet/", [
                "diffusion_pytorch_model.fp16.safetensors",
                "diffusion_pytorch_model.safetensors",
                "diffusion_pytorch_model.fp16.bin",
                "diffusion_pytorch_model.bin",
            ])
            if not unet:
                raise RuntimeError(f"{repo} has no UNet weights")
            log(f"Downloading {repo}/{unet}")
            snapshot_download(
                repo,
                local_dir=models / "sd-inpainting",
                allow_patterns=[unet, "unet/config.json", "scheduler/*"],
            )
            (models / "sd-inpainting" / "source.json").write_text(
                json.dumps({"repo": repo, "unet": unet})
            )
            break
        except Exception as e:  # try the next mirror
            last_err = e
            log(f"{repo} failed: {e}")
    else:
        raise RuntimeError(f"Could not download SD inpainting: {last_err}")

    # 2. VAE
    log_progress("download", 1, total)
    log(f"Downloading {VAE_REPO}")
    files = api.list_repo_files(VAE_REPO)
    vae = _pick(files, "", ["diffusion_pytorch_model.safetensors",
                            "diffusion_pytorch_model.bin"])
    snapshot_download(VAE_REPO, local_dir=models / "sd-vae-ft-mse",
                      allow_patterns=["config.json", vae])

    # 3. CatVTON attention weights
    log_progress("download", 2, total)
    log(f"Downloading {CATVTON_REPO}/{CATVTON_VERSION}/attention")
    snapshot_download(CATVTON_REPO, local_dir=models / "catvton",
                      allow_patterns=[f"{CATVTON_VERSION}/attention/*"])

    # 4. Clothes segmentation
    log_progress("download", 3, total)
    log(f"Downloading {SEGFORMER_REPO}")
    files = api.list_repo_files(SEGFORMER_REPO)
    seg = _pick(files, "", ["model.safetensors", "pytorch_model.bin"])
    snapshot_download(SEGFORMER_REPO, local_dir=models / "segformer",
                      allow_patterns=["config.json", "preprocessor_config.json",
                                      seg])
    log_progress("download", total, total)
    ensure_bf16_unet(models)


def check(models: Path) -> None:
    missing = [p for p in [
        models / "sd-inpainting" / "unet" / "config.json",
        models / "sd-inpainting" / "scheduler",
        models / "sd-vae-ft-mse" / "config.json",
        models / "catvton" / CATVTON_VERSION / "attention",
        models / "segformer" / "config.json",
    ] if not p.exists()]
    if missing:
        raise RuntimeError("Missing model files: " + ", ".join(map(str, missing)))
    import torch  # noqa: F401
    import diffusers  # noqa: F401
    import transformers  # noqa: F401
    log(f"torch {torch.__version__}, diffusers {diffusers.__version__}, "
        f"transformers {transformers.__version__}")


# ---------------------------------------------------------------------------
# Device / dtype
# ---------------------------------------------------------------------------


def pick_device():
    import torch

    forced = os.environ.get("TRYON_DEVICE")
    if forced:
        return forced
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def pick_dtype(device: str):
    import torch

    name = os.environ.get("TRYON_DTYPE")
    if name:
        return {"float32": torch.float32, "bfloat16": torch.bfloat16,
                "float16": torch.float16}[name]
    # bf16 halves memory on CPU (~1.7 GB UNet instead of 3.4 GB).
    return torch.float16 if device in ("cuda", "mps") else torch.bfloat16


# ---------------------------------------------------------------------------
# CatVTON pipeline
# ---------------------------------------------------------------------------


class SkipAttnProcessor:
    """Replaces cross-attention: CatVTON has no text conditioning."""

    def __call__(self, attn, hidden_states, encoder_hidden_states=None,
                 attention_mask=None, temb=None, *args, **kwargs):
        return hidden_states


def patch_unet(unet) -> None:
    from diffusers.models.attention_processor import AttnProcessor2_0

    procs = {}
    for name in unet.attn_processors.keys():
        procs[name] = (AttnProcessor2_0() if name.endswith("attn1.processor")
                       else SkipAttnProcessor())
    unet.set_attn_processor(procs)


def self_attention_layers(unet) -> list:
    """The UNet's self-attention modules (".attn1") in model order."""
    return [m for name, m in unet.named_modules() if name.endswith("attn1")]


def load_attention_weights(unet, ckpt_dir: Path) -> None:
    """Loads CatVTON's self-attention weights into the UNet.

    CatVTON saves them with keys like "104.to_k.weight": an index into a flat
    list of modules it built from the UNet, followed by the parameter name.
    That list also holds child modules (and, in CatVTON's code, its attention
    processors), so the index step per layer depends on library details.
    Instead of rebuilding that list, read the layout from the file: entries
    with "<i>.to_q.weight" are whole attention layers; sorted by index they
    match the UNet's self-attention layers one to one. Full parameter names
    ("...attn1.to_q.weight", optionally prefixed "unet.") are accepted too.
    Every self-attention parameter must receive a value."""
    import re

    import torch
    from safetensors import safe_open

    files = sorted(ckpt_dir.glob("*.safetensors"))
    if not files:
        raise RuntimeError(f"No safetensors in {ckpt_dir}")
    layers = self_attention_layers(unet)
    if not layers:
        raise RuntimeError("UNet has no self-attention layers")

    keys = []
    for f in files:
        with safe_open(str(f), framework="pt") as fh:
            keys += [(f, k) for k in fh.keys()]
    layer_index = sorted({int(k.split(".", 1)[0]) for _, k in keys
                          if re.fullmatch(r"\d+\.to_q\.weight", k)})
    by_index = {}
    if layer_index:
        if len(layer_index) != len(layers):
            raise RuntimeError(
                f"CatVTON checkpoint has {len(layer_index)} attention layers, "
                f"the UNet has {len(layers)}. Model files may not match.")
        by_index = dict(zip(layer_index, layers))
    full_names = {}
    for name, param in unet.named_parameters():
        if ".attn1." in name:
            full_names[name] = param
            full_names[f"unet.{name}"] = param

    wanted = {id(p) for layer in layers for p in layer.parameters()}
    loaded, skipped = set(), 0
    with torch.no_grad():
        for f in files:
            with safe_open(str(f), framework="pt") as fh:
                for key in fh.keys():
                    head, _, rest = key.partition(".")
                    param = None
                    if head.isdigit() and int(head) in by_index:
                        try:
                            param = by_index[int(head)].get_parameter(rest)
                        except AttributeError:
                            param = None
                    if param is None:
                        param = full_names.get(key)
                    if param is None:
                        skipped += 1  # alias of a child module, or unrelated
                        continue
                    tensor = fh.get_tensor(key)
                    if tensor.shape != param.shape:
                        raise RuntimeError(
                            f"Shape mismatch for {key}: {tuple(tensor.shape)} "
                            f"vs {tuple(param.shape)}")
                    # Fresh storage rather than copy_(): the UNet's own weights
                    # may be memory-mapped from disk.
                    param.data = tensor.to(param.dtype)
                    loaded.add(id(param))
    missing = len(wanted - loaded)
    if missing:
        sample = [k for _, k in keys[:3]]
        raise RuntimeError(
            f"CatVTON checkpoint left {missing} of {len(wanted)} attention "
            f"parameters unset ({len(layer_index)} indexed layers found, "
            f"{skipped} keys skipped, e.g. {sample}). Model files may not "
            f"match this worker.")
    log(f"Loaded CatVTON attention weights: {len(layers)} layers, "
        f"{len(loaded)} tensors")


_ST_SIZES = {"F64": 8, "F32": 4, "F16": 2, "BF16": 2, "I64": 8, "I32": 4,
             "I16": 2, "I8": 1, "U8": 1, "BOOL": 1}


_TORCH_TO_ST = {"float64": "F64", "float32": "F32", "float16": "F16",
                "bfloat16": "BF16", "int64": "I64", "int32": "I32",
                "int16": "I16", "int8": "I8", "uint8": "U8", "bool": "BOOL"}


def _write_bf16_safetensors(entries, get_tensor, dst: Path) -> None:
    """Streams tensors into a safetensors file, floats as bfloat16.
    `entries` is [(key, shape, safetensors dtype)]; get_tensor(key) loads one."""
    import struct

    import torch

    header, offset = {}, 0
    for key, shape, dtype in entries:
        out = "BF16" if dtype in ("F64", "F32", "F16", "BF16") else dtype
        n = 1
        for d in shape:
            n *= d
        size = n * _ST_SIZES[out]
        header[key] = {"dtype": out, "shape": list(shape),
                       "data_offsets": [offset, offset + size]}
        offset += size
    raw = json.dumps(header, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 8)
    tmp = dst.with_name(dst.name + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(struct.pack("<Q", len(raw)))
        fh.write(raw)
        for key, _, _ in entries:
            t = get_tensor(key)
            if header[key]["dtype"] == "BF16":
                t = t.to(torch.bfloat16)
            fh.write(t.contiguous().view(torch.uint8).numpy().tobytes())
            del t
    os.replace(tmp, dst)


def convert_safetensors_bf16(src: Path, dst: Path) -> None:
    """Rewrites a safetensors file with float tensors in bfloat16, streaming
    one tensor at a time (memory use = one tensor, not the whole model)."""
    from safetensors import safe_open

    with safe_open(str(src), framework="pt") as f:
        entries = []
        for key in f.keys():
            sl = f.get_slice(key)
            entries.append((key, sl.get_shape(), sl.get_dtype()))
        _write_bf16_safetensors(entries, f.get_tensor, dst)


def convert_bin_bf16(src: Path, dst: Path) -> None:
    """Same for a PyTorch .bin checkpoint. mmap=True keeps the original on
    disk instead of reading all of it into RAM."""
    import torch

    try:
        state = torch.load(str(src), map_location="cpu", mmap=True,
                           weights_only=True)
    except Exception as e:  # legacy (non-zip) format can't be mmapped
        log(f"Could not memory-map {src.name} ({e}); loading it fully")
        state = torch.load(str(src), map_location="cpu", weights_only=True)
    entries = [(k, tuple(v.shape), _TORCH_TO_ST[str(v.dtype).replace("torch.", "")])
               for k, v in state.items()]
    _write_bf16_safetensors(entries, state.__getitem__, dst)
    del state


def ensure_bf16_unet(models: Path) -> None:
    """Makes sure a bfloat16 copy of the UNet exists and drops the original.

    Loading weights stored in the same precision the model runs in lets
    PyTorch use the memory-mapped file directly: the 1.7 GB of weights become
    reclaimable page cache instead of locked RAM (peak ~1.2 GB vs ~2.8 GB)."""
    unet = models / "sd-inpainting" / "unet"
    target = unet / "diffusion_pytorch_model.bf16.safetensors"
    if target.exists():
        return
    for name in ("diffusion_pytorch_model.fp16.safetensors",
                 "diffusion_pytorch_model.safetensors",
                 "diffusion_pytorch_model.fp16.bin",
                 "diffusion_pytorch_model.bin"):
        src = unet / name
        if src.exists():
            log(f"Optimizing model weights for low memory (one time): {name} "
                f"({src.stat().st_size // 2**20} MB)")
            mem_report("before optimizing")
            if name.endswith(".bin"):
                convert_bin_bf16(src, target)
            else:
                convert_safetensors_bf16(src, target)
            src.unlink()
            release_memory()
            mem_report("after optimizing")
            return
    log(f"No UNet weights found to optimize in {unet}: "
        f"{sorted(p.name for p in unet.iterdir()) if unet.exists() else 'missing'}")


def unet_variant(base: Path) -> str | None:
    """Which UNet weight file to load: a dtype-matched copy if present."""
    for v in ("bf16", "fp16"):
        if (base / "unet" / f"diffusion_pytorch_model.{v}.safetensors").exists():
            return v
    return None

class TryOnPipeline:
    def __init__(self, unet, vae, scheduler, device, dtype, vae_dtype):
        self.unet, self.vae, self.scheduler = unet, vae, scheduler
        self.device, self.dtype, self.vae_dtype = device, dtype, vae_dtype

    @classmethod
    def load(cls, models: Path) -> "TryOnPipeline":
        import torch
        from diffusers import AutoencoderKL, DDIMScheduler, UNet2DConditionModel

        device = pick_device()
        dtype = pick_dtype(device)
        # On CPU the VAE follows TRYON_VAE_DTYPE (default: same as the UNet,
        # saving ~170 MB in bf16).
        vae_name = os.environ.get("TRYON_VAE_DTYPE")
        vae_dtype = {"float32": torch.float32, "bfloat16": torch.bfloat16}.get(
            vae_name or "", dtype)
        base = models / "sd-inpainting"
        if dtype == torch.bfloat16:
            ensure_bf16_unet(models)
        variant = unet_variant(base)
        files = sorted(f"{p.name} ({p.stat().st_size // 2**20} MB)"
                       for p in (base / "unet").glob("diffusion_pytorch_model*"))
        log(f"Loading models on {device} ({str(dtype).replace('torch.', '')}), "
            f"UNet variant {variant or 'default'}: {', '.join(files)}")
        mem_report("before loading UNet")
        # With a dtype-matched safetensors file diffusers maps it from disk:
        # the weights are reclaimable page cache rather than process memory.
        unet = UNet2DConditionModel.from_pretrained(
            base, subfolder="unet", torch_dtype=dtype, variant=variant,
            low_cpu_mem_usage=True)
        release_memory()
        mem_report("after loading UNet")
        patch_unet(unet)
        load_attention_weights(unet, models / "catvton" / CATVTON_VERSION / "attention")
        vae = AutoencoderKL.from_pretrained(models / "sd-vae-ft-mse",
                                            torch_dtype=vae_dtype)
        scheduler = DDIMScheduler.from_pretrained(base, subfolder="scheduler")
        unet.to(device).eval()
        vae.to(device).eval()
        mem_report("models loaded")
        return cls(unet, vae, scheduler, device, dtype, vae_dtype)

    def _encode(self, x, generator):
        import torch

        with torch.no_grad():
            dist = self.vae.encode(x.to(self.device, self.vae_dtype)).latent_dist
            latent = dist.sample(generator) * self.vae.config.scaling_factor
        return latent.to(self.dtype)

    def __call__(self, person, garment, mask, steps=30, guidance=2.5, seed=42,
                 on_step=None):
        """person / garment: PIL RGB of equal size; mask: PIL L (white =
        replace). Returns a PIL RGB image."""
        import numpy as np
        import torch
        import torch.nn.functional as F
        from PIL import Image, ImageFilter

        w, h = person.size
        to_t = lambda im: torch.from_numpy(  # noqa: E731
            np.asarray(im, dtype=np.float32) / 127.5 - 1.0).permute(2, 0, 1)[None]
        image = to_t(person)
        cond = to_t(garment)
        m = torch.from_numpy((np.asarray(mask, dtype=np.float32) / 255.0 > 0.5)
                             .astype(np.float32))[None, None]
        masked_image = image * (m < 0.5)

        gen = torch.Generator(device="cpu").manual_seed(int(seed))
        masked_latent = self._encode(masked_image, gen)
        cond_latent = self._encode(cond, gen)
        mask_latent = F.interpolate(m, size=masked_latent.shape[-2:],
                                    mode="nearest").to(self.device, self.dtype)

        masked_concat = torch.cat([masked_latent, cond_latent], dim=CONCAT_DIM)
        mask_concat = torch.cat([mask_latent, torch.zeros_like(mask_latent)],
                                dim=CONCAT_DIM)
        latents = torch.randn(masked_concat.shape, generator=gen,
                              dtype=torch.float32).to(self.device, self.dtype)
        self.scheduler.set_timesteps(steps, device=self.device)
        latents = latents * self.scheduler.init_noise_sigma

        do_cfg = guidance > 1.0
        if do_cfg:
            uncond = torch.cat([masked_latent, torch.zeros_like(cond_latent)],
                               dim=CONCAT_DIM)
            masked_concat = torch.cat([uncond, masked_concat])
            mask_concat = torch.cat([mask_concat] * 2)

        timesteps = self.scheduler.timesteps
        # On CPU run the unconditional and conditional halves one after the
        # other: same result, about half the attention memory.
        sequential = do_cfg and (self.device == "cpu"
                                 or os.environ.get("TRYON_LOW_MEM") == "1")
        with torch.no_grad():
            for i, t in enumerate(timesteps):
                inp = torch.cat([latents] * 2) if do_cfg else latents
                inp = self.scheduler.scale_model_input(inp, t)
                inp = torch.cat([inp, mask_concat, masked_concat], dim=1)
                tt = t.to(self.device)
                if sequential:
                    noise = torch.cat([
                        self.unet(part, tt, encoder_hidden_states=None,
                                  return_dict=False)[0]
                        for part in inp.chunk(2)])
                else:
                    noise = self.unet(inp, tt, encoder_hidden_states=None,
                                      return_dict=False)[0]
                if do_cfg:
                    n_uncond, n_cond = noise.chunk(2)
                    noise = n_uncond + guidance * (n_cond - n_uncond)
                latents = self.scheduler.step(noise, t, latents).prev_sample
                if i == 0:
                    mem_report("first render step")
                if on_step:
                    on_step(i + 1, len(timesteps))

            latents = latents.split(latents.shape[CONCAT_DIM] // 2,
                                    dim=CONCAT_DIM)[0]
            latents = latents.to(self.vae_dtype) / self.vae.config.scaling_factor
            out = self.vae.decode(latents).sample

        out = ((out[0].float().clamp(-1, 1) + 1) * 127.5).permute(1, 2, 0)
        result = Image.fromarray(out.round().byte().cpu().numpy(), "RGB")
        if result.size != (w, h):
            result = result.resize((w, h), Image.LANCZOS)
        # Keep everything outside the (softened) mask from the original photo.
        soft = mask.filter(ImageFilter.GaussianBlur(max(2, w // 128)))
        return Image.composite(result, person, soft)


# ---------------------------------------------------------------------------
# Automatic mask
# ---------------------------------------------------------------------------


def build_mask(models: Path, person, category: str):
    """Clothes mask for `category` via SegFormer; falls back to a box."""
    import numpy as np
    import torch
    from PIL import Image, ImageDraw, ImageFilter
    from transformers import AutoModelForSemanticSegmentation, SegformerImageProcessor

    seg_dir = models / "segformer"
    processor = SegformerImageProcessor.from_pretrained(seg_dir)
    model = AutoModelForSemanticSegmentation.from_pretrained(seg_dir).eval()
    with torch.no_grad():
        inputs = processor(images=person, return_tensors="pt")
        logits = model(**inputs).logits
        logits = torch.nn.functional.interpolate(
            logits, size=person.size[::-1], mode="bilinear", align_corners=False)
        labels = logits.argmax(dim=1)[0].numpy()
    del model, logits, inputs
    release_memory()

    keep = [LBL[n] for n in MASK_LABELS[category]]
    region = np.isin(labels, keep)
    w, h = person.size
    if region.sum() < 0.01 * w * h:
        log("No clothing detected; using a default mask area")
        mask = Image.new("L", (w, h), 0)
        x0, y0, x1, y1 = FALLBACK_BOX[category]
        ImageDraw.Draw(mask).rectangle([x0 * w, y0 * h, x1 * w, y1 * h], fill=255)
        return mask
    # Never repaint the face / hair.
    protect = np.isin(labels, [LBL["face"], LBL["hair"]])
    mask = Image.fromarray((region * 255).astype(np.uint8), "L")
    size = max(3, (w // 40) | 1)  # odd kernel, ~2.5% of width
    mask = mask.filter(ImageFilter.MaxFilter(size))
    arr = np.asarray(mask).copy()
    arr[protect] = 0
    return Image.fromarray(arr, "L")


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

_pipeline_cache: dict[str, TryOnPipeline] = {}


def try_on(models: Path, person, garment, category: str, steps: int,
           guidance: float, seed: int, keep_loaded: bool = False,
           on_step=None):
    from PIL import Image

    if category not in MASK_LABELS:
        raise ValueError(f"Unsupported category {category!r}")
    mem_report("start")
    person = person.convert("RGB")
    garment = garment.convert("RGB")
    if garment.size != person.size:
        garment = garment.resize(person.size, Image.LANCZOS)
    log_progress("mask", 0, 1)
    mask = build_mask(models, person, category)
    log_progress("mask", 1, 1)
    mem_report("after finding clothes")

    pipe = _pipeline_cache.get(str(models)) if keep_loaded else None
    if pipe is None:
        log_progress("load", 0, 1)
        pipe = TryOnPipeline.load(models)
        log_progress("load", 1, 1)
        if keep_loaded:
            _pipeline_cache[str(models)] = pipe
    try:
        return pipe(person, garment, mask, steps=steps, guidance=guidance,
                    seed=seed, on_step=on_step)
    finally:
        if not keep_loaded:
            del pipe
            release_memory()


def cmd_run(args) -> None:
    from PIL import Image

    job = json.loads(Path(args.job).read_text())
    if job.get("threads"):
        import torch
        torch.set_num_threads(int(job["threads"]))
    result = try_on(
        Path(args.models),
        Image.open(job["person"]),
        Image.open(job["garment"]),
        job["category"],
        int(job.get("steps", 30)),
        float(job.get("guidance", 2.5)),
        int(job.get("seed", 42)),
        on_step=lambda i, n: log_progress("render", i, n),
    )
    result.save(job["output"], "PNG")
    print(f"DONE {job['output']}", flush=True)


# ---------------------------------------------------------------------------
# HTTP server (remote rendering on another machine)
# ---------------------------------------------------------------------------


def cmd_serve(args) -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from PIL import Image

    models = Path(args.models)
    lock = threading.Lock()
    state = {"busy": False, "step": None}
    max_body = 50 * 1024 * 1024

    class Handler(BaseHTTPRequestHandler):
        def _json(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            if not args.token:
                return True
            return self.headers.get("X-Tryon-Token") == args.token

        def log_message(self, fmt, *a):  # quieter logs
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % a))

        def do_GET(self):
            if self.path != "/health":
                return self._json(404, {"error": "not found"})
            if not self._authorized():
                return self._json(401, {"error": "bad token"})
            import torch
            dev = pick_device()
            self._json(200, {"ok": True, "device": dev, "busy": state["busy"],
                             "step": state["step"], "torch": torch.__version__})

        def do_POST(self):
            if self.path != "/tryon":
                return self._json(404, {"error": "not found"})
            if not self._authorized():
                return self._json(401, {"error": "bad token"})
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > max_body:
                return self._json(413, {"error": "bad request size"})
            try:
                req = json.loads(self.rfile.read(length))
                person = Image.open(io.BytesIO(base64.b64decode(req["person"])))
                garment = Image.open(io.BytesIO(base64.b64decode(req["garment"])))
            except Exception as e:
                return self._json(400, {"error": f"bad request: {e}"})
            with lock:
                state["busy"] = True
                try:
                    started = time.time()
                    result = try_on(
                        models, person, garment, req["category"],
                        int(req.get("steps", 30)), float(req.get("guidance", 2.5)),
                        int(req.get("seed", 42)), keep_loaded=not args.unload,
                        on_step=lambda i, n: state.__setitem__("step", f"{i}/{n}"))
                    buf = io.BytesIO()
                    result.save(buf, "PNG")
                    self._json(200, {
                        "image": base64.b64encode(buf.getvalue()).decode(),
                        "seconds": round(time.time() - started, 1)})
                except ValueError as e:
                    self._json(400, {"error": str(e)})
                except Exception as e:
                    self._json(500, {"error": f"{type(e).__name__}: {e}"})
                finally:
                    state["busy"] = False
                    state["step"] = None

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Try-on worker listening on http://{args.host}:{args.port} "
          f"(device {pick_device()})", flush=True)
    server.serve_forever()


# ---------------------------------------------------------------------------
# Self test with tiny random models (no downloads)
# ---------------------------------------------------------------------------


def make_tiny_models(models: Path) -> None:
    """Writes randomly initialised miniature versions of every model, in the
    same layout `download` produces. Used for testing the plumbing only."""
    import torch
    from diffusers import AutoencoderKL, DDIMScheduler, UNet2DConditionModel
    from safetensors.torch import save_file
    from transformers import SegformerConfig, SegformerForSemanticSegmentation
    from transformers import SegformerImageProcessor

    torch.manual_seed(0)
    unet = UNet2DConditionModel(
        sample_size=8, in_channels=9, out_channels=4, layers_per_block=1,
        block_out_channels=(32, 64), down_block_types=("CrossAttnDownBlock2D", "DownBlock2D"),
        up_block_types=("UpBlock2D", "CrossAttnUpBlock2D"), cross_attention_dim=32,
        attention_head_dim=8, norm_num_groups=8)
    unet.save_pretrained(models / "sd-inpainting" / "unet")
    DDIMScheduler(beta_schedule="scaled_linear", clip_sample=False,
                  set_alpha_to_one=False).save_pretrained(
        models / "sd-inpainting" / "scheduler")
    # Attention checkpoint laid out like CatVTON's real file: each layer at
    # index 8*j (its module list also holds 7 child/processor entries per
    # layer, which safetensors de-duplicates away), e.g. "104.to_k.weight".
    state = {}
    for j, layer in enumerate(self_attention_layers(unet)):
        for name, param in layer.named_parameters():
            state[f"{8 * j}.{name}"] = param.detach().clone().contiguous()
    att = models / "catvton" / CATVTON_VERSION / "attention"
    att.mkdir(parents=True, exist_ok=True)
    save_file(state, str(att / "model.safetensors"))
    # Four blocks = 8x downsampling, like the real SD VAE.
    AutoencoderKL(block_out_channels=(8, 16, 16, 16), layers_per_block=1,
                  down_block_types=("DownEncoderBlock2D",) * 4,
                  up_block_types=("UpDecoderBlock2D",) * 4, latent_channels=4,
                  norm_num_groups=8).save_pretrained(models / "sd-vae-ft-mse")
    cfg = SegformerConfig(num_labels=18, hidden_sizes=[8, 16, 32, 64],
                          decoder_hidden_size=32, num_attention_heads=[1, 1, 2, 2],
                          depths=[1, 1, 1, 1])
    SegformerForSemanticSegmentation(cfg).save_pretrained(models / "segformer")
    SegformerImageProcessor(size={"height": 64, "width": 48}).save_pretrained(
        models / "segformer")


def cmd_selftest(args) -> None:
    import tempfile
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmp:
        models = Path(args.models) if args.models else Path(tmp) / "models"
        if not (models / "segformer").exists():
            make_tiny_models(models)
        check(models)
        person = Image.new("RGB", (48, 64), (200, 180, 160))
        garment = Image.new("RGB", (48, 64), (30, 60, 170))
        for cat in ("upper", "lower", "overall"):
            out = try_on(models, person, garment, cat, steps=2, guidance=2.5,
                         seed=1, on_step=lambda i, n: log_progress("render", i, n))
            assert out.size == person.size, out.size
        print("SELFTEST OK", flush=True)


# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("download", "check", "run", "serve", "selftest", "tiny"):
        p = sub.add_parser(name)
        p.add_argument("--models", required=name not in ("selftest",))
        if name == "run":
            p.add_argument("--job", required=True)
        if name == "serve":
            p.add_argument("--host", default="0.0.0.0")
            p.add_argument("--port", type=int, default=8188)
            p.add_argument("--token", default=os.environ.get("TRYON_TOKEN"))
            p.add_argument("--unload", action="store_true",
                           help="free the model after every job (saves RAM)")
    args = parser.parse_args()

    if os.environ.get("TRYON_NICE"):
        try:
            os.nice(int(os.environ["TRYON_NICE"]))
        except OSError:
            pass
    try:
        if args.cmd == "download":
            download(Path(args.models))
        elif args.cmd == "check":
            check(Path(args.models))
            print("CHECK OK", flush=True)
        elif args.cmd == "run":
            cmd_run(args)
        elif args.cmd == "serve":
            cmd_serve(args)
        elif args.cmd == "selftest":
            cmd_selftest(args)
        elif args.cmd == "tiny":
            make_tiny_models(Path(args.models))
            print("TINY OK", flush=True)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        print(f"ERROR {type(e).__name__}: {e}", flush=True)
        if os.environ.get("TRYON_DEBUG"):
            raise
        sys.exit(1)


if __name__ == "__main__":
    main()
