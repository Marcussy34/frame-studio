import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { canvasStorageKey, defaultSettings } from '../shared/composition';
import { _electron as electron, expect, test } from '@playwright/test';

const binary =
  process.env.FRAME_DESKTOP_APP ||
  resolve('release/mac-arm64/Frame Studio.app/Contents/MacOS/Frame Studio');
const execute = promisify(execFile);

test('packaged app imports, exports with bundled tools, saves, and remembers its canvas', async () => {
  expect(existsSync(binary), 'The standalone desktop app must be built').toBe(true);
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-app-test-'));
  const source = join(directory, 'mac-recording.mov');
  const output = join(directory, 'framed.mp4');
  const userData = join(directory, 'profile');
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    source,
  ]);
  const launch = () =>
    electron.launch({
      executablePath: binary,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: directory },
    });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const chooserEvent = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import video', exact: true }).click();
    await (await chooserEvent).setFiles(source);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Square 1:1' }).click();
    await page.getByRole('button', { name: 'Sage background' }).click();
    await expect
      .poll(
        async () => JSON.parse(await readFile(join(userData, 'canvas.json'), 'utf8')).background,
      )
      .toBe('sage');
    await page.getByRole('button', { name: 'Export video', exact: true }).click();
    await page.getByRole('combobox', { name: 'Resolution' }).click();
    await page.getByRole('option', { name: /720p/ }).click();
    await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Download MP4' })).toBeVisible({ timeout: 30_000 });
    // Intercept the native save choice while still exercising the real download.
    await application.evaluate(({ session }, savePath) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(savePath);
        item.once('done', (_event, state) => {
          (globalThis as unknown as { downloadState: string }).downloadState = state;
        });
      });
    }, output);
    await page.getByRole('link', { name: 'Download MP4' }).click();
    await expect
      .poll(() =>
        application!.evaluate(
          () => (globalThis as unknown as { downloadState?: string }).downloadState,
        ),
      )
      .toBe('completed');
    const meta = JSON.parse(
      (
        await execute('ffprobe', [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          output,
        ])
      ).stdout,
    );
    expect(
      meta.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video'),
    ).toMatchObject({ width: 720, height: 720 });
    expect(
      meta.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'),
    ).toBe(true);
    expect(Number(meta.format.duration)).toBeCloseTo(2, 1);
    expect(errors).toEqual([]);
    await application.close();
    application = undefined;
    expect(
      (await readdir(directory)).some((name) => name.startsWith('frame-studio-desktop-session-')),
    ).toBe(false);
    application = await launch();
    const reopened = await application.firstWindow();
    await expect(reopened.getByRole('button', { name: 'Sage background' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(reopened.getByRole('button', { name: 'Square 1:1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a delayed preference request cannot overwrite a newer canvas choice', async () => {
  expect(existsSync(binary)).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-preference-race-'));
  const profile = join(directory, 'profile');
  const application = await electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: directory },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Dusk background' })).toBeEnabled();
    await page.route('**/api/preferences', async (route) => {
      // Model a slow first request while the user makes a second edit.
      if (route.request().postDataJSON().background === 'dusk')
        await new Promise((resolve) => setTimeout(resolve, 750));
      await route.continue();
    });
    const duskSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/preferences') &&
        response.request().postDataJSON().background === 'dusk',
    );
    const sageSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/preferences') &&
        response.request().postDataJSON().background === 'sage',
    );
    await page.getByRole('button', { name: 'Dusk background' }).click();
    await page.getByRole('button', { name: 'Sage background' }).click();
    await Promise.all([duskSaved, sageSaved]);
    expect(JSON.parse(await readFile(join(profile, 'canvas.json'), 'utf8')).background).toBe(
      'sage',
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('quitting while a save is pending preserves the latest visible canvas', async () => {
  expect(existsSync(binary)).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-quit-save-'));
  const profile = join(directory, 'profile');
  const application = await electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: directory },
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Dusk background' })).toBeEnabled();
    await page.route('**/api/preferences', async (route) => {
      const response = await route.fetch();
      if (route.request().postDataJSON().background === 'dusk') await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole('button', { name: 'Dusk background' }).click();
    await expect
      .poll(async () => JSON.parse(await readFile(join(profile, 'canvas.json'), 'utf8')).background)
      .toBe('dusk');
    await page.getByRole('button', { name: 'Sage background' }).click();
    await application.close();
    release();
    expect(JSON.parse(await readFile(join(profile, 'canvas.json'), 'utf8')).background).toBe(
      'sage',
    );
  } finally {
    release();
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('custom gradients, patterns, and image backgrounds work in the desktop export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-background-test-'));
  const source = join(directory, 'recording.mov');
  const wallpaper = join(directory, 'wallpaper.png');
  const output = join(directory, 'background-export.mp4');
  let releaseImage: () => void = () => {};
  const imageHeld = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x180:r=24:d=1',
    '-c:v',
    'libx264',
    source,
  ]);
  await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff0000' } })
    .png()
    .toFile(wallpaper);
  const application = await electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${join(directory, 'profile')}`],
    env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: directory },
  });
  try {
    const page = await application.firstWindow();
    await page.getByTestId('video-input').setInputFiles(source);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Customize colors' }).click();
    await page.getByLabel('Gradient start color').fill('#0033ff');
    await page.getByRole('button', { name: 'radial', exact: true }).click();
    await expect(page.getByRole('button', { name: 'radial', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Pattern', exact: true }).click();
    await page.getByRole('button', { name: 'Dots pattern' }).click();
    await expect(page.getByRole('button', { name: 'Dots pattern' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await page.route('**/api/background', async (route) => {
      await imageHeld;
      await route.continue().catch(() => {});
    });
    await page.getByTestId('background-image-input').setInputFiles(wallpaper);
    await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeDisabled();
    releaseImage();
    await expect(page.getByAltText('Selected background')).toBeVisible();
    await page.getByRole('button', { name: 'Export video', exact: true }).click();
    await page.getByRole('combobox', { name: 'Resolution' }).click();
    await page.getByRole('option', { name: /720p/ }).click();
    await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Download MP4' })).toBeVisible({ timeout: 30_000 });
    await application.evaluate(({ session }, savePath) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(savePath);
        item.once('done', (_event, state) => {
          (globalThis as unknown as { downloadState: string }).downloadState = state;
        });
      });
    }, output);
    await page.getByRole('link', { name: 'Download MP4' }).click();
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as unknown as { downloadState?: string }).downloadState,
        ),
      )
      .toBe('completed');
    const frame = join(directory, 'frame.png');
    await execute('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      output,
      '-frames:v',
      '1',
      frame,
    ]);
    const pixel = await sharp(frame)
      .extract({ left: 10, top: 10, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(pixel[0]).toBeGreaterThan(220);
    expect(pixel[1]).toBeLessThan(30);
  } finally {
    releaseImage();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('quitting before preferences load keeps the saved canvas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-early-quit-'));
  const profile = join(directory, 'profile');
  await mkdir(profile);
  await writeFile(
    join(profile, 'canvas.json'),
    JSON.stringify({ ...defaultSettings, background: 'sage' }),
  );
  const application = await electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: directory },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Sage background' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.evaluate((key) => localStorage.removeItem(key), canvasStorageKey);
    await page.route('**/api/session', () => {});
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Import video', exact: true })).toBeDisabled();
    await application.close();
    expect(JSON.parse(await readFile(join(profile, 'canvas.json'), 'utf8')).background).toBe(
      'sage',
    );
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
