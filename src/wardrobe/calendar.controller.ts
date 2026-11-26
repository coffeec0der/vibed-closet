import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Get,
  Query,
  Render,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { Payload } from '../auth/dto/payload.dto';
import {
  temperatureUnitFromAcceptLanguage,
  usesTwelveHourClock,
} from '../weather/temperature-unit.util';
import { CalendarService } from './calendar.service';
import { ConfigService } from '@nestjs/config';
import { GarmentService } from './garment.service';

@UseGuards(ConditionalAuthGuard)
@Controller('calendar')
export class CalendarController {
  constructor(
    private readonly calendarService: CalendarService,
    private readonly garmentService: GarmentService,
    private readonly configService: ConfigService,
  ) {}

  /** WEATHER_ENABLED=false keeps the app fully offline (no Open-Meteo calls). */
  private get weatherEnabled(): boolean {
    return this.configService.get<boolean>('WEATHER_ENABLED') !== false;
  }

  private userId(req: FastifyRequest): number | undefined {
    return (req['user'] as Payload | undefined)?.userId;
  }

  /** Accept-Language header normalized to a plain string (or undefined). */
  private acceptLanguage(req: FastifyRequest): string | undefined {
    const header = req.headers['accept-language'];
    return typeof header === 'string' ? header : undefined;
  }

  @Get()
  @Render('calendar/index')
  async index(
    @Query('week') weekParam: string | undefined,
    @Query('calMonth') calMonthParam: string | undefined,
    @Query('lat') latParam: string | undefined,
    @Query('lon') lonParam: string | undefined,
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
  ) {
    const weatherOn = this.weatherEnabled;
    const lat =
      weatherOn && latParam != null ? parseFloat(latParam) : undefined;
    const lon =
      weatherOn && lonParam != null ? parseFloat(lonParam) : undefined;
    const acceptLanguage = this.acceptLanguage(req);
    return this.calendarService.buildIndexViewModel(
      weekParam,
      calMonthParam,
      this.userId(req),
      i18n,
      Number.isFinite(lat) ? lat : undefined,
      Number.isFinite(lon) ? lon : undefined,
      temperatureUnitFromAcceptLanguage(acceptLanguage),
    );
  }

  @Get('weather')
  async weatherDetails(
    @Query('date') dateParam: string | undefined,
    @Query('lat') latParam: string | undefined,
    @Query('lon') lonParam: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @I18n() i18n: I18nContext,
  ) {
    if (!this.weatherEnabled) {
      return reply.viewPartial('calendar/weather_modal', { forecast: null });
    }
    const lat = latParam != null ? parseFloat(latParam) : undefined;
    const lon = lonParam != null ? parseFloat(lonParam) : undefined;
    const acceptLanguage = this.acceptLanguage(req);
    const viewModel = await this.calendarService.buildWeatherModalViewModel(
      dateParam,
      Number.isFinite(lat) ? lat : undefined,
      Number.isFinite(lon) ? lon : undefined,
      i18n,
      temperatureUnitFromAcceptLanguage(acceptLanguage),
      usesTwelveHourClock(acceptLanguage),
      acceptLanguage,
    );
    return reply.viewPartial('calendar/weather_modal', viewModel);
  }

  /**
   * Packing list: every garment scheduled between `from` and `to` (inclusive).
   * Defaults to the next 7 days.
   */
  @Get('packing')
  @Render('calendar/packing')
  async packing(
    @Query('from') fromParam: string | undefined,
    @Query('to') toParam: string | undefined,
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
  ) {
    const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const today = new Date().toISOString().slice(0, 10);
    let from = isDate(fromParam) ? fromParam! : today;
    let to = isDate(toParam)
      ? toParam!
      : new Date(Date.parse(from) + 6 * 86400000).toISOString().slice(0, 10);
    if (to < from) [from, to] = [to, from];

    const { garments, outfitCount, dayCount } =
      await this.calendarService.packingList(
        new Date(from),
        new Date(to),
        this.userId(req),
      );
    const groups: { label: string; garments: typeof garments }[] = [];
    for (const g of garments) {
      const label = this.garmentService.resolveCategoryLabel(g.category, i18n);
      const last = groups[groups.length - 1];
      if (last?.label === label) last.garments.push(g);
      else groups.push({ label, garments: [g] });
    }
    return {
      pageTitle: i18n.t('lang.PACKING_LIST'),
      from,
      to,
      groups,
      garmentCount: garments.length,
      outfitCount,
      dayCount,
    };
  }

  @Post()
  async create(
    @Body()
    body: { date: string; outfitId: string; notes?: string; week?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.calendarService.create(
      {
        date: new Date(body.date),
        outfitId: Number(body.outfitId),
        notes: body.notes,
      },
      this.userId(req),
    );
    if (req.headers['hx-request'] === 'true') {
      return reply.status(204).send();
    }
    return reply.redirect(`/calendar?week=${body.week ?? body.date}`, 302);
  }

  @Post(':id/delete')
  @HttpCode(200)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { week?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.calendarService.remove(id, this.userId(req));
    reply.header('HX-Redirect', `/calendar?week=${body.week ?? ''}`);
    return reply.send();
  }

  @Post(':id/worn')
  async toggleWorn(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { week?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @I18n() i18n: I18nContext,
  ) {
    const entry = await this.calendarService.toggleWorn(id, this.userId(req));
    const week = body.week ?? '';

    if (req.headers['hx-request']) {
      const isWorn = !!entry.wornAt;
      const btnClass = isWorn
        ? 'bg-success text-success-content'
        : 'text-base-content/40 italic font-normal hover:text-base-content/70';
      const label = isWorn
        ? `✓ ${i18n.t('lang.CALENDAR_WORN')}`
        : i18n.t('lang.CALENDAR_MARK_WORN_PROMPT');
      return reply.viewPartial('partials/calendar_worn_button', {
        entryId: id,
        week,
        btnClass,
        label,
      });
    }

    // Non-HTMX fallback: full redirect
    return reply.redirect(`/calendar?week=${week}`, 303);
  }
}
