import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Render,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { Payload } from '../auth/dto/payload.dto';
import { GarmentService } from './garment.service';

/**
 * Laundry basket: garments become dirty when an outfit containing them is
 * marked worn on the calendar, and clean again from here (or individually).
 * Only the wardrobe owner can change laundry state.
 */
@UseGuards(ConditionalAuthGuard)
@Controller('laundry')
export class LaundryController {
  constructor(private readonly garmentService: GarmentService) {}

  private userId(req: FastifyRequest): number | undefined {
    return (req['user'] as Payload | undefined)?.userId;
  }

  @Get()
  @Render('laundry/index')
  async index(@Req() req: FastifyRequest, @I18n() i18n: I18nContext) {
    const garments = await this.garmentService.findAll(this.userId(req), {
      laundry: 'true',
    });
    return {
      pageTitle: i18n.t('lang.LAUNDRY'),
      garments: garments.map((g) => ({
        garment: g,
        categoryLabel: this.garmentService.resolveCategoryLabel(
          g.category,
          i18n,
        ),
      })),
    };
  }

  /** Empties the basket: every dirty garment becomes clean. */
  @Post('done')
  async done(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    await this.garmentService.markAllClean(this.userId(req));
    return this.redirect(req, reply, '/laundry');
  }

  /** Toggles one garment between clean and dirty. */
  @Post(':id/toggle')
  async toggle(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.garmentService.toggleLaundry(id, this.userId(req));
    const back = (req.body as { returnTo?: string } | undefined)?.returnTo;
    // Only allow local paths to avoid an open redirect.
    const target =
      back && back.startsWith('/') && !back.startsWith('//')
        ? back
        : `/wardrobe/${id}`;
    return this.redirect(req, reply, target);
  }

  private redirect(req: FastifyRequest, reply: FastifyReply, url: string) {
    if (req.headers['hx-request']) {
      reply.header('HX-Redirect', url);
      return reply.send();
    }
    return reply.redirect(url, 303);
  }
}
