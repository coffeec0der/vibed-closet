import sharp from 'sharp';
import { GarmentColor } from './garment-color.enum';

/**
 * Reference swatches for each detectable garment color (sRGB). Several
 * swatches per color widen the match area (e.g. navy and sky are both blue).
 * PATTERN / OTHER / GOLD / SILVER are never auto-detected.
 */
const SWATCHES: [GarmentColor, [number, number, number]][] = [
  [GarmentColor.RED, [200, 30, 40]],
  [GarmentColor.RED, [130, 20, 30]],
  [GarmentColor.PINK, [240, 150, 180]],
  [GarmentColor.PINK, [220, 80, 140]],
  [GarmentColor.ORANGE, [240, 130, 30]],
  [GarmentColor.YELLOW, [245, 215, 50]],
  [GarmentColor.GREEN, [40, 140, 60]],
  [GarmentColor.GREEN, [90, 110, 50]],
  [GarmentColor.GREEN, [30, 70, 40]],
  [GarmentColor.BLUE, [40, 80, 180]],
  [GarmentColor.BLUE, [25, 35, 75]],
  [GarmentColor.BLUE, [120, 170, 220]],
  [GarmentColor.BLUE, [70, 100, 140]],
  [GarmentColor.PURPLE, [120, 50, 150]],
  [GarmentColor.PURPLE, [180, 140, 210]],
  [GarmentColor.BLACK, [20, 20, 22]],
  [GarmentColor.WHITE, [240, 240, 238]],
  [GarmentColor.GREY, [128, 128, 128]],
  [GarmentColor.GREY, [180, 180, 180]],
  [GarmentColor.GREY, [75, 75, 78]],
  [GarmentColor.BEIGE, [215, 195, 160]],
  [GarmentColor.BEIGE, [190, 170, 130]],
  [GarmentColor.BROWN, [110, 70, 40]],
  [GarmentColor.BROWN, [70, 45, 30]],
];

/** sRGB (0-255) -> CIE L*a*b* (D65). */
function toLab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const SWATCH_LAB = SWATCHES.map(([color, rgb]) => [color, toLab(rgb)] as const);

/** Maps an sRGB triple to the closest GarmentColor. */
export function nearestGarmentColor(
  rgb: [number, number, number],
): GarmentColor {
  const [L, A, B] = toLab(rgb);
  let best = GarmentColor.OTHER;
  let bestDist = Infinity;
  for (const [color, [l2, a2, b2]] of SWATCH_LAB) {
    const d = (L - l2) ** 2 + (A - a2) ** 2 + (B - b2) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = color;
    }
  }
  return best;
}

/**
 * Estimates the dominant garment color of an image. Transparent pixels
 * (from background removal) are ignored; for opaque images only the central
 * region is sampled so the backdrop has less influence. Pixels are bucketed
 * into GarmentColors and the most common bucket wins.
 *
 * Returns undefined when the image has too few usable pixels.
 */
export async function detectDominantColor(
  image: Buffer,
): Promise<GarmentColor | undefined> {
  const SIZE = 48;
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  const hasCutout = transparent > (info.width * info.height) / 20;

  const counts = new Map<GarmentColor, number>();
  let usable = 0;
  const margin = Math.floor(SIZE * 0.25);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (
        !hasCutout &&
        (x < margin || x >= SIZE - margin || y < margin || y >= SIZE - margin)
      ) {
        continue;
      }
      const i = (y * info.width + x) * 4;
      if (data[i + 3] < 128) continue;
      const color = nearestGarmentColor([data[i], data[i + 1], data[i + 2]]);
      counts.set(color, (counts.get(color) ?? 0) + 1);
      usable++;
    }
  }
  if (usable < 20) return undefined;

  let best: GarmentColor | undefined;
  let bestCount = 0;
  for (const [color, count] of counts) {
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}
