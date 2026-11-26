import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import sharp from 'sharp';

/**
 * End-to-end try-on flow against a running server whose TRYON_DIR contains an
 * installed runtime. Real model weights aren't needed: point TRYON_E2E_PYTHON
 * at a Python env with the worker's dependencies and run
 *   python src/tryon/worker.py tiny --models $TRYON_DIR/models
 * to create tiny random models, symlink that env to $TRYON_DIR/venv and write
 * $TRYON_DIR/installed.json. Skipped unless TRYON_E2E_PYTHON is set.
 */
const PYTHON = process.env.TRYON_E2E_PYTHON;
const MODELS = process.env.TRYON_E2E_MODELS;
const REMOTE_PORT = 8199;

test.describe.configure({ mode: 'serial' });
test.skip(!PYTHON || !MODELS, 'set TRYON_E2E_PYTHON and TRYON_E2E_MODELS');
test.skip(
  ({ browserName, isMobile }) => browserName !== 'chromium' || !!isMobile,
  'stateful suite: runs once, in desktop Chromium',
);

const RUN = Date.now().toString(36);
let topId: number;
let shoeId: number;

const png = (w: number, h: number, rgb: [number, number, number]) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  })
    .png()
    .toBuffer();

async function garmentWithPhoto(
  request: APIRequestContext,
  name: string,
  category: string,
  rgb: [number, number, number],
): Promise<number> {
  const res = await request.post('/wardrobe', {
    form: { name, category },
    maxRedirects: 0,
  });
  const id = Number(res.headers()['location'].split('?')[0].split('/').pop());
  const photo = await png(200, 200, rgb);
  await request.post(`/wardrobe/${id}/photo`, {
    multipart: {
      photo: { name: 'g.png', mimeType: 'image/png', buffer: photo },
      nobgPhoto: {
        name: 'n.webp',
        mimeType: 'image/webp',
        buffer: await sharp(photo).webp().toBuffer(),
      },
    },
  });
  return id;
}

async function saveSettings(
  request: APIRequestContext,
  form: Record<string, string>,
) {
  const res = await request.post('/tryon/settings', {
    form: {
      mode: 'local',
      remoteUrl: '',
      remoteToken: '',
      steps: '5',
      guidance: '2.5',
      size: '288x384',
      threads: '0',
      ...form,
    },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
}

async function waitForJob(page: Page, status: string, timeout = 120_000) {
  await expect
    .poll(
      async () => {
        await page.goto('/tryon');
        return page.locator('.tryon-job').first().getAttribute('data-status');
      },
      { timeout, intervals: [2000] },
    )
    .toBe(status);
}

test.afterAll(async ({ request }) => {
  await saveSettings(request, { mode: 'local' });
});

test('settings page shows the installed model', async ({ page, request }) => {
  await saveSettings(request, { mode: 'local' });
  await page.goto('/tryon/settings');
  await expect(page.locator('#install-status')).toHaveAttribute(
    'data-status',
    'installed',
  );
  await expect(page.locator('#install-done')).toBeVisible();
  await expect(page.locator('#mode-local')).toBeChecked();
  const worker = await request.get('/tryon/worker.py');
  expect(await worker.text()).toContain('def cmd_serve');
});

test('renders a try-on locally and skips unsupported garments', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  topId = await garmentWithPhoto(
    request,
    `TryOn Top ${RUN}`,
    'tops',
    [30, 60, 170],
  );
  shoeId = await garmentWithPhoto(
    request,
    `TryOn Shoe ${RUN}`,
    'footwear',
    [90, 50, 30],
  );

  await page.goto(`/tryon?garmentId=${topId}&garmentId=${shoeId}`);
  await expect(
    page.locator(`input[name="garmentId"][value="${topId}"]`),
  ).toBeChecked();
  // Footwear isn't offered at all.
  await expect(
    page.locator(`input[name="garmentId"][value="${shoeId}"]`),
  ).toHaveCount(0);

  await page.setInputFiles('#person-input', {
    name: 'me.png',
    mimeType: 'image/png',
    buffer: await png(300, 400, [210, 190, 170]),
  });
  await page.click('#tryon-submit');
  await expect(page.locator('.tryon-job').first()).toContainText(
    `TryOn Top ${RUN}`,
  );

  await waitForJob(page, 'done');
  const result = page.locator('.tryon-job').first().locator('img.tryon-result');
  await expect(result).toBeVisible();
  const src = await result.getAttribute('src');
  const img = await request.get(src!);
  expect(img.ok()).toBeTruthy();
  const meta = await sharp(await img.body()).metadata();
  // Rendered at 288x384 (3:4); storage may scale it, keeping the ratio.
  expect(meta.width / meta.height).toBeCloseTo(0.75, 2);
});

test('a second try-on can reuse the last photo', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/tryon?garmentId=${topId}`);
  await expect(page.locator('#use-last')).toBeChecked();
  await page.click('#tryon-submit');
  await waitForJob(page, 'done');
  expect(await page.locator('.tryon-job').count()).toBeGreaterThanOrEqual(2);
});

test('selecting only unsupported garments is refused', async ({
  page,
  request,
}) => {
  const res = await request.post('/tryon', {
    multipart: { useLast: '1', garmentId: String(shoeId) },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
  await page.goto(res.headers()['location']);
  await expect(page.locator('#tryon-error')).toContainText('can be tried on');
});

test('remote mode waits for the remote worker, then renders there', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await saveSettings(request, {
    mode: 'remote',
    remoteUrl: `127.0.0.1:${REMOTE_PORT}`,
  });

  await page.goto('/tryon/settings');
  await page.click('#remote-check');
  await expect(page.locator('#remote-offline')).toBeVisible();

  await page.goto(`/tryon?garmentId=${topId}`);
  await page.click('#tryon-submit');
  await expect(page.locator('.tryon-job').first()).toHaveAttribute(
    'data-status',
    'queued',
  );
  await expect
    .poll(
      async () => {
        await page.goto('/tryon');
        return page
          .locator('.tryon-job')
          .first()
          .locator('.tryon-progress')
          .textContent();
      },
      { timeout: 20_000 },
    )
    .toContain('remote renderer to come online');

  let worker: ChildProcess | undefined;
  try {
    worker = spawn(
      PYTHON!,
      [
        'src/tryon/worker.py',
        'serve',
        '--models',
        MODELS!,
        '--host',
        '127.0.0.1',
        '--port',
        String(REMOTE_PORT),
      ],
      { stdio: 'ignore' },
    );
    await page.goto('/tryon/settings');
    await expect
      .poll(
        async () => {
          await page.click('#remote-check');
          return page.locator('#remote-ok').count();
        },
        { timeout: 60_000, intervals: [1500] },
      )
      .toBe(1);
    await waitForJob(page, 'done', 120_000);
  } finally {
    worker?.kill();
  }
});

test('finished jobs can be deleted', async ({ page }) => {
  await page.goto('/tryon');
  const before = await page.locator('.tryon-job').count();
  page.once('dialog', (d) => d.accept());
  await page
    .locator('.tryon-job')
    .first()
    .locator('form[action$="/delete"] button')
    .click();
  await expect(page.locator('.tryon-job')).toHaveCount(before - 1);
});
