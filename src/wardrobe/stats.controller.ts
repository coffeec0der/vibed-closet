import { Controller, Get, Render, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { Payload } from '../auth/dto/payload.dto';
import { GarmentService } from './garment.service';
import { OutfitService } from './outfit.service';
import { GarmentWithStats, WearStatsService } from './wear-stats.service';

/** Days without wear after which a garment counts as "unworn". */
export const UNWORN_DAYS = 90;
const LIST_LIMIT = 8;

@UseGuards(ConditionalAuthGuard)
@Controller('stats')
export class StatsController {
  constructor(
    private readonly garmentService: GarmentService,
    private readonly outfitService: OutfitService,
    private readonly wearStatsService: WearStatsService,
  ) {}

  @Get()
  @Render('stats/index')
  async index(@Req() req: FastifyRequest, @I18n() i18n: I18nContext) {
    const userId = (req['user'] as Payload | undefined)?.userId;
    const [garments, outfits, wearStats] = await Promise.all([
      this.garmentService.findAll(userId),
      this.outfitService.findAll(userId),
      this.wearStatsService.statsByGarment(userId),
    ]);
    const items = this.wearStatsService.annotate(garments, wearStats);

    const priced = items.filter((i) => i.garment.price != null);
    const wardrobeValue = priced.reduce((sum, i) => sum + i.garment.price!, 0);
    const totalWears = items.reduce((sum, i) => sum + i.timesWorn, 0);

    const mostWorn = items
      .filter((i) => i.timesWorn > 0)
      .sort((a, b) => b.timesWorn - a.timesWorn)
      .slice(0, LIST_LIMIT);
    const pricedWorn = priced.filter((i) => i.timesWorn > 0);
    const bestValue = [...pricedWorn]
      .sort((a, b) => a.costPerWear! - b.costPerWear!)
      .slice(0, LIST_LIMIT);
    // Most expensive per wear, including never-worn garments (cpw = price).
    const worstValue = [...priced]
      .sort((a, b) => b.costPerWear! - a.costPerWear!)
      .slice(0, LIST_LIMIT);
    const unworn = items
      .filter((i) => this.wearStatsService.isUnworn(i, UNWORN_DAYS))
      .sort(
        (a, b) => (b.daysSinceWorn ?? Infinity) - (a.daysSinceWorn ?? Infinity),
      );

    const byCategory = new Map<string, number>();
    for (const g of garments) {
      byCategory.set(g.category, (byCategory.get(g.category) ?? 0) + 1);
    }
    const maxCategory = Math.max(1, ...byCategory.values());
    const categories = [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        label: this.garmentService.resolveCategoryLabel(value, i18n),
        count,
        percent: Math.round((count / maxCategory) * 100),
      }));

    const view = (i: GarmentWithStats) => ({
      id: i.garment.id,
      name: i.garment.name,
      photo: i.garment.photo?.fileName ?? null,
      timesWorn: i.timesWorn,
      lastWorn: i.lastWorn,
      daysSinceWorn: i.daysSinceWorn,
      price: i.garment.price ?? null,
      costPerWear: i.costPerWear,
    });

    return {
      pageTitle: i18n.t('lang.STATS'),
      totals: {
        garments: garments.length,
        outfits: outfits.length,
        wears: totalWears,
        inLaundry: garments.filter((g) => g.inLaundry).length,
        wardrobeValue,
        pricedCount: priced.length,
        unworn: unworn.length,
      },
      unwornDays: UNWORN_DAYS,
      mostWorn: mostWorn.map(view),
      bestValue: bestValue.map(view),
      worstValue: worstValue.map(view),
      unworn: unworn.slice(0, LIST_LIMIT).map(view),
      categories,
    };
  }
}
