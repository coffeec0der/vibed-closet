import { test, expect, Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * End-to-end coverage for the wardrobe extras: price + tags, wear stats and
 * cost per wear, laundry, tag / unworn filters, outfit shuffle, packing list,
 * automatic photo color, and export / import.
 *
 * Runs against AUTH_ENABLED=false (the default), so everything lives in the
 * shared ownerless wardrobe. Names carry a per-run suffix so reruns against
 * the same database don't collide.
 */
test.describe.configure({ mode: 'serial' });
// The suite mutates wardrobe-wide state (e.g. "laundry done" cleans every
// garment), so parallel runs in other browser projects would interfere.
test.skip(
  ({ browserName, isMobile }) => browserName !== 'chromium' || !!isMobile,
  'stateful suite: runs once, in desktop Chromium',
);

const RUN = Date.now().toString(36);
const TEE = `Extras Tee ${RUN}`;
const JEANS = `Extras Jeans ${RUN}`;
const TAG = `tag${RUN}`;
const today = new Date().toISOString().slice(0, 10);

let teeId: number;
let jeansId: number;
let outfitId: number;

async function createGarment(
  page: Page,
  fields: { name: string; category: string; price: string; tags: string },
): Promise<number> {
  await page.goto('/wardrobe/new');
  await page.fill('input[name="name"]', fields.name);
  await page.fill('input[name="category"]', fields.category);
  await page.fill('input[name="price"]', fields.price);
  await page.fill('input[name="tags"]', fields.tags);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/wardrobe\/\d+/);
  return Number(new URL(page.url()).pathname.split('/').pop());
}

test('garments save price and tags', async ({ page }) => {
  teeId = await createGarment(page, {
    name: TEE,
    category: 'tops',
    price: '20,00',
    tags: `Summer, ${TAG}, summer`,
  });
  jeansId = await createGarment(page, {
    name: JEANS,
    category: 'bottoms',
    price: '€ 60',
    tags: TAG,
  });

  await page.goto(`/wardrobe/${teeId}`);
  // "20,00" is parsed as 20; tags are lower-cased and de-duplicated.
  await expect(page.locator('main')).toContainText('€20.00');
  await expect(page.locator('a.badge', { hasText: '#summer' })).toHaveCount(1);
  await expect(page.locator(`a.badge`, { hasText: `#${TAG}` })).toBeVisible();
  await expect(page.locator('#times-worn')).toHaveText('0');
});

test('tag filter matches exact tags only', async ({ page }) => {
  await page.goto(`/wardrobe?tag=${TAG}`);
  await expect(page.locator('main')).toContainText(TEE);
  await expect(page.locator('main')).toContainText(JEANS);

  await page.goto('/wardrobe?tag=summer');
  await expect(page.locator('main')).toContainText(TEE);
  await expect(page.locator('main')).not.toContainText(JEANS);

  // Prefix of a tag must not match.
  await page.goto('/wardrobe?tag=summ');
  await expect(page.locator('main')).not.toContainText(TEE);
});

test('marking an outfit worn updates stats and fills the laundry', async ({
  page,
}) => {
  const body = new URLSearchParams();
  body.append('name', `Extras Outfit ${RUN}`);
  body.append('category', 'tops');
  body.append('garmentId', String(teeId));
  body.append('category', 'bottoms');
  body.append('garmentId', String(jeansId));
  const created = await page.request.post('/outfits', {
    data: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
  });
  expect(created.status()).toBe(302);
  outfitId = Number(created.headers()['location'].split('/').pop());

  const scheduled = await page.request.post('/calendar', {
    form: { date: today, outfitId: String(outfitId), week: today },
    maxRedirects: 0,
  });
  expect(scheduled.status()).toBe(302);

  // Mark worn through the real calendar UI.
  await page.goto(`/calendar?week=${today}`);
  const entry = page
    .locator(`div:has(> div[onclick*="/outfits/${outfitId}/edit"])`)
    .first();
  await entry.locator('form[action$="/worn"] button').click();
  await expect(entry.locator('form[action$="/worn"] button')).toContainText(
    '✓',
  );

  await page.goto(`/wardrobe/${teeId}`);
  await expect(page.locator('#times-worn')).toHaveText('1');
  await expect(page.locator('#cost-per-wear')).toHaveText('€20.00');
  await expect(page.locator('#laundry-badge')).toBeVisible();

  await page.goto('/laundry');
  await expect(page.locator('main')).toContainText(TEE);
  await expect(page.locator('main')).toContainText(JEANS);

  await page.goto('/wardrobe?laundry=true');
  await expect(page.locator('main')).toContainText(TEE);
});

test('worn garments drop out of the unworn filter', async ({ page }) => {
  await page.goto('/wardrobe?unworn=90');
  await expect(page.locator('main')).not.toContainText(TEE);
});

test('stats page shows wear and value data', async ({ page }) => {
  await page.goto('/stats');
  // Rankings depend on whatever else is in the database, so only check that
  // the sections render and that the just-worn tee isn't listed as unworn.
  await expect(page.locator('#stats-totals')).toBeVisible();
  await expect(page.locator('#most-worn')).toBeVisible();
  await expect(page.locator('#best-value')).toBeVisible();
  const unworn = page.locator('#unworn-list');
  if (await unworn.count()) await expect(unworn).not.toContainText(TEE);
});

test('packing list includes scheduled garments', async ({ page }) => {
  await page.goto(`/calendar/packing?from=${today}&to=${today}`);
  await expect(page.locator('#packing-list')).toContainText(TEE);
  await expect(page.locator('#packing-list')).toContainText(JEANS);
  // Checked state survives a reload (localStorage).
  const box = page
    .locator('label', { hasText: TEE })
    .locator('input.packing-check');
  await box.check();
  await page.reload();
  await expect(box).toBeChecked();
});

test('shuffle skips laundry and laundry can be emptied', async ({ page }) => {
  // Both test garments are dirty, so shuffle must never pick them.
  for (let i = 0; i < 5; i++) {
    await page.goto('/outfits/new?shuffle=1');
    const ids = await page
      .locator('input[name="garmentId"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(ids).not.toContain(String(teeId));
    expect(ids).not.toContain(String(jeansId));
  }

  await page.goto('/laundry');
  await page.click('#laundry-done');
  await expect(page.locator('#laundry-empty')).toBeVisible();

  await page.goto(`/wardrobe/${teeId}`);
  await expect(page.locator('#laundry-badge')).toHaveCount(0);
  await page.click('#laundry-toggle');
  await expect(page.locator('#laundry-badge')).toBeVisible();
  await page.click('#laundry-toggle');
  await expect(page.locator('#laundry-badge')).toHaveCount(0);

  // Now clean: shuffle offers a builder with a "Shuffle" button.
  await page.goto('/outfits/new');
  await expect(page.locator('#shuffle-outfit')).toBeVisible();
});

test('uploading a photo auto-detects the garment color', async ({ page }) => {
  // A red square with a transparent border, like a background-removed shot.
  const red = await sharp({
    create: {
      width: 200,
      height: 200,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 120,
            height: 120,
            channels: 4,
            background: { r: 205, g: 25, b: 35, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
        top: 40,
        left: 40,
      },
    ])
    .png()
    .toBuffer();

  const res = await page.request.post(`/wardrobe/${jeansId}/photo`, {
    multipart: {
      photo: { name: 'red.png', mimeType: 'image/png', buffer: red },
    },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/wardrobe/${jeansId}`);
  await expect(page.locator('main')).toContainText(/Color\s*red/i);
});

test('export then import round-trips the wardrobe', async ({ page }) => {
  // Import re-encodes every photo; on a long-lived dev database (each run
  // doubles it) that can take a while.
  test.setTimeout(120_000);
  await page.goto('/backup');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-btn'),
  ]);
  const zipPath = await download.path();
  expect(download.suggestedFilename()).toMatch(/^libre-closet-.*\.zip$/);

  await page.setInputFiles('#import-file', zipPath);
  await page.click('#import-btn');
  await expect(page.locator('#import-success')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.locator('#import-success')).toContainText(/\d+/);

  // Imported copies exist alongside the originals, with price, tags and photo.
  await page.goto(`/wardrobe?keyword=${encodeURIComponent(TEE)}`);
  await expect(page.locator('main a.card', { hasText: TEE })).toHaveCount(2);
  await page.goto(`/wardrobe?keyword=${encodeURIComponent(JEANS)}`);
  const jeansCards = page.locator('main a.card', { hasText: JEANS });
  await expect(jeansCards).toHaveCount(2);
  await expect(jeansCards.locator('img')).toHaveCount(2);

  // Worn history came along: both tees (original + copy) show 1 wear.
  const hrefs = await page
    .locator('main a.card', { hasText: JEANS })
    .evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  for (const href of hrefs) {
    await page.goto(href!);
    await expect(page.locator('#times-worn')).toHaveText('1');
    await expect(page.locator('main')).toContainText('€60.00');
  }
});

test('import rejects files that are not exports', async ({ page }) => {
  await page.goto('/backup');
  await page.setInputFiles('#import-file', {
    name: 'nope.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('definitely not a zip'),
  });
  await page.click('#import-btn');
  await expect(page.locator('#import-error')).toContainText(
    'Not a valid zip file',
  );
});
