import { MultipartFile } from '@fastify/multipart';
export interface CreateGarmentDto {
  name?: string;
  category: string;
  brand?: string;
  color?: string;
  size?: string;
  notes?: string;
  washingDetails?: string;
  dateAquired?: string;
  price?: string | number;
  tags?: string | string[];
  files?: AsyncIterableIterator<MultipartFile>;
}
