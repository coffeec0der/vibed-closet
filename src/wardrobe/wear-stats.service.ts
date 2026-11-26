import { EntityRepository } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { Injectable } from '@nestjs/common';
import { OutfitCalendar } from '../dal/entity/outfit-calendar.entity';
import { Garment } from '../dal/entity/garment.entity';

export interface GarmentWearStats {
  timesWorn: number;
  lastWorn: Date | null;
}

export interface GarmentWithStats {
  garment: Garment;
  timesWorn: number;
  lastWorn: Date | null;
  daysSinceWorn: number | null;
  costPerWear: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Derives per-garment wear statistics from calendar entries that were marked
 * as worn. A garment counts as worn once per worn calendar entry whose outfit
 * contains it.
 */
@Injectable()
export class WearStatsService {
  constructor(
    @InjectRepository(OutfitCalendar)
    private readonly calendarRepository: EntityRepository<OutfitCalendar>,
  ) {}

  async statsByGarment(
    ownerId?: number,
  ): Promise<Map<number, GarmentWearStats>> {
    const ownerFilter =
      ownerId != null ? { owner: { id: ownerId } } : { owner: null };
    const entries = await this.calendarRepository.find(
      { ...ownerFilter, wornAt: { $ne: null } },
      { populate: ['outfit', 'outfit.garments'] },
    );

    const stats = new Map<number, GarmentWearStats>();
    for (const entry of entries) {
      const wornOn = WearStatsService.wearDate(entry);
      for (const garment of entry.outfit.unwrap().garments.getItems()) {
        const current = stats.get(garment.id) ?? {
          timesWorn: 0,
          lastWorn: null,
        };
        current.timesWorn += 1;
        if (!current.lastWorn || wornOn > current.lastWorn) {
          current.lastWorn = wornOn;
        }
        stats.set(garment.id, current);
      }
    }
    return stats;
  }

  /**
   * Annotates garments with wear stats and cost-per-wear. Cost per wear is the
   * price divided by times worn; an unworn garment's cost per wear is its
   * full price.
   */
  annotate(
    garments: Garment[],
    stats: Map<number, GarmentWearStats>,
    now: Date = new Date(),
  ): GarmentWithStats[] {
    return garments.map((garment) => {
      const s = stats.get(garment.id);
      const timesWorn = s?.timesWorn ?? 0;
      const lastWorn = s?.lastWorn ?? null;
      return {
        garment,
        timesWorn,
        lastWorn,
        daysSinceWorn: lastWorn
          ? Math.max(
              0,
              Math.floor((now.getTime() - lastWorn.getTime()) / DAY_MS),
            )
          : null,
        costPerWear:
          garment.price != null
            ? round2(garment.price / Math.max(timesWorn, 1))
            : null,
      };
    });
  }

  /**
   * True when the garment hasn't been worn in at least `days` days (or never).
   * Garments acquired less than `days` ago and never worn are not flagged, so
   * new purchases don't immediately show up as neglected.
   */
  isUnworn(
    item: GarmentWithStats,
    days: number,
    now: Date = new Date(),
  ): boolean {
    if (item.lastWorn) return (item.daysSinceWorn ?? 0) >= days;
    const acquired = item.garment.dateAquired;
    if (acquired) {
      return now.getTime() - new Date(acquired).getTime() >= days * DAY_MS;
    }
    return true;
  }

  /** The earlier of the planned date and the moment it was marked worn. */
  static wearDate(entry: OutfitCalendar): Date {
    const planned = new Date(entry.date);
    const marked = entry.wornAt ? new Date(entry.wornAt) : planned;
    return planned < marked ? planned : marked;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
