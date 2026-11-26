import { GarmentColor } from '../garment-color.enum';

export interface SearchGarmentDto {
  keyword?: string;
  category?: string;
  color?: GarmentColor;
  brand?: string;
  size?: string;
  archived?: string;
  /** Exact tag match. */
  tag?: string;
  /** 'true' to only show garments waiting to be washed. */
  laundry?: string;
  /** Only show garments not worn in at least this many days. */
  unworn?: string;
}
