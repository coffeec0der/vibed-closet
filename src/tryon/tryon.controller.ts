import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Render,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import { I18n, I18nContext } from 'nestjs-i18n';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { Payload } from '../auth/dto/payload.dto';
import { TryOnJob } from '../dal/entity/try-on-job.entity';
import { GarmentService } from '../wardrobe/garment.service';
import { OutfitService } from '../wardrobe/outfit.service';
import { TryOnInstallerService } from './tryon-installer.service';
import { tryOnCategory } from './tryon-plan.util';
import { SIZES, TryOnSettingsService } from './tryon-settings.service';
import { TryOnService } from './tryon.service';

const gb = (n?: number) => (n == null ? null : (n / 1024 ** 3).toFixed(1));

@UseGuards(ConditionalAuthGuard)
@Controller('tryon')
export class TryOnController {
  private readonly logger = new Logger(TryOnController.name);

  constructor(
    private readonly tryOn: TryOnService,
    private readonly installer: TryOnInstallerService,
    private readonly settings: TryOnSettingsService,
    private readonly garmentService: GarmentService,
    private readonly outfitService: OutfitService,
  ) {}

  private userId(req: FastifyRequest): number | undefined {
    return (req['user'] as Payload | undefined)?.userId;
  }

  private jobView(job: TryOnJob) {
    return {
      id: job.id,
      status: job.status,
      label: job.label,
      progress: job.progress,
      error: job.error,
      resultFile: job.resultFile,
      personFile: job.personFile,
      renderer: job.renderer,
      passCount: job.passes?.length ?? 0,
      createdAt: job.createdAt,
      isActive: job.status === 'queued' || job.status === 'running',
      isDone: job.status === 'done',
      isFailed: job.status === 'failed',
    };
  }

  private async jobsModel(userId?: number) {
    const jobs = (await this.tryOn.listJobs(userId)).map((j) =>
      this.jobView(j),
    );
    return { jobs, hasActive: jobs.some((j) => j.isActive) };
  }

  private readiness() {
    const s = this.settings.get();
    const install = this.installer.state();
    return {
      mode: s.mode,
      isRemote: s.mode === 'remote',
      installed: install.status === 'installed',
      installing: install.status === 'installing',
      remoteUrl: s.remoteUrl,
    };
  }

  @Get()
  @Render('tryon/index')
  async index(
    @Req() req: FastifyRequest,
    @I18n() i18n: I18nContext,
    @Query('outfitId') outfitIdParam?: string,
    @Query('garmentId') garmentIdParam?: string | string[],
    @Query('error') error?: string,
    @Query('skipped') skipped?: string,
  ) {
    const userId = this.userId(req);
    const [garments, outfits, lastPerson, jobs] = await Promise.all([
      this.garmentService.findAll(userId),
      this.outfitService.findAll(userId),
      this.tryOn.lastPersonFile(userId),
      this.jobsModel(userId),
    ]);

    let selected = new Set<number>();
    const outfitId = outfitIdParam ? parseInt(outfitIdParam, 10) : undefined;
    const outfit = outfits.find((o) => o.id === outfitId);
    if (outfit) {
      selected = new Set(outfit.garments.getItems().map((g) => g.id));
    }
    for (const id of [garmentIdParam ?? []].flat()) selected.add(Number(id));

    const tryable = garments
      .filter((g) => tryOnCategory(g.category) && g.photo)
      .map((g) => ({
        id: g.id,
        name: g.name,
        photo: (g.photo as any)?.fileName,
        categoryLabel: this.garmentService.resolveCategoryLabel(
          g.category,
          i18n,
        ),
        selected: selected.has(g.id),
      }));

    return {
      pageTitle: i18n.t('lang.TRYON'),
      garments: tryable,
      outfits: outfits.map((o) => ({
        id: o.id,
        name: o.name,
        selected: o.id === outfitId,
      })),
      outfitId: outfit?.id ?? null,
      outfitName: outfit?.name ?? null,
      lastPerson,
      error: error ? String(error).slice(0, 300) : null,
      skipped: skipped ? String(skipped).slice(0, 300) : null,
      ...jobs,
      ...this.readiness(),
    };
  }

  @Get('jobs')
  async jobs(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    return reply.viewPartial(
      'partials/tryon_jobs',
      await this.jobsModel(this.userId(req)),
    );
  }

  @Post()
  async create(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const userId = this.userId(req);
    const fields: Record<string, string[]> = {};
    let personFile: string | undefined;
    try {
      for await (const part of req.parts({ limits: { files: 1 } })) {
        if (part.type === 'file') {
          if (part.fieldname === 'person' && part.filename) {
            personFile = await this.tryOn.storePersonPhoto(part, userId);
          } else {
            part.file.resume();
          }
        } else {
          (fields[part.fieldname] ??= []).push(String(part.value));
        }
      }
      if (!personFile && fields.useLast?.[0] === '1') {
        personFile = (await this.tryOn.lastPersonFile(userId)) ?? undefined;
      }
      if (!personFile)
        throw new BadRequestException('Add a photo of yourself first');

      const outfitId = fields.outfitId?.[0]
        ? parseInt(fields.outfitId[0], 10)
        : undefined;
      let garmentIds = (fields.garmentId ?? [])
        .map(Number)
        .filter(Number.isInteger);
      let label: string | undefined;
      if (outfitId && !garmentIds.length) {
        const outfit = await this.outfitService.findOne(outfitId, userId);
        garmentIds = outfit.garments.getItems().map((g) => g.id);
        label = outfit.name;
      }
      const { skipped } = await this.tryOn.createJob(userId, {
        personFile,
        garmentIds,
        outfitId,
        label,
      });
      const params = new URLSearchParams();
      if (skipped.length) {
        params.set('skipped', skipped.map((s) => s.category).join(', '));
      }
      return reply.redirect(
        `/tryon${params.size ? `?${params}` : ''}#jobs`,
        303,
      );
    } catch (err) {
      const message = (err as Error).message ?? 'Could not start try-on';
      return reply.redirect(`/tryon?error=${encodeURIComponent(message)}`, 303);
    }
  }

  @Post(':id/delete')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.tryOn.deleteJob(id, this.userId(req));
    return reply.redirect('/tryon#jobs', 303);
  }

  // ---------------------------------------------------------------------------
  // Settings & installation
  // ---------------------------------------------------------------------------

  private installModel() {
    const s = this.installer.state();
    return {
      install: {
        ...s,
        isInstalled: s.status === 'installed',
        isInstalling: s.status === 'installing',
        isFailed: s.status === 'failed',
        isNotInstalled: s.status === 'not_installed',
        stepList: s.steps.map((label, i) => ({
          label,
          done: s.status === 'installed' || i < s.step,
          current: s.status === 'installing' && i === s.step,
        })),
        freeGb: gb(s.freeBytes),
        requiredGb: gb(s.requiredBytes),
        lowDisk: s.freeBytes != null && s.freeBytes < s.requiredBytes,
      },
      tryonDir: this.settings.dir,
    };
  }

  @Get('settings')
  @Render('tryon/settings')
  settingsPage(@I18n() i18n: I18nContext, @Query('saved') saved?: string) {
    const s = this.settings.get();
    return {
      pageTitle: i18n.t('lang.TRYON_SETTINGS'),
      settings: s,
      isLocal: s.mode === 'local',
      isRemote: s.mode === 'remote',
      sizes: SIZES.map(([w, h]) => ({
        value: `${w}x${h}`,
        label: `${w} × ${h}`,
        selected: w === s.width && h === s.height,
      })),
      saved: saved === '1',
      ...this.installModel(),
    };
  }

  @Post('settings')
  saveSettings(
    @Body()
    body: {
      mode?: string;
      remoteUrl?: string;
      remoteToken?: string;
      steps?: string;
      guidance?: string;
      size?: string;
      threads?: string;
      precision?: string;
    },
    @Res() reply: FastifyReply,
  ) {
    const [width, height] = (body.size ?? '').split('x').map(Number);
    this.settings.save({ ...body, width, height });
    void this.tryOn.tick();
    return reply.redirect('/tryon/settings?saved=1', 303);
  }

  @Get('install/status')
  installStatus(@Res() reply: FastifyReply) {
    return reply.viewPartial(
      'partials/tryon_install_status',
      this.installModel(),
    );
  }

  @Post('install')
  install(@Res() reply: FastifyReply) {
    this.installer.start();
    return reply.redirect('/tryon/settings#install', 303);
  }

  @Post('uninstall')
  uninstall(@Res() reply: FastifyReply) {
    this.installer.uninstall();
    return reply.redirect('/tryon/settings#install', 303);
  }

  @Get('remote/check')
  async remoteCheck(@Res() reply: FastifyReply) {
    const health = await this.tryOn.remoteHealth();
    const s = this.settings.get();
    reply.type('text/html');
    if (!s.remoteUrl)
      return reply.send('<span class="text-warning">No URL set</span>');
    return reply.send(
      health
        ? `<span class="text-success" id="remote-ok">✓ Online (${health.device}${health.busy ? ', busy' : ''})</span>`
        : `<span class="text-error" id="remote-offline">✗ Offline or unreachable</span>`,
    );
  }

  /** The worker script, for running a remote renderer on another machine. */
  @Get('worker.py')
  worker(@Res() reply: FastifyReply) {
    reply.header('Content-Type', 'text/x-python; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="worker.py"');
    return reply.send(fs.createReadStream(this.settings.paths.worker));
  }
}
