import type { TryOnPass } from '../dal/entity/try-on-job.entity';

export type TryOnCategory = TryOnPass['category'];

const KEYWORDS: [TryOnCategory, RegExp][] = [
  // Checked in order: "overall" first so "jumpsuit" isn't read as "suit".
  ['overall', /\b(dress(es)?|jumpsuits?|overalls?|rompers?|gowns?|onesies?)\b/],
  [
    'lower',
    /\b(bottoms?|pants|trousers|jeans|shorts|skirts?|leggings|chinos|joggers|sweatpants)\b/,
  ],
  [
    'upper',
    /\b(tops?|shirts?|t-?shirts?|tees?|blouses?|sweaters?|jumpers?|hoodies?|cardigans?|jackets?|coats?|blazers?|outerwear|polos?|vests?|tank ?tops?|knitwear|sweatshirts?|parkas?)\b/,
  ],
];

/**
 * Maps a garment category to the body region the try-on model repaints, or
 * null when the garment can't be tried on (shoes, bags, accessories, ...).
 */
export function tryOnCategory(category: string): TryOnCategory | null {
  const c = category.trim().toLowerCase();
  for (const [region, pattern] of KEYWORDS) {
    if (pattern.test(c)) return region;
  }
  return null;
}

/**
 * Orders garments into render passes. Full-body pieces go first, then bottoms,
 * then tops, and outer layers (coats, jackets) last so they end up on top.
 * Garments that can't be tried on are returned separately.
 */
export function planPasses(garments: { id: number; category: string }[]): {
  passes: TryOnPass[];
  skipped: { id: number; category: string }[];
} {
  const rank = (g: { category: string }, region: TryOnCategory) => {
    if (region === 'overall') return 0;
    if (region === 'lower') return 1;
    return /outerwear|coat|jacket|blazer|parka|cardigan/i.test(g.category)
      ? 3
      : 2;
  };
  const passes: (TryOnPass & { rank: number; index: number })[] = [];
  const skipped: { id: number; category: string }[] = [];
  garments.forEach((g, index) => {
    const region = tryOnCategory(g.category);
    if (!region) {
      skipped.push(g);
      return;
    }
    passes.push({
      garmentId: g.id,
      category: region,
      rank: rank(g, region),
      index,
    });
  });
  passes.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return {
    passes: passes.map(({ garmentId, category }) => ({ garmentId, category })),
    skipped,
  };
}

/**
 * Parses one line of worker stdout. Returns null for lines that aren't part
 * of the protocol (library warnings etc.).
 */
export function parseWorkerLine(
  line: string,
):
  | { type: 'progress'; stage: string; current: number; total: number }
  | { type: 'log'; message: string }
  | { type: 'done'; path: string }
  | { type: 'error'; message: string }
  | null {
  const trimmed = line.trim();
  let m = /^PROGRESS (\S+) (\d+) (\d+)$/.exec(trimmed);
  if (m) {
    return {
      type: 'progress',
      stage: m[1],
      current: Number(m[2]),
      total: Number(m[3]),
    };
  }
  m = /^(LOG|DONE|ERROR) (.*)$/.exec(trimmed);
  if (!m) return null;
  if (m[1] === 'LOG') return { type: 'log', message: m[2] };
  if (m[1] === 'DONE') return { type: 'done', path: m[2] };
  return { type: 'error', message: m[2] };
}
