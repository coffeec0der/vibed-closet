import { Garment } from '../dal/entity/garment.entity';
import { OutfitCalendar } from '../dal/entity/outfit-calendar.entity';
import { WearStatsService } from './wear-stats.service';

const garment = (id: number, extra: Partial<Garment> = {}) =>
  ({ id, category: 'tops', ...extra }) as Garment;

const entry = (date: string, wornAt: string, garments: Garment[]) =>
  ({
    date: new Date(date),
    wornAt: new Date(wornAt),
    outfit: { unwrap: () => ({ garments: { getItems: () => garments } }) },
  }) as unknown as OutfitCalendar;

describe('WearStatsService', () => {
  const tee = garment(1, { price: 30 });
  const jeans = garment(2, { price: 80 });
  const now = new Date('2026-06-30T12:00:00Z');

  function serviceWith(entries: OutfitCalendar[]) {
    const repo = { find: jest.fn().mockResolvedValue(entries) };
    return { service: new WearStatsService(repo as any), repo };
  }

  it('counts one wear per worn entry and tracks the latest wear', async () => {
    const { service, repo } = serviceWith([
      entry('2026-06-01', '2026-06-01T20:00:00Z', [tee, jeans]),
      entry('2026-06-10', '2026-06-10T20:00:00Z', [tee]),
    ]);
    const stats = await service.statsByGarment(7);

    expect(repo.find).toHaveBeenCalledWith(
      { owner: { id: 7 }, wornAt: { $ne: null } },
      expect.anything(),
    );
    expect(stats.get(1)).toEqual({
      timesWorn: 2,
      lastWorn: new Date('2026-06-10'),
    });
    expect(stats.get(2)?.timesWorn).toBe(1);
  });

  it('scopes to ownerless entries when auth is disabled', async () => {
    const { service, repo } = serviceWith([]);
    await service.statsByGarment(undefined);
    expect(repo.find.mock.calls[0][0]).toEqual({
      owner: null,
      wornAt: { $ne: null },
    });
  });

  it('uses the planned date when an outfit is marked worn later', () => {
    expect(
      WearStatsService.wearDate(
        entry('2026-06-01', '2026-06-05T09:00:00Z', []),
      ),
    ).toEqual(new Date('2026-06-01'));
    // Marked worn before the planned date (rescheduled): use the real date.
    expect(
      WearStatsService.wearDate(
        entry('2026-06-09', '2026-06-05T09:00:00Z', []),
      ),
    ).toEqual(new Date('2026-06-05T09:00:00Z'));
  });

  it('computes cost per wear and days since worn', () => {
    const { service } = serviceWith([]);
    const stats = new Map([
      [1, { timesWorn: 4, lastWorn: new Date('2026-06-20T12:00:00Z') }],
    ]);
    const [teeStats, jeansStats] = service.annotate([tee, jeans], stats, now);

    expect(teeStats).toMatchObject({
      timesWorn: 4,
      daysSinceWorn: 10,
      costPerWear: 7.5,
    });
    // Never worn: cost per wear is the full price.
    expect(jeansStats).toMatchObject({
      timesWorn: 0,
      lastWorn: null,
      daysSinceWorn: null,
      costPerWear: 80,
    });
    expect(service.annotate([garment(3)], stats, now)[0].costPerWear).toBe(
      null,
    );
  });

  it('flags unworn garments but spares recent purchases', () => {
    const { service } = serviceWith([]);
    const stats = new Map([
      [1, { timesWorn: 1, lastWorn: new Date('2026-01-01T12:00:00Z') }],
      [2, { timesWorn: 1, lastWorn: new Date('2026-06-01T12:00:00Z') }],
    ]);
    const items = service.annotate(
      [
        tee,
        jeans,
        garment(3),
        garment(4, { dateAquired: new Date('2026-06-15') }),
        garment(5, { dateAquired: new Date('2025-01-01') }),
      ],
      stats,
      now,
    );
    expect(items.map((i) => service.isUnworn(i, 90, now))).toEqual([
      true, // last worn ~180 days ago
      false, // worn a month ago
      true, // never worn, no purchase date
      false, // never worn, bought two weeks ago
      true, // never worn, bought long ago
    ]);
  });
});
