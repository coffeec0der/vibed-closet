import { Garment } from '../dal/entity/garment.entity';
import { OutfitService } from './outfit.service';

const g = (id: number, category: string, inLaundry = false) =>
  ({ id, category, name: `g${id}`, inLaundry }) as Garment;

describe('OutfitService.buildShuffledRows', () => {
  const garmentService = { resolveCategoryLabel: (v: string) => v };
  const service = new OutfitService(
    {} as any,
    {} as any,
    {} as any,
    garmentService as any,
  );
  const i18n = {} as any;
  const selected = (rows: ReturnType<OutfitService['buildShuffledRows']>) =>
    Object.fromEntries(rows.map((r) => [r.value, r.garmentId]));

  it('picks one clean garment per category', () => {
    const garments = [
      g(1, 'tops', true),
      g(2, 'tops'),
      g(3, 'bottoms'),
      g(4, 'footwear', true), // only option is dirty -> left empty
      g(5, 'hats'), // custom categories are included too
    ];
    for (const r of [0, 0.5, 0.99]) {
      const rows = service.buildShuffledRows(garments, i18n, () => r);
      expect(selected(rows)).toEqual({
        tops: 2,
        bottoms: 3,
        footwear: null,
        hats: 5,
      });
    }
  });

  it('keeps every garment navigable with the row arrows', () => {
    const rows = service.buildShuffledRows(
      [g(1, 'tops', true), g(2, 'tops')],
      i18n,
      () => 0,
    );
    expect(rows[0]).toMatchObject({ garmentCount: 2, currentIndex: 2 });
  });

  it('wears either a dress or top + bottoms, never both', () => {
    const garments = [g(1, 'dresses'), g(2, 'tops'), g(3, 'bottoms')];
    // 1 dress vs 1 top -> 50/50 split on the first random draw.
    const dress = selected(
      service.buildShuffledRows(garments, i18n, () => 0.1),
    );
    expect(dress).toEqual({ dresses: 1, tops: null, bottoms: null });
    const separates = selected(
      service.buildShuffledRows(garments, i18n, () => 0.9),
    );
    expect(separates).toEqual({ dresses: null, tops: 2, bottoms: 3 });
  });

  it('orders built-in categories before custom ones', () => {
    const rows = service.buildShuffledRows(
      [g(1, 'zebra'), g(2, 'footwear'), g(3, 'tops')],
      i18n,
      () => 0,
    );
    expect(rows.map((r) => r.value)).toEqual(['tops', 'footwear', 'zebra']);
  });
});
