import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import {
  strFromU8,
  strToU8,
  unzipSync,
  Zip,
  ZipDeflate,
  ZipPassThrough,
} from 'fflate';
import { PassThrough, Readable } from 'node:stream';
import { Garment } from '../dal/entity/garment.entity';
import { Outfit, OutfitSlot } from '../dal/entity/outfit.entity';
import { OutfitCalendar } from '../dal/entity/outfit-calendar.entity';
import { User } from '../dal/entity/user.entity';
import { File } from '../dal/entity/file.entity';
import { FileService } from '../file/file-service.abstract';

export const EXPORT_FORMAT = 'libre-closet-export';
export const EXPORT_VERSION = 1;
const DATA_FILE = 'libre-closet.json';

export interface ExportedGarment {
  ref: number;
  name?: string | null;
  category: string;
  color?: string | null;
  brand?: string | null;
  size?: string | null;
  dateAquired?: string | null;
  notes?: string | null;
  washingDetails?: string | null;
  archived?: boolean;
  price?: number | null;
  tags?: string | null;
  inLaundry?: boolean;
  /** Path of the original photo inside the zip. */
  photo?: string | null;
  /** Path of the background-removed photo inside the zip. */
  photoNobg?: string | null;
}

export interface ExportedOutfit {
  ref: number;
  name?: string | null;
  notes?: string | null;
  slots?: { category: string; garmentRef: number | null }[] | null;
  garmentRefs: number[];
}

export interface ExportedCalendarEntry {
  date: string;
  outfitRef: number;
  wornAt?: string | null;
  notes?: string | null;
}

export interface ExportDocument {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  garments: ExportedGarment[];
  outfits: ExportedOutfit[];
  calendar: ExportedCalendarEntry[];
}

export interface ImportSummary {
  garments: number;
  outfits: number;
  calendar: number;
  photos: number;
}

/**
 * Exports a wardrobe (garments + photos, outfits, calendar) to a zip, and
 * imports such a zip into a wardrobe. Imports are additive: everything is
 * created as new records owned by the importing user, so importing into an
 * existing wardrobe never overwrites anything.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    @InjectRepository(Garment)
    private readonly garmentRepository: EntityRepository<Garment>,
    @InjectRepository(Outfit)
    private readonly outfitRepository: EntityRepository<Outfit>,
    @InjectRepository(OutfitCalendar)
    private readonly calendarRepository: EntityRepository<OutfitCalendar>,
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    private readonly fileService: FileService,
    private readonly em: EntityManager,
  ) {}

  private ownerFilter(userId?: number) {
    return userId != null ? { owner: { id: userId } } : { owner: null };
  }

  /** Builds the JSON document describing the wardrobe (no photo bytes). */
  async buildDocument(userId?: number): Promise<ExportDocument> {
    const where = this.ownerFilter(userId);
    const [garments, outfits, entries] = await Promise.all([
      this.garmentRepository.find(where as any, {
        populate: ['photo'],
        orderBy: { id: 'ASC' },
      }),
      this.outfitRepository.find(where as any, {
        populate: ['garments'],
        orderBy: { id: 'ASC' },
      }),
      this.calendarRepository.find(where as any, {
        populate: ['outfit'],
        orderBy: { date: 'ASC' },
      }),
    ]);

    const iso = (d?: Date | string | null) =>
      d ? new Date(d).toISOString() : null;

    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      garments: garments.map((g) => {
        // `photo` is a plain (non-Ref) relation, populated above.
        const fileName = (g.photo as unknown as File | undefined)?.fileName;
        return {
          ref: g.id,
          name: g.name ?? null,
          category: g.category,
          color: g.color ?? null,
          brand: g.brand ?? null,
          size: g.size ?? null,
          dateAquired: iso(g.dateAquired),
          notes: g.notes ?? null,
          washingDetails: g.washingDetails ?? null,
          archived: g.archived,
          price: g.price ?? null,
          tags: g.tags ?? null,
          inLaundry: g.inLaundry,
          photo: fileName ? `photos/${fileName}` : null,
          photoNobg: fileName
            ? `photos/${this.fileService.nobgFileName(fileName)}`
            : null,
        };
      }),
      outfits: outfits.map((o) => ({
        ref: o.id,
        name: o.name ?? null,
        notes: o.notes ?? null,
        slots:
          o.slots?.map((s) => ({
            category: s.category,
            garmentRef: s.garmentId,
          })) ?? null,
        garmentRefs: o.garments.getItems().map((g) => g.id),
      })),
      calendar: entries.map((e) => ({
        date: iso(e.date)!,
        outfitRef: e.outfit.id,
        wornAt: iso(e.wornAt),
        notes: e.notes ?? null,
      })),
    };
  }

  /**
   * Streams a zip containing `libre-closet.json` plus every photo (original
   * and background-removed variant). Photos are already compressed WebP, so
   * they're stored without deflate.
   */
  async exportZip(userId?: number): Promise<Readable> {
    const doc = await this.buildDocument(userId);
    const out = new PassThrough();
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        out.destroy(err);
        return;
      }
      out.write(Buffer.from(chunk));
      if (final) out.end();
    });

    const json = new ZipDeflate(DATA_FILE, { level: 6 });
    zip.add(json);
    json.push(strToU8(JSON.stringify(doc, null, 2)), true);

    void (async () => {
      try {
        for (const g of doc.garments) {
          for (const path of [g.photo, g.photoNobg]) {
            if (!path) continue;
            // Respect backpressure so big wardrobes aren't buffered in memory.
            if (out.writableNeedDrain) {
              await new Promise((resolve) => out.once('drain', resolve));
            }
            // A missing file (e.g. nobg variant never generated) is skipped;
            // import treats absent zip entries as "no photo".
            const bytes = await this.readFile(path.slice('photos/'.length));
            if (!bytes) continue;
            const entry = new ZipPassThrough(path);
            zip.add(entry);
            entry.push(new Uint8Array(bytes), true);
          }
        }
        zip.end();
      } catch (err) {
        this.logger.error('Export failed', err as Error);
        out.destroy(err as Error);
      }
    })();
    return out;
  }

  /** Parses and validates an export zip. Throws BadRequestException. */
  parseZip(buffer: Buffer): {
    doc: ExportDocument;
    files: Record<string, Uint8Array>;
  } {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(new Uint8Array(buffer));
    } catch {
      throw new BadRequestException('Not a valid zip file');
    }
    const raw = files[DATA_FILE];
    if (!raw) {
      throw new BadRequestException(`Zip does not contain ${DATA_FILE}`);
    }
    let doc: ExportDocument;
    try {
      doc = JSON.parse(strFromU8(raw));
    } catch {
      throw new BadRequestException(`${DATA_FILE} is not valid JSON`);
    }
    if (doc?.format !== EXPORT_FORMAT) {
      throw new BadRequestException('Not a Libre Closet export');
    }
    if (typeof doc.version !== 'number' || doc.version > EXPORT_VERSION) {
      throw new BadRequestException(
        `Unsupported export version ${doc.version}; update Libre Closet first`,
      );
    }
    if (
      !Array.isArray(doc.garments) ||
      !Array.isArray(doc.outfits) ||
      !Array.isArray(doc.calendar)
    ) {
      throw new BadRequestException('Export is missing required sections');
    }
    for (const g of doc.garments) {
      if (typeof g?.category !== 'string' || !g.category.trim()) {
        throw new BadRequestException('Every garment needs a category');
      }
    }
    return { doc, files };
  }

  /** Imports an export zip into the given user's wardrobe (additive). */
  async importZip(buffer: Buffer, userId?: number): Promise<ImportSummary> {
    const { doc, files } = this.parseZip(buffer);
    const owner =
      userId != null ? await this.userRepository.findOneOrFail(userId) : null;
    const summary: ImportSummary = {
      garments: 0,
      outfits: 0,
      calendar: 0,
      photos: 0,
    };
    const date = (v?: string | null) => {
      if (!v) return undefined;
      const d = new Date(v);
      return isNaN(d.getTime()) ? undefined : d;
    };
    const str = (v: unknown) =>
      typeof v === 'string' && v.length ? v : undefined;

    // Photos go to storage first (outside the DB transaction); they're plain
    // files keyed by fresh UUIDs, so a failed import leaves no DB references.
    const photoByRef = new Map<number, File>();
    for (const g of doc.garments) {
      const bytes = g.photo ? files[g.photo] : undefined;
      if (!bytes) continue;
      const photo = await this.fileService.storeImageFromFileUpload(
        fakeUpload(bytes),
        userId,
      );
      const nobg = g.photoNobg ? files[g.photoNobg] : undefined;
      if (nobg) {
        await this.fileService
          .storeNobgVariantFromStream(
            Readable.from(Buffer.from(nobg)),
            photo.fileName,
          )
          .catch((err) => this.logger.warn(err));
      }
      photoByRef.set(g.ref, photo);
      summary.photos++;
    }

    await this.em.transactional(async (em) => {
      const garmentByRef = new Map<number, Garment>();
      for (const g of doc.garments) {
        const garment = em.create(Garment, {
          name: str(g.name),
          category: g.category.trim(),
          color: str(g.color) as any,
          brand: str(g.brand),
          size: str(g.size),
          dateAquired: date(g.dateAquired),
          notes: str(g.notes),
          washingDetails: str(g.washingDetails),
          archived: !!g.archived,
          price:
            typeof g.price === 'number' && Number.isFinite(g.price)
              ? g.price
              : undefined,
          tags: str(g.tags),
          inLaundry: !!g.inLaundry,
          photo: photoByRef.has(g.ref)
            ? em.getReference(File, photoByRef.get(g.ref)!.id)
            : undefined,
          owner: owner ?? undefined,
        });
        garmentByRef.set(g.ref, garment);
        summary.garments++;
      }
      // Flush so imported garments have ids for outfit slots.
      await em.flush();

      const outfitByRef = new Map<number, Outfit>();
      for (const o of doc.outfits) {
        const slots: OutfitSlot[] | undefined = Array.isArray(o.slots)
          ? o.slots
              .filter((s) => typeof s?.category === 'string')
              .map((s) => ({
                category: s.category,
                garmentId:
                  s.garmentRef != null
                    ? (garmentByRef.get(s.garmentRef)?.id ?? null)
                    : null,
              }))
          : undefined;
        const outfit = em.create(Outfit, {
          name: str(o.name),
          notes: str(o.notes),
          slots,
          owner: owner ?? undefined,
        });
        const garments = (o.garmentRefs ?? [])
          .map((ref) => garmentByRef.get(ref))
          .filter((g): g is Garment => !!g);
        outfit.garments.set(garments);
        outfitByRef.set(o.ref, outfit);
        summary.outfits++;
      }

      for (const c of doc.calendar) {
        const outfit = outfitByRef.get(c.outfitRef);
        const day = date(c.date);
        if (!outfit || !day) continue;
        em.create(OutfitCalendar, {
          date: day,
          outfit,
          wornAt: date(c.wornAt),
          notes: str(c.notes),
          owner: owner ?? undefined,
        });
        summary.calendar++;
      }
      await em.flush();
    });

    this.logger.log(
      `Imported ${summary.garments} garments, ${summary.outfits} outfits, ` +
        `${summary.calendar} calendar entries, ${summary.photos} photos (userId=${userId})`,
    );
    return summary;
  }

  private async readFile(fileName: string): Promise<Buffer | null> {
    try {
      const stream = await this.fileService.get(fileName);
      if (!stream) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }
}

/** Wraps raw bytes so they can go through the regular upload storage path. */
function fakeUpload(bytes: Uint8Array): MultipartFile {
  return {
    mimetype: 'image/webp',
    file: Readable.from(Buffer.from(bytes)),
  } as unknown as MultipartFile;
}
