import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { unzipSync } from 'fflate';
import * as fs from 'fs';
import { TryOnSettingsService } from './tryon-settings.service';

/** Pinned so installs are reproducible. */
export const UV_VERSION = '0.5.11';
export const PYTHON_VERSION = '3.11';
export const TORCH_SPEC = 'torch==2.5.1';
export const TORCH_INDEX = 'https://download.pytorch.org/whl/cpu';
export const PY_PACKAGES = [
  'diffusers==0.31.0',
  'transformers==4.46.3',
  'accelerate==1.1.1',
  'huggingface-hub==0.26.5',
  'safetensors==0.4.5',
  'pillow==11.0.0',
  'numpy==2.1.3',
];
/** Rough disk needed for runtime + models. */
export const REQUIRED_BYTES = 7 * 1024 ** 3;

export const INSTALL_STEPS = [
  'Download installer (uv)',
  'Download Python',
  'Install PyTorch (CPU)',
  'Install diffusion libraries',
  'Download models (~3 GB)',
  'Verify installation',
] as const;

export type InstallStatus =
  | 'not_installed'
  | 'installing'
  | 'installed'
  | 'failed';

export interface InstallState {
  status: InstallStatus;
  step: number;
  steps: readonly string[];
  error?: string;
  log: string[];
  freeBytes?: number;
  requiredBytes: number;
  installedAt?: string;
  /** Model weight files on disk, for diagnosing memory problems. */
  modelFiles: { path: string; mb: number }[];
}

interface PypiFile {
  filename: string;
  url: string;
  digests: { sha256: string };
}

/** Picks the uv wheel matching this machine from PyPI's JSON listing. */
export function pickUvWheel(
  files: PypiFile[],
  arch: string = process.arch,
): PypiFile {
  const tag = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  if (!tag) throw new Error(`Unsupported CPU architecture: ${arch}`);
  const wheel = files.find(
    (f) =>
      f.filename.endsWith('.whl') &&
      f.filename.includes('manylinux') &&
      f.filename.includes(tag),
  );
  if (!wheel) throw new Error(`No uv build for ${tag} on PyPI`);
  return wheel;
}

/** Extracts the uv executable from a wheel (zip) archive. */
export function extractUvBinary(wheel: Uint8Array): Uint8Array {
  const files = unzipSync(wheel, {
    filter: (f) => /\.data\/scripts\/uv$/.test(f.name),
  });
  const entry = Object.values(files)[0];
  if (!entry) throw new Error('uv binary not found in wheel');
  return entry;
}

/**
 * Installs the local try-on runtime on demand (Python, PyTorch CPU, diffusers,
 * model weights) into TRYON_DIR, so the Docker image itself stays small.
 */
@Injectable()
export class TryOnInstallerService implements OnModuleDestroy {
  private readonly logger = new Logger(TryOnInstallerService.name);
  private running = false;
  private step = 0;
  private error?: string;
  private child?: ChildProcess;

  constructor(private readonly settings: TryOnSettingsService) {}

  onModuleDestroy() {
    this.child?.kill('SIGTERM');
  }

  isInstalled(): boolean {
    const p = this.settings.paths;
    return fs.existsSync(p.installed) && fs.existsSync(p.python);
  }

  state(): InstallState {
    const p = this.settings.paths;
    let installedAt: string | undefined;
    try {
      installedAt = JSON.parse(
        fs.readFileSync(p.installed, 'utf8'),
      ).installedAt;
    } catch {
      /* not installed */
    }
    return {
      status: this.running
        ? 'installing'
        : this.isInstalled()
          ? 'installed'
          : this.error
            ? 'failed'
            : 'not_installed',
      step: this.step,
      steps: INSTALL_STEPS,
      error: this.error,
      log: this.tailLog(40),
      freeBytes: this.freeBytes(),
      requiredBytes: REQUIRED_BYTES,
      installedAt,
      modelFiles: this.modelFiles(),
    };
  }

  /** Starts the install in the background. Returns false if already busy. */
  start(): boolean {
    if (this.running) return false;
    this.running = true;
    this.error = undefined;
    this.step = 0;
    void this.install()
      .catch((err: Error) => {
        this.error = err.message;
        this.appendLog(`\nERROR: ${err.message}\n`);
        this.logger.error(`Try-on install failed: ${err.message}`);
      })
      .finally(() => {
        this.running = false;
        this.child = undefined;
      });
    return true;
  }

  /** Removes the runtime and models; keeps settings and past results. */
  uninstall(): void {
    if (this.running) throw new Error('Installation in progress');
    const p = this.settings.paths;
    for (const target of [
      p.venv,
      p.pythonInstalls,
      p.models,
      p.bin,
      p.cache,
      p.work,
    ]) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.rmSync(p.installed, { force: true });
    this.error = undefined;
    this.appendLog(
      `\nRemoved try-on runtime and models (${new Date().toISOString()})\n`,
    );
  }

  private async install(): Promise<void> {
    const p = this.settings.paths;
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(
      p.installLog,
      `Try-on install started ${new Date().toISOString()}\n`,
    );
    fs.rmSync(p.installed, { force: true });

    const free = this.freeBytes();
    if (free != null && free < REQUIRED_BYTES) {
      throw new Error(
        `Not enough disk space: ${(free / 1024 ** 3).toFixed(1)} GB free, ` +
          `about ${(REQUIRED_BYTES / 1024 ** 3).toFixed(0)} GB needed`,
      );
    }

    const env = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: p.pythonInstalls,
      UV_CACHE_DIR: p.cache,
      UV_LINK_MODE: 'copy',
      UV_NO_PROGRESS: '1',
      HF_HOME: `${p.cache}/hf`,
      HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
      PYTHONUNBUFFERED: '1',
    };

    // 1. uv (single static binary, from PyPI)
    this.begin(0);
    await this.downloadUv();

    // 2. Python (managed by uv) + virtual environment
    this.begin(1);
    await this.run(p.uv, ['python', 'install', PYTHON_VERSION], env);
    await this.run(
      p.uv,
      [
        'venv',
        '--python',
        PYTHON_VERSION,
        '--python-preference',
        'only-managed',
        '--allow-existing',
        p.venv,
      ],
      env,
    );

    // 3. PyTorch CPU build (~200 MB instead of multiple GB of CUDA libraries)
    this.begin(2);
    await this.run(
      p.uv,
      [
        'pip',
        'install',
        '--python',
        p.python,
        '--index-url',
        TORCH_INDEX,
        TORCH_SPEC,
      ],
      env,
    );

    // 4. Everything else
    this.begin(3);
    await this.run(
      p.uv,
      ['pip', 'install', '--python', p.python, ...PY_PACKAGES],
      env,
    );

    // 5. Model weights
    this.begin(4);
    await this.run(p.python, [p.worker, 'download', '--models', p.models], env);

    // 6. Sanity check
    this.begin(5);
    await this.run(p.python, [p.worker, 'check', '--models', p.models], env);

    fs.rmSync(p.cache, { recursive: true, force: true });
    fs.writeFileSync(
      p.installed,
      JSON.stringify(
        {
          installedAt: new Date().toISOString(),
          uv: UV_VERSION,
          python: PYTHON_VERSION,
          torch: TORCH_SPEC,
          packages: PY_PACKAGES,
        },
        null,
        2,
      ),
    );
    this.step = INSTALL_STEPS.length;
    this.appendLog(`\nInstallation complete ${new Date().toISOString()}\n`);
    this.logger.log('Try-on runtime installed');
  }

  private begin(step: number) {
    this.step = step;
    this.appendLog(`\n== ${INSTALL_STEPS[step]} ==\n`);
  }

  private async downloadUv(): Promise<void> {
    const p = this.settings.paths;
    const meta = await fetch(`https://pypi.org/pypi/uv/${UV_VERSION}/json`);
    if (!meta.ok) throw new Error(`PyPI returned ${meta.status} for uv`);
    const { urls } = (await meta.json()) as { urls: PypiFile[] };
    const wheel = pickUvWheel(urls);
    this.appendLog(`Downloading ${wheel.filename}\n`);
    const res = await fetch(wheel.url);
    if (!res.ok)
      throw new Error(`Download of ${wheel.filename} failed: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== wheel.digests.sha256) {
      throw new Error(`Checksum mismatch for ${wheel.filename}`);
    }
    fs.mkdirSync(p.bin, { recursive: true });
    fs.writeFileSync(p.uv, extractUvBinary(bytes), { mode: 0o755 });
    this.appendLog(`uv ${UV_VERSION} ready\n`);
  }

  private run(
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    this.appendLog(`$ ${[cmd, ...args].join(' ')}\n`);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      const out = (d: Buffer) => this.appendLog(d.toString());
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `${cmd.split('/').pop()} ${args[0]} exited with code ${code}`,
              ),
            ),
      );
    });
  }

  private appendLog(text: string) {
    try {
      fs.mkdirSync(this.settings.paths.dir, { recursive: true });
      fs.appendFileSync(this.settings.paths.installLog, text);
    } catch (err) {
      this.logger.warn(
        `Could not write install log: ${(err as Error).message}`,
      );
    }
  }

  private tailLog(lines: number): string[] {
    try {
      const text = fs.readFileSync(this.settings.paths.installLog, 'utf8');
      // Progress bars use \r; keep the last state of each line.
      return text
        .split('\n')
        .map((l) => l.split('\r').pop() ?? '')
        .filter((l) => l.trim())
        .slice(-lines);
    } catch {
      return [];
    }
  }

  private modelFiles(): { path: string; mb: number }[] {
    const root = this.settings.paths.models;
    const out: { path: string; mb: number }[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full, depth + 1);
        else if (/\.(safetensors|bin)$/.test(e.name)) {
          out.push({
            path: full.slice(root.length + 1),
            mb: Math.round(fs.statSync(full).size / 1024 ** 2),
          });
        }
      }
    };
    walk(root, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private freeBytes(): number | undefined {
    try {
      const dir = this.settings.paths.dir;
      fs.mkdirSync(dir, { recursive: true });
      const s = fs.statfsSync(dir);
      return s.bavail * s.bsize;
    } catch {
      return undefined;
    }
  }
}
