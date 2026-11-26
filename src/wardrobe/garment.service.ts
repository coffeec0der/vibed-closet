import { EntityRepository, FilterQuery } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { Garment } from '../dal/entity/garment.entity';
import { File } from '../dal/entity/file.entity';
import { User } from '../dal/entity/user.entity';
import { FileService } from '../file/file-service.abstract';
import { MultipartFile } from '@fastify/multipart';
import { CreateGarmentDto } from './dto/create-garment.dto';
import { UpdateGarmentDto } from './dto/update-garment.dto';
import { SearchGarmentDto } from './dto/search-garment.dto';
import { GarmentCategory } from './garment-category.enum';
import { WardrobeShareService } from '../wardrobe-share/wardrobe-share.service';
import { Readable } from 'node:stream';
import { detectDominantColor } from './dominant-color.util';
import { GarmentColor } from './garment-color.enum';

const CANONICAL_SIZES = [
  'XX-Small',
  'X-Small',
  'Small',
  'Medium',
  'Large',
  'X-Large',
  'XX-Large',
  '3X-Large',
  '4X-Large',
  '5X-Large',
];

@Injectable()
export class GarmentService {
  private readonly logger = new Logger(GarmentService.name);

  constructor(
    @InjectRepository(Garment)
    private readonly garmentRepository: EntityRepository<Garment>,
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    private readonly fileService: FileService,
    private readonly shareService: WardrobeShareService,
  ) {}

  resolveCategoryLabel(value: string, i18n: I18nContext): string {
    const normalized = value.toLowerCase();
    if ((Object.values(GarmentCategory) as string[]).includes(normalized)) {
      return i18n.t(`lang.CATEGORY_${normalized.toUpperCase()}`);
    }
    return value;
  }

  async findAll(
    userId?: number,
    dto: SearchGarmentDto = {},
    viewOwner?: number,
  ): Promise<Garment[]> {
    const normalizedSize = this.normalizeSize(dto.size);
    const searchConditions: FilterQuery<Garment> = {
      ...(dto.category ? { category: dto.category } : {}),
      ...(dto.color ? { color: dto.color } : {}),
      ...(normalizedSize ? { size: normalizedSize } : {}),
      ...(dto.archived !== 'true' ? { archived: false } : {}),
      ...(dto.laundry === 'true' ? { inLaundry: true } : {}),
      ...(dto.tag ? { tags: { $like: `%${dto.tag}%` } } : {}),
      ...(dto.keyword
        ? {
            $or: [
              { name: { $like: `%${dto.keyword}%` } },
              { notes: { $like: `%${dto.keyword}%` } },
              { brand: { $like: `%${dto.keyword}%` } },
            ],
          }
        : {}),
    };

    let ownerCondition: FilterQuery<Garment>;
    if (userId != null) {
      ownerCondition =
        viewOwner != null && viewOwner !== userId
          ? { owner: { id: viewOwner } }
          : { owner: { id: userId } };
    } else {
      // AUTH_ENABLED=false: only return garments that belong to no user
      ownerCondition = { owner: null };
    }
    const garments = await this.garmentRepository.find(
      { ...ownerCondition, ...searchConditions },
      { populate: ['photo'], orderBy: { id: 'DESC' } },
    );
    if (!dto.tag) return garments;
    // LIKE narrows the query; this enforces an exact tag match ("work" must
    // not match "workout").
    const wanted = dto.tag.trim().toLowerCase();
    return garments.filter((g) =>
      GarmentService.splitTags(g.tags).includes(wanted),
    );
  }

  /** Splits a stored comma-separated tag string into normalized tags. */
  static splitTags(tags?: string | null): string[] {
    if (!tags) return [];
    return tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }

  /** Normalizes free-form tag input into a stored comma-separated string. */
  static normalizeTags(input?: string | string[]): string | undefined {
    if (input == null) return undefined;
    const raw = Array.isArray(input) ? input.join(',') : input;
    const tags = [...new Set(GarmentService.splitTags(raw))];
    return tags.length ? tags.join(',') : undefined;
  }

  /** Parses a price form value; accepts "12.50", "12,50" and "€ 12". */
  static parsePrice(input?: string | number | null): number | undefined {
    if (input == null || input === '') return undefined;
    if (typeof input === 'number') {
      return Number.isFinite(input) && input >= 0 ? input : undefined;
    }
    let cleaned = input.replace(/[^\d.,-]/g, '');
    // Whichever of '.' / ',' comes last is the decimal separator; the other
    // one is a thousands separator ("1.234,56" and "1,234.56" -> 1234.56).
    const decimalSep =
      cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.') ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    cleaned = cleaned.split(thousandsSep).join('').replace(decimalSep, '.');
    const value = parseFloat(cleaned);
    return Number.isFinite(value) && value >= 0
      ? Math.round(value * 100) / 100
      : undefined;
  }

  async findOne(
    id: number,
    userId?: number,
    viewOwner?: number,
  ): Promise<Garment> {
    const garment = await this.garmentRepository.findOne(id, {
      populate: ['photo', 'outfits'],
    });
    if (!garment) throw new NotFoundException('Garment not found');
    if (userId != null) {
      if (garment.owner?.id === userId) return garment;
      if (viewOwner != null && garment.owner?.id === viewOwner) {
        if (await this.shareService.canView(userId, viewOwner)) {
          return garment;
        }
      }
      throw new ForbiddenException();
    } else {
      if (garment.owner != null) throw new ForbiddenException();
    }
    return garment;
  }

  async findOneByShareableId(shareableId: string): Promise<Garment> {
    const garment = await this.garmentRepository.findOne(
      { shareableId },
      { populate: ['photo'] },
    );
    if (!garment) throw new NotFoundException('Garment not found');
    return garment;
  }

  async create(dto: CreateGarmentDto, userId?: number): Promise<Garment> {
    let photo: File | undefined = undefined;
    if (dto.files) {
      for await (const file of dto.files) {
        if (file.fieldname === 'photo') {
          photo = await this.fileService.storeImageFromFileUpload(file, userId);
        } else {
          file.file.resume();
        }
      }
    }

    const garment = this.garmentRepository.create({
      name: dto.name,
      category: dto.category,
      brand: dto.brand,
      color: dto.color,
      size: this.normalizeSize(dto.size),
      notes: dto.notes,
      washingDetails: dto.washingDetails,
      dateAquired: dto.dateAquired ? new Date(dto.dateAquired) : undefined,
      price: GarmentService.parsePrice(dto.price),
      tags: GarmentService.normalizeTags(dto.tags),
      photo: photo ?? undefined,
    });

    if (userId != null) {
      const user = await this.userRepository.findOneOrFail(userId);
      garment.owner = user as any;
    }

    await this.garmentRepository.getEntityManager().persistAndFlush(garment);
    return garment;
  }

  async clone(
    sourceId: number,
    dto: {
      name?: string;
      category: string;
      brand?: string;
      color?: string;
      size?: string;
      notes?: string;
      price?: string | number;
      tags?: string | string[];
    },
    userId?: number,
  ): Promise<Garment> {
    const source = await this.garmentRepository.findOne(sourceId, {
      populate: ['photo'],
    });
    if (!source) throw new NotFoundException('Garment not found');

    let photo: File | undefined;
    if (source.photo?.fileName) {
      photo = await this.fileService.copyImage(source.photo.fileName, userId);
      if (photo) {
        const nobgSourceName = this.fileService.nobgFileName(
          source.photo.fileName,
        );
        const nobgStream = await this.fileService
          .get(nobgSourceName)
          .catch(() => undefined);
        if (nobgStream) {
          await this.fileService
            .storeNobgVariantFromStream(nobgStream, photo.fileName)
            .catch((err) => this.logger.warn(err));
        }
      }
    }

    const garment = this.garmentRepository.create({
      name: dto.name,
      category: dto.category,
      brand: dto.brand,
      color: dto.color as any,
      size: this.normalizeSize(dto.size),
      notes: dto.notes,
      washingDetails: source.washingDetails,
      price: GarmentService.parsePrice(dto.price) ?? source.price,
      tags: GarmentService.normalizeTags(dto.tags) ?? source.tags,
      photo: photo ?? undefined,
    });

    if (userId != null) {
      const user = await this.userRepository.findOneOrFail(userId);
      garment.owner = user as any;
    }

    await this.garmentRepository.getEntityManager().persistAndFlush(garment);
    return garment;
  }

  async findAvailableFilters(userId?: number): Promise<{
    brands: string[];
    sizes: string[];
    categories: string[];
    tags: string[];
  }> {
    const where = userId != null ? { owner: { id: userId } } : { owner: null };
    const garments = await this.garmentRepository.find(where);

    const brands = [
      ...new Set(garments.map((g) => g.brand).filter(Boolean) as string[]),
    ].sort();
    const allSizes = [
      ...new Set(garments.map((g) => g.size).filter(Boolean) as string[]),
    ];
    const sizes = allSizes.sort((a, b) => {
      const ai = CANONICAL_SIZES.indexOf(a);
      const bi = CANONICAL_SIZES.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    const categories = [
      ...new Set(garments.map((g) => g.category).filter(Boolean)),
    ].sort();

    const tags = [
      ...new Set(garments.flatMap((g) => GarmentService.splitTags(g.tags))),
    ].sort();

    return { brands, sizes, categories, tags };
  }

  async update(
    id: number,
    dto: UpdateGarmentDto,
    userId?: number,
    requestingUserId?: number,
  ): Promise<Garment> {
    let photo: File | undefined;
    if (dto.files) {
      // Process file uploads BEFORE any async DB operations.
      // @fastify/multipart yields live streams; if a stream isn't consumed,
      // the parser backpressures and the async iterator hangs. Each file's
      // pipeline must be started (not awaited) inside the loop so busboy can
      // advance to the next part.
      //
      // IMPORTANT: photo and nobgPhoto pipelines must be started concurrently,
      // not sequentially. Both come from the same multipart request body —
      // awaiting one before starting the other would hang the iterator.
      let photoPromise: Promise<File> | undefined;
      let nobgPromise: Promise<void> | undefined;
      const photoFileName = `${randomUUID()}.webp`;

      for await (const file of dto.files) {
        if (file.fieldname === 'photo') {
          photoPromise = this.fileService.storeImageFromFileUpload(
            file,
            userId,
            photoFileName,
          );
        } else if (file.fieldname === 'nobgPhoto') {
          nobgPromise = this.fileService.storeNobgVariantFromStream(
            file.file,
            photoFileName,
          );
        } else {
          file.file.resume();
        }
      }

      if (photoPromise) {
        [photo] = await Promise.all([
          photoPromise,
          nobgPromise ?? Promise.resolve(),
        ]);
      }
    }

    const garment = await this.findOne(id, requestingUserId, userId);

    if (photo) {
      await this.deleteOldPhoto(garment);
      garment.photo = photo as any;
      if (!garment.color) {
        garment.color = await this.detectPhotoColor(photo.fileName);
      }
    }

    garment.name = dto.name ?? garment.name;
    garment.category = dto.category ?? garment.category;
    if ('brand' in dto) garment.brand = dto.brand;
    if ('color' in dto) garment.color = dto.color;
    if ('size' in dto) garment.size = this.normalizeSize(dto.size);
    if ('notes' in dto) garment.notes = dto.notes;
    if ('washingDetails' in dto) garment.washingDetails = dto.washingDetails;
    if ('dateAquired' in dto)
      garment.dateAquired = dto.dateAquired
        ? new Date(dto.dateAquired)
        : undefined;
    if ('price' in dto) garment.price = GarmentService.parsePrice(dto.price);
    if ('tags' in dto) garment.tags = GarmentService.normalizeTags(dto.tags);

    await this.garmentRepository.getEntityManager().flush();
    return garment;
  }

  /**
   * Best-effort dominant color for a stored photo. Prefers the background-
   * removed variant (transparent pixels are ignored). Never throws.
   */
  private async detectPhotoColor(
    photoFileName: string,
  ): Promise<GarmentColor | undefined> {
    for (const name of [
      this.fileService.nobgFileName(photoFileName),
      photoFileName,
    ]) {
      try {
        const stream = await this.fileService.get(name);
        if (!stream) continue;
        const color = await detectDominantColor(await streamToBuffer(stream));
        if (color) return color;
      } catch {
        // variant missing or unreadable - try the next one
      }
    }
    return undefined;
  }

  private async deleteOldPhoto(garment: Garment) {
    const oldFileName = garment.photo?.fileName;
    if (oldFileName) {
      await this.fileService
        .delete(oldFileName)
        .catch((err) => this.logger.warn(err));
      const nobgFileName = this.fileService.nobgFileName(oldFileName);
      await this.fileService
        .delete(nobgFileName)
        .catch((err) => this.logger.warn(err));
    }
  }

  async updateNobg(
    id: number,
    nobgPhoto: MultipartFile | undefined,
    userId?: number,
    requestingUserId?: number,
  ): Promise<void> {
    const garment = await this.findOne(id, requestingUserId, userId);
    if (!garment.photo?.fileName) return;
    await this.streamNobgIfPresent(nobgPhoto, garment.photo.fileName);
  }

  private streamNobgIfPresent(
    nobgPhoto: MultipartFile | undefined,
    photoFileName: string,
  ): Promise<void> {
    if (!nobgPhoto) return Promise.resolve();
    const fileStream = nobgPhoto.file;
    return this.fileService.storeNobgVariantFromStream(
      fileStream,
      photoFileName,
    );
  }

  async remove(id: number, userId?: number): Promise<void> {
    const garment = await this.findOne(id, userId);
    await this.garmentRepository.getEntityManager().removeAndFlush(garment);
  }

  async archive(id: number, userId?: number): Promise<Garment> {
    const garment = await this.findOne(id, userId);
    garment.archived = !garment.archived;
    await this.garmentRepository.getEntityManager().flush();
    return garment;
  }

  async toggleLaundry(id: number, userId?: number): Promise<Garment> {
    const garment = await this.findOne(id, userId);
    garment.inLaundry = !garment.inLaundry;
    await this.garmentRepository.getEntityManager().flush();
    return garment;
  }

  /** Marks every garment of the owner as clean. Returns how many changed. */
  async markAllClean(userId?: number): Promise<number> {
    const where: FilterQuery<Garment> =
      userId != null
        ? { owner: { id: userId }, inLaundry: true }
        : { owner: null, inLaundry: true };
    return this.garmentRepository.nativeUpdate(where, { inLaundry: false });
  }

  private normalizeSize(input?: string): string | undefined {
    if (!input) return undefined;
    const s = input
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '');
    if (['xxxxxl', '5xl', '5xlarge', 'xxxxxlarge'].includes(s))
      return '5X-Large';
    if (['xxxxl', '4xl', '4xlarge', 'xxxxlarge'].includes(s)) return '4X-Large';
    if (['xxxl', '3xl', '3xlarge', 'xxxlarge'].includes(s)) return '3X-Large';
    if (['xxl', '2xl', '2xlarge', 'xxlarge'].includes(s)) return 'XX-Large';
    if (['xl', 'xlarge'].includes(s)) return 'X-Large';
    if (['l', 'large'].includes(s)) return 'Large';
    if (['m', 'medium'].includes(s)) return 'Medium';
    if (['s', 'small'].includes(s)) return 'Small';
    if (['xs', 'xsmall'].includes(s)) return 'X-Small';
    if (['xxs', '2xs', '2xsmall', 'xxsmall'].includes(s)) return 'XX-Small';
    return input.trim();
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
