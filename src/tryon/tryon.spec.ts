import { zipSync } from 'fflate';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractUvBinary,
  pickUvWheel,
  TryOnInstallerService,
} from './tryon-installer.service';
import { parseWorkerLine, planPasses, tryOnCategory } from './tryon-plan.util';
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  TryOnSettingsService,
} from './tryon-settings.service';

describe('tryOnCategory', () => {
  it.each([
    ['tops', 'upper'],
    ['T-Shirt', 'upper'],
    ['Hoodies', 'upper'],
    ['outerwear', 'upper'],
    ['winter coat', 'upper'],
    ['bottoms', 'lower'],
    ['Jeans', 'lower'],
    ['skirts', 'lower'],
    ['dresses', 'overall'],
    ['Jumpsuit', 'overall'],
    ['footwear', null],
    ['accessories', null],
    ['bags', null],
    ['other', null],
  ])('%s -> %s', (category, expected) => {
    expect(tryOnCategory(category)).toBe(expected);
  });
});

describe('planPasses', () => {
  it('orders dress, bottoms, tops, then outer layers, and skips shoes', () => {
    const { passes, skipped } = planPasses([
      { id: 1, category: 'outerwear' },
      { id: 2, category: 'tops' },
      { id: 3, category: 'footwear' },
      { id: 4, category: 'bottoms' },
      { id: 5, category: 'dresses' },
    ]);
    expect(passes).toEqual([
      { garmentId: 5, category: 'overall' },
      { garmentId: 4, category: 'lower' },
      { garmentId: 2, category: 'upper' },
      { garmentId: 1, category: 'upper' },
    ]);
    expect(skipped).toEqual([{ id: 3, category: 'footwear' }]);
  });

  it('keeps the given order within the same layer', () => {
    const { passes } = planPasses([
      { id: 9, category: 'shirt' },
      { id: 8, category: 'tee' },
    ]);
    expect(passes.map((p) => p.garmentId)).toEqual([9, 8]);
  });
});

describe('parseWorkerLine', () => {
  it('parses the worker protocol', () => {
    expect(parseWorkerLine('PROGRESS render 3 30')).toEqual({
      type: 'progress',
      stage: 'render',
      current: 3,
      total: 30,
    });
    expect(parseWorkerLine('DONE /tmp/out.png')).toEqual({
      type: 'done',
      path: '/tmp/out.png',
    });
    expect(parseWorkerLine('ERROR RuntimeError: boom')).toEqual({
      type: 'error',
      message: 'RuntimeError: boom',
    });
    expect(parseWorkerLine('LOG Loading models on cpu')).toEqual({
      type: 'log',
      message: 'Loading models on cpu',
    });
  });

  it('ignores unrelated output', () => {
    expect(parseWorkerLine('UserWarning: something')).toBeNull();
    expect(parseWorkerLine('')).toBeNull();
  });
});

describe('sanitizeSettings', () => {
  it('fills defaults', () => {
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ precision: 'float32' }).precision).toBe(
      'float32',
    );
    expect(sanitizeSettings({ precision: 'int4' }).precision).toBe('bfloat16');
  });

  it('normalizes the remote URL', () => {
    expect(
      sanitizeSettings({ remoteUrl: '192.168.1.20:8188/' }).remoteUrl,
    ).toBe('http://192.168.1.20:8188');
    expect(
      sanitizeSettings({ remoteUrl: 'https://gpu.local/tryon/' }).remoteUrl,
    ).toBe('https://gpu.local/tryon');
    expect(sanitizeSettings({ remoteUrl: 'http://' }).remoteUrl).toBe('');
  });

  it('clamps numbers and rejects unknown sizes and modes', () => {
    const s = sanitizeSettings({
      mode: 'cloud',
      steps: '500',
      guidance: '-3',
      width: 1000,
      height: 1000,
      threads: 'abc',
    });
    expect(s.mode).toBe('local');
    expect(s.steps).toBe(100);
    expect(s.guidance).toBe(1);
    expect([s.width, s.height]).toEqual([384, 512]);
    expect(s.threads).toBe(0);
    expect(sanitizeSettings({ width: 576, height: 768 })).toMatchObject({
      width: 576,
      height: 768,
    });
  });
});

describe('TryOnSettingsService', () => {
  let dir: string;
  let service: TryOnSettingsService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tryon-'));
    service = new TryOnSettingsService({
      get: (k: string) => (k === 'TRYON_DIR' ? dir : undefined),
      getOrThrow: () => dir,
    } as any);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persists settings and merges partial updates', () => {
    expect(service.get().mode).toBe('local');
    service.save({ mode: 'remote', remoteUrl: 'pc:8188' });
    service.save({ steps: 20 });
    expect(service.get()).toMatchObject({
      mode: 'remote',
      remoteUrl: 'http://pc:8188',
      steps: 20,
    });
  });

  it('falls back to defaults on a corrupt settings file', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{nope');
    expect(service.get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('installer helpers', () => {
  const files = [
    { filename: 'uv-0.5.11.tar.gz', url: 'a', digests: { sha256: '' } },
    {
      filename:
        'uv-0.5.11-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.whl',
      url: 'arm',
      digests: { sha256: '' },
    },
    {
      filename:
        'uv-0.5.11-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
      url: 'x86',
      digests: { sha256: '' },
    },
    {
      filename: 'uv-0.5.11-py3-none-win_amd64.whl',
      url: 'win',
      digests: { sha256: '' },
    },
  ];

  it('picks the wheel for the CPU architecture', () => {
    expect(pickUvWheel(files, 'x64').url).toBe('x86');
    expect(pickUvWheel(files, 'arm64').url).toBe('arm');
    expect(() => pickUvWheel(files, 'ia32')).toThrow('Unsupported');
  });

  it('extracts the uv binary from a wheel', () => {
    const wheel = zipSync({
      'uv-0.5.11.dist-info/METADATA': new TextEncoder().encode('meta'),
      'uv-0.5.11.data/scripts/uv': new TextEncoder().encode('BINARY'),
    });
    expect(new TextDecoder().decode(extractUvBinary(wheel))).toBe('BINARY');
    expect(() =>
      extractUvBinary(zipSync({ 'x.txt': new Uint8Array(1) })),
    ).toThrow('not found');
  });

  it('reports install state and uninstalls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tryon-'));
    try {
      const settings = new TryOnSettingsService({
        get: () => dir,
        getOrThrow: () => dir,
      } as any);
      const installer = new TryOnInstallerService(settings);
      expect(installer.state().status).toBe('not_installed');

      const p = settings.paths;
      fs.mkdirSync(path.dirname(p.python), { recursive: true });
      fs.writeFileSync(p.python, '');
      fs.mkdirSync(p.models, { recursive: true });
      fs.writeFileSync(
        p.installed,
        JSON.stringify({ installedAt: '2026-01-01' }),
      );
      expect(installer.state()).toMatchObject({
        status: 'installed',
        installedAt: '2026-01-01',
      });

      installer.uninstall();
      expect(installer.state().status).toBe('not_installed');
      expect(fs.existsSync(p.models)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
