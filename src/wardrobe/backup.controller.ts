import {
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Render,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { Payload } from '../auth/dto/payload.dto';
import { BackupService } from './backup.service';

/** Largest export zip accepted on import. */
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024; // 1 GB

@UseGuards(ConditionalAuthGuard)
@Controller('backup')
export class BackupController {
  private readonly logger = new Logger(BackupController.name);

  constructor(private readonly backupService: BackupService) {}

  private userId(req: FastifyRequest): number | undefined {
    return (req['user'] as Payload | undefined)?.userId;
  }

  @Get()
  @Render('backup/index')
  page(
    @I18n() i18n: I18nContext,
    @Query('imported') imported?: string,
    @Query('error') error?: string,
  ) {
    let summary: Record<string, number> | null = null;
    if (imported) {
      const [garments, outfits, calendar, photos] = imported
        .split(',')
        .map((n) => parseInt(n, 10) || 0);
      summary = { garments, outfits, calendar, photos };
    }
    return {
      pageTitle: i18n.t('lang.BACKUP'),
      summary,
      error: error ? String(error).slice(0, 200) : null,
    };
  }

  @Get('export')
  async export(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const stamp = new Date().toISOString().slice(0, 10);
    const stream = await this.backupService.exportZip(this.userId(req));
    reply.header('Content-Type', 'application/zip');
    reply.header(
      'Content-Disposition',
      `attachment; filename="libre-closet-${stamp}.zip"`,
    );
    return reply.send(stream);
  }

  @Post('import')
  async import(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    try {
      const file = await req.file({ limits: { fileSize: MAX_IMPORT_BYTES } });
      if (!file) throw new Error('No file uploaded');
      const buffer = await file.toBuffer();
      const s = await this.backupService.importZip(buffer, this.userId(req));
      return reply.redirect(
        `/backup?imported=${s.garments},${s.outfits},${s.calendar},${s.photos}`,
        303,
      );
    } catch (err) {
      const message = (err as Error)?.message ?? 'Import failed';
      this.logger.warn(`Import failed: ${message}`);
      return reply.redirect(
        `/backup?error=${encodeURIComponent(message)}`,
        303,
      );
    }
  }
}
