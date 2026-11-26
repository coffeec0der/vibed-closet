import sharp from 'sharp';
import { GarmentColor } from './garment-color.enum';
import {
  detectDominantColor,
  nearestGarmentColor,
} from './dominant-color.util';

const solid = (r: number, g: number, b: number, size = 64) =>
  sharp({
    create: { width: size, height: size, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();

describe('nearestGarmentColor', () => {
  it.each([
    [[200, 30, 40], GarmentColor.RED],
    [[20, 30, 70], GarmentColor.BLUE], // navy
    [[135, 185, 230], GarmentColor.BLUE], // sky
    [[15, 15, 15], GarmentColor.BLACK],
    [[250, 250, 250], GarmentColor.WHITE],
    [[128, 128, 130], GarmentColor.GREY],
    [[220, 200, 165], GarmentColor.BEIGE],
    [[100, 65, 35], GarmentColor.BROWN],
    [[85, 107, 47], GarmentColor.GREEN], // olive
    [[250, 170, 200], GarmentColor.PINK],
    [[255, 140, 0], GarmentColor.ORANGE],
    [[250, 220, 40], GarmentColor.YELLOW],
    [[110, 40, 140], GarmentColor.PURPLE],
  ] as [[number, number, number], GarmentColor][])(
    'maps %j to %s',
    (rgb, expected) => {
      expect(nearestGarmentColor(rgb)).toBe(expected);
    },
  );
});

describe('detectDominantColor', () => {
  it('detects a solid color', async () => {
    expect(await detectDominantColor(await solid(30, 60, 170))).toBe(
      GarmentColor.BLUE,
    );
  });

  it('ignores transparent background pixels from background removal', async () => {
    // Mostly-transparent canvas with a small red garment in the middle.
    const garment = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 4,
        background: { r: 200, g: 25, b: 35, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const cutout = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      },
    })
      .composite([{ input: garment, top: 80, left: 80 }])
      .png()
      .toBuffer();
    expect(await detectDominantColor(cutout)).toBe(GarmentColor.RED);
  });

  it('samples the centre of opaque photos so the backdrop matters less', async () => {
    // White backdrop, black garment filling the central half.
    const centre = await solid(15, 15, 15, 100);
    const photo = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 250, g: 250, b: 250 },
      },
    })
      .composite([{ input: centre, top: 50, left: 50 }])
      .png()
      .toBuffer();
    expect(await detectDominantColor(photo)).toBe(GarmentColor.BLACK);
  });

  it('returns undefined for a fully transparent image', async () => {
    const empty = await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    expect(await detectDominantColor(empty)).toBeUndefined();
  });
});
