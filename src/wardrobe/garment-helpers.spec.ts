import { GarmentService } from './garment.service';

describe('GarmentService helpers', () => {
  describe('parsePrice', () => {
    it.each([
      ['12.50', 12.5],
      ['12,50', 12.5],
      ['€ 12', 12],
      ['$1,234.56', 1234.56],
      ['1.234,56', 1234.56],
      ['  9.999 ', 10],
      [7, 7],
    ])('parses %j as %s', (input, expected) => {
      expect(GarmentService.parsePrice(input)).toBe(expected);
    });

    it.each([[''], [null], [undefined], ['abc'], ['-5'], [-1], [NaN]])(
      'rejects %j',
      (input) => {
        expect(GarmentService.parsePrice(input)).toBeUndefined();
      },
    );
  });

  describe('tags', () => {
    it('normalizes, lower-cases and de-duplicates', () => {
      expect(GarmentService.normalizeTags(' Summer, work ,summer,, ')).toBe(
        'summer,work',
      );
      expect(GarmentService.normalizeTags(['Gym', 'gym', 'run'])).toBe(
        'gym,run',
      );
    });

    it('stores nothing for empty input', () => {
      expect(GarmentService.normalizeTags(' , ')).toBeUndefined();
      expect(GarmentService.normalizeTags(undefined)).toBeUndefined();
    });

    it('splits stored tags', () => {
      expect(GarmentService.splitTags('summer,work')).toEqual([
        'summer',
        'work',
      ]);
      expect(GarmentService.splitTags(null)).toEqual([]);
    });
  });
});
