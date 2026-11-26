import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

export type TryOnMode = 'local' | 'remote';

export interface TryOnSettings {
  /** local: render on this server; remote: send to another machine. */
  mode: TryOnMode;
  /** Base URL of a `worker.py serve` instance, e.g. http://192.168.1.20:8188 */
  remoteUrl: string;
  /** Optional shared secret sent as X-Tryon-Token. */
  remoteToken: string;
  /** Diffusion steps per pass (more = slower, slightly better). */
  steps: number;
  /** Classifier-free guidance scale. */
  guidance: number;
  /** Render size; 3:4 portrait. */
  width: number;
  height: number;
  /** CPU threads for local rendering; 0 = all but one core. */
  threads: number;
  /** Local precision: bfloat16 halves memory; float32 can be faster on CPUs
   * without native bf16 support but needs ~2 GB more RAM. */
  precision: 'bfloat16' | 'float32';
}

export const DEFAULT_SETTINGS: TryOnSettings = {
  mode: 'local',
  remoteUrl: '',
  remoteToken: '',
  steps: 30,
  guidance: 2.5,
  width: 384,
  height: 512,
  threads: 0,
  precision: 'bfloat16',
};

/** Allowed render sizes (width x height), all multiples of 8 and 3:4. */
export const SIZES: [number, number][] = [
  [288, 384],
  [384, 512],
  [576, 768],
  [768, 1024],
];

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

/** Validates and normalizes untrusted settings input. */
export function sanitizeSettings(
  input: Partial<Record<keyof TryOnSettings, unknown>>,
  base: TryOnSettings = DEFAULT_SETTINGS,
): TryOnSettings {
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const mode: TryOnMode =
    input.mode === 'remote' || input.mode === 'local' ? input.mode : base.mode;

  let remoteUrl =
    typeof input.remoteUrl === 'string'
      ? input.remoteUrl.trim()
      : base.remoteUrl;
  if (remoteUrl) {
    if (!/^https?:\/\//i.test(remoteUrl)) remoteUrl = `http://${remoteUrl}`;
    try {
      const u = new URL(remoteUrl);
      remoteUrl = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      remoteUrl = '';
    }
  }

  let width = Math.round(num(input.width, base.width));
  let height = Math.round(num(input.height, base.height));
  if (!SIZES.some(([w, h]) => w === width && h === height)) {
    [width, height] = [base.width, base.height];
  }

  return {
    mode,
    remoteUrl,
    remoteToken:
      typeof input.remoteToken === 'string'
        ? input.remoteToken.trim().slice(0, 200)
        : base.remoteToken,
    steps: clamp(Math.round(num(input.steps, base.steps)), 5, 100),
    guidance: clamp(num(input.guidance, base.guidance), 1, 10),
    width,
    height,
    threads: clamp(Math.round(num(input.threads, base.threads)), 0, 64),
    precision:
      input.precision === 'float32' || input.precision === 'bfloat16'
        ? input.precision
        : base.precision,
  };
}

/**
 * Instance-wide try-on settings and file locations. Everything lives under
 * TRYON_DIR (default: DATA_PATH/tryon) so it survives container rebuilds.
 */
@Injectable()
export class TryOnSettingsService {
  private readonly logger = new Logger(TryOnSettingsService.name);
  readonly dir: string;

  constructor(configService: ConfigService) {
    this.dir =
      configService.get<string>('TRYON_DIR') ||
      path.join(configService.getOrThrow<string>('DATA_PATH'), 'tryon');
  }

  get paths() {
    const venv = path.join(this.dir, 'venv');
    return {
      dir: this.dir,
      bin: path.join(this.dir, 'bin'),
      uv: path.join(this.dir, 'bin', 'uv'),
      python: path.join(venv, 'bin', 'python'),
      venv,
      pythonInstalls: path.join(this.dir, 'python'),
      cache: path.join(this.dir, 'cache'),
      models: path.join(this.dir, 'models'),
      work: path.join(this.dir, 'work'),
      installLog: path.join(this.dir, 'install.log'),
      installed: path.join(this.dir, 'installed.json'),
      settings: path.join(this.dir, 'settings.json'),
      /** Shipped with the app (copied into dist by nest-cli assets). */
      worker: path.join(__dirname, 'worker.py'),
    };
  }

  get(): TryOnSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.paths.settings, 'utf8'));
      return sanitizeSettings(raw);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  save(input: Partial<Record<keyof TryOnSettings, unknown>>): TryOnSettings {
    const settings = sanitizeSettings(input, this.get());
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.paths.settings, JSON.stringify(settings, null, 2));
    this.logger.log(`Try-on settings saved (mode=${settings.mode})`);
    return settings;
  }
}
