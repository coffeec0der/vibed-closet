import { EntityManager } from '@mikro-orm/core';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import sharp from 'sharp';
import { Garment } from '../dal/entity/garment.entity';
import { TryOnJob, TryOnPass } from '../dal/entity/try-on-job.entity';
import { User } from '../dal/entity/user.entity';
import { FileService } from '../file/file-service.abstract';
import { NotificationService } from '../notification/notification.service';
import { TryOnInstallerService } from './tryon-installer.service';
import { parseWorkerLine, planPasses } from './tryon-plan.util';
import { TryOnSettings, TryOnSettingsService } from './tryon-settings.service';

const TICK_MS = 5000;
const REMOTE_TIMEOUT_MS = 60 * 60 * 1000;

/** Thrown when the remote renderer disappears mid-job: requeue, don't fail. */
class RendererOffline extends Error {}

/**
 * Queues and renders try-on jobs, one at a time. Local jobs run the Python
 * worker as a child process; remote jobs are sent to `worker.py serve` on
 * another machine and wait (queued) while that machine is offline.
 */
@Injectable()
export class TryOnService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TryOnService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private child?: ChildProcess;

  constructor(
    private readonly em: EntityManager,
    private readonly fileService: FileService,
    private readonly settings: TryOnSettingsService,
    private readonly installer: TryOnInstallerService,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  /** Runs after all onModuleInit hooks, i.e. after migrations created the table. */
  async onApplicationBootstrap() {
    // Jobs interrupted by a restart go back to the queue.
    try {
      await this.em
        .fork()
        .nativeUpdate(
          TryOnJob,
          { status: 'running' },
          { status: 'queued', progress: null as any },
        );
    } catch (err) {
      this.logger.warn(
        `Could not requeue interrupted try-ons: ${(err as Error).message}`,
      );
    }
    if (process.env.TRYON_QUEUE_DISABLED !== 'true') {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.child?.kill('SIGTERM');
  }

  // ---------------------------------------------------------------------------
  // Jobs API
  // ---------------------------------------------------------------------------

  private ownerFilter(userId?: number) {
    return userId != null ? { owner: { id: userId } } : { owner: null };
  }

  async listJobs(userId?: number): Promise<TryOnJob[]> {
    return this.em.fork().find(TryOnJob, this.ownerFilter(userId), {
      orderBy: { createdAt: 'DESC', id: 'DESC' },
      limit: 50,
    });
  }

  /** The most recent person photo this user uploaded, for reuse. */
  async lastPersonFile(userId?: number): Promise<string | null> {
    const job = await this.em
      .fork()
      .findOne(TryOnJob, this.ownerFilter(userId), {
        orderBy: { createdAt: 'DESC', id: 'DESC' },
      });
    return job?.personFile ?? null;
  }

  /** Stores an uploaded person photo and returns its file name. */
  async storePersonPhoto(
    upload: MultipartFile,
    userId?: number,
  ): Promise<string> {
    const file = await this.fileService.storeImageFromFileUpload(
      upload,
      userId,
    );
    return file.fileName;
  }

  async createJob(
    userId: number | undefined,
    input: {
      personFile: string;
      garmentIds: number[];
      outfitId?: number;
      label?: string;
    },
  ): Promise<{ job: TryOnJob; skipped: { id: number; category: string }[] }> {
    const em = this.em.fork();
    if (!input.garmentIds.length) {
      throw new BadRequestException('Pick at least one garment');
    }
    const garments = await em.find(Garment, {
      id: { $in: input.garmentIds },
      ...(this.ownerFilter(userId) as any),
    });
    if (garments.length !== new Set(input.garmentIds).size) {
      throw new ForbiddenException('Unknown garment');
    }
    const ordered = input.garmentIds
      .map((id) => garments.find((g) => g.id === id))
      .filter((g): g is Garment => !!g);
    const { passes, skipped } = planPasses(ordered);
    if (!passes.length) {
      throw new BadRequestException(
        'None of these garments can be tried on (tops, bottoms, dresses and outerwear work)',
      );
    }
    const job = em.create(TryOnJob, {
      status: 'queued',
      personFile: input.personFile,
      passes,
      outfitId: input.outfitId,
      label: (
        input.label ||
        ordered
          .filter((g) => passes.some((p) => p.garmentId === g.id))
          .map((g) => g.name || g.category)
          .join(' + ')
      ).slice(0, 200),
      createdAt: new Date(),
      owner: userId != null ? em.getReference(User, userId) : undefined,
    } as any);
    await em.persistAndFlush(job);
    void this.tick();
    return { job, skipped };
  }

  async deleteJob(id: number, userId?: number): Promise<void> {
    const em = this.em.fork();
    const job = await em.findOne(TryOnJob, {
      id,
      ...(this.ownerFilter(userId) as any),
    });
    if (!job) throw new NotFoundException();
    if (job.status === 'running') {
      throw new BadRequestException('This try-on is rendering right now');
    }
    if (job.resultFile) {
      await this.fileService.delete(job.resultFile).catch(() => undefined);
    }
    const others = await em.count(TryOnJob, {
      personFile: job.personFile,
      id: { $ne: job.id },
    });
    if (!others)
      await this.fileService.delete(job.personFile).catch(() => undefined);
    await em.removeAndFlush(job);
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  /** Processes the oldest queued job, if it can run now. Never throws. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.processNext();
    } catch (err) {
      this.logger.error(`Try-on queue error: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async processNext(): Promise<void> {
    const em = this.em.fork();
    const job = await em.findOne(
      TryOnJob,
      { status: 'queued' },
      { orderBy: { createdAt: 'ASC', id: 'ASC' } },
    );
    if (!job) return;
    const settings = this.settings.get();

    const waiting = await this.waitingReason(settings);
    if (waiting) {
      if (job.progress !== waiting) {
        job.progress = waiting;
        await em.flush();
      }
      return;
    }

    job.status = 'running';
    job.renderer = settings.mode;
    job.startedAt = new Date();
    job.progress = 'Starting…';
    job.error = undefined;
    await em.flush();
    this.logger.log(`Try-on job ${job.id} started (${settings.mode})`);

    try {
      const png = await this.render(job, settings, em);
      const stored = await this.fileService.storeImageFromFileUpload(
        {
          mimetype: 'image/png',
          file: Readable.from(png),
        } as unknown as MultipartFile,
        job.owner?.id,
      );
      job.resultFile = stored.fileName;
      job.status = 'done';
      job.progress = undefined;
      job.finishedAt = new Date();
      await em.flush();
      this.logger.log(`Try-on job ${job.id} done`);
      this.notify(job, 'Your try-on is ready ✨');
    } catch (err) {
      if (err instanceof RendererOffline) {
        job.status = 'queued';
        job.progress = 'Remote renderer went offline; will retry';
        job.startedAt = undefined;
        await em.flush();
        return;
      }
      job.status = 'failed';
      job.error = (err as Error).message.slice(0, 2000);
      job.progress = undefined;
      job.finishedAt = new Date();
      await em.flush();
      this.logger.warn(`Try-on job ${job.id} failed: ${job.error}`);
      this.notify(job, 'Try-on failed');
    }
  }

  /** Why the queue can't run right now, or null when it can. */
  private async waitingReason(settings: TryOnSettings): Promise<string | null> {
    if (settings.mode === 'local') {
      return this.installer.isInstalled()
        ? null
        : 'Waiting: download the try-on model in Try-on settings';
    }
    if (!settings.remoteUrl)
      return 'Waiting: set the remote renderer URL in Try-on settings';
    const health = await this.remoteHealth(settings);
    return health ? null : 'Waiting for the remote renderer to come online';
  }

  async remoteHealth(
    settings: TryOnSettings = this.settings.get(),
  ): Promise<{ device: string; busy: boolean; step?: string } | null> {
    if (!settings.remoteUrl) return null;
    try {
      const res = await fetch(`${settings.remoteUrl}/health`, {
        headers: this.remoteHeaders(settings),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        ok?: boolean;
        device: string;
        busy: boolean;
        step?: string;
      };
      return body.ok ? body : null;
    } catch {
      return null;
    }
  }

  private remoteHeaders(settings: TryOnSettings): Record<string, string> {
    return settings.remoteToken
      ? { 'X-Tryon-Token': settings.remoteToken }
      : {};
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private async render(
    job: TryOnJob,
    settings: TryOnSettings,
    em: EntityManager,
  ): Promise<Buffer> {
    const { width, height } = settings;
    const fit = (buf: Buffer) =>
      sharp(buf)
        .flatten({ background: '#ffffff' })
        .resize(width, height, { fit: 'contain', background: '#ffffff' })
        .png()
        .toBuffer();

    let person = await fit(await this.readFile(job.personFile));
    for (const [i, pass] of job.passes.entries()) {
      const garment = await em.findOne(Garment, pass.garmentId, {
        populate: ['photo'],
      });
      const photo = (garment?.photo as any)?.fileName as string | undefined;
      if (!garment || !photo) {
        throw new Error(
          `Garment ${garment?.name ?? pass.garmentId} has no photo`,
        );
      }
      // The background-removed variant matches the garment-on-white images
      // the model was trained on.
      const garmentBuf =
        (await this.readFile(this.fileService.nobgFileName(photo)).catch(
          () => null,
        )) ?? (await this.readFile(photo));
      const garmentPng = await fit(garmentBuf);
      const label = `Pass ${i + 1}/${job.passes.length} (${garment.name ?? pass.category})`;
      const report = async (text: string) => {
        job.progress = `${label} · ${text}`.slice(0, 250);
        await em.flush().catch(() => undefined);
      };
      person =
        settings.mode === 'local'
          ? await this.renderLocal(
              job,
              i,
              person,
              garmentPng,
              pass,
              settings,
              report,
            )
          : await this.renderRemote(person, garmentPng, pass, settings, report);
    }
    return person;
  }

  private async renderLocal(
    job: TryOnJob,
    index: number,
    person: Buffer,
    garment: Buffer,
    pass: TryOnPass,
    settings: TryOnSettings,
    report: (text: string) => Promise<void>,
  ): Promise<Buffer> {
    const p = this.settings.paths;
    const dir = path.join(p.work, `job-${job.id}-${index}`);
    fs.mkdirSync(dir, { recursive: true });
    const files = {
      person: path.join(dir, 'person.png'),
      garment: path.join(dir, 'garment.png'),
      output: path.join(dir, 'output.png'),
      job: path.join(dir, 'job.json'),
    };
    fs.writeFileSync(files.person, person);
    fs.writeFileSync(files.garment, garment);
    const threads = settings.threads || Math.max(1, os.cpus().length - 1);
    fs.writeFileSync(
      files.job,
      JSON.stringify({
        person: files.person,
        garment: files.garment,
        output: files.output,
        category: pass.category,
        steps: settings.steps,
        guidance: settings.guidance,
        seed: job.id,
        threads,
      }),
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          p.python,
          [p.worker, 'run', '--models', p.models, '--job', files.job],
          {
            env: {
              ...process.env,
              PYTHONUNBUFFERED: '1',
              // Lower priority so Home Assistant & co stay responsive.
              TRYON_NICE: '10',
              OMP_NUM_THREADS: String(threads),
              TRYON_DTYPE: settings.precision,
              HF_HUB_OFFLINE: '1',
              TRANSFORMERS_OFFLINE: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        this.child = child;
        let errorLine: string | undefined;
        const stderr: string[] = [];
        let buffer = '';
        child.stdout.on('data', (d: Buffer) => {
          buffer += d.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const msg = parseWorkerLine(line);
            if (msg?.type === 'progress') {
              const stage =
                msg.stage === 'render'
                  ? `step ${msg.current}/${msg.total}`
                  : msg.stage === 'load'
                    ? 'loading model'
                    : msg.stage === 'mask'
                      ? 'finding clothes'
                      : msg.stage;
              void report(stage);
            } else if (msg?.type === 'error') {
              errorLine = msg.message;
            }
          }
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr.push(...d.toString().split('\n').filter(Boolean));
          if (stderr.length > 30) stderr.splice(0, stderr.length - 30);
        });
        child.on('error', reject);
        child.on('close', (code, signal) => {
          this.child = undefined;
          if (code === 0) return resolve();
          const oom = signal === 'SIGKILL' || code === 137;
          reject(
            new Error(
              oom
                ? 'The renderer was killed, most likely out of memory. Try a smaller size in Try-on settings.'
                : errorLine ||
                    stderr.slice(-5).join('\n') ||
                    `Worker exited with code ${code}`,
            ),
          );
        });
      });
      return fs.readFileSync(files.output);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async renderRemote(
    person: Buffer,
    garment: Buffer,
    pass: TryOnPass,
    settings: TryOnSettings,
    report: (text: string) => Promise<void>,
  ): Promise<Buffer> {
    await report('sending to remote renderer');
    // Show the remote's step counter while we wait.
    const poll = setInterval(() => {
      void this.remoteHealth(settings).then((h) => {
        if (h?.step) void report(`step ${h.step} (remote, ${h.device})`);
      });
    }, 3000);
    try {
      let res: Response;
      try {
        res = await fetch(`${settings.remoteUrl}/tryon`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.remoteHeaders(settings),
          },
          body: JSON.stringify({
            person: person.toString('base64'),
            garment: garment.toString('base64'),
            category: pass.category,
            steps: settings.steps,
            guidance: settings.guidance,
          }),
          signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        });
      } catch (err) {
        throw new RendererOffline((err as Error).message);
      }
      const body = (await res.json().catch(() => ({}))) as {
        image?: string;
        error?: string;
      };
      if (!res.ok || !body.image) {
        throw new Error(
          `Remote renderer: ${body.error ?? `HTTP ${res.status}`}`,
        );
      }
      return Buffer.from(body.image, 'base64');
    } finally {
      clearInterval(poll);
    }
  }

  private async readFile(fileName: string): Promise<Buffer> {
    const stream = await this.fileService.get(fileName);
    if (!stream) throw new Error(`File ${fileName} not found`);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  private notify(job: TryOnJob, title: string) {
    const ownerId = job.owner?.id;
    if (ownerId == null || !this.notifications) return;
    this.notifications
      .sendWebPushNotification(
        {
          title,
          body: job.label ?? 'Libre Closet try-on',
          click_action: '/tryon',
        },
        ownerId,
      )
      .catch((err) =>
        this.logger.warn(`Push failed: ${(err as Error).message}`),
      );
  }
}
