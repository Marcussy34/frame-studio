import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { probeVideo } from '../server/media';

let directory: string;
let source: string;
let longSource: string;
const execute = promisify(execFile);
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frame-studio-browser-test-'));
  source = join(directory, 'mac-recording.mov');
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x405779:s=640x360:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    source,
  ]);
  longSource = join(directory, 'long-recording.mov');
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=30:d=15',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    longSource,
  ]);
});
test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function openStudio(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('video-input')).toBeEnabled();
  const back = page.getByRole('button', { name: 'Back to editor' });
  if (await back.isVisible()) await back.click();
}

test('import, restyle, play, export, and download an actual MP4', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openStudio(page);
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeDisabled();
  await page.getByTestId('video-input').setInputFiles(source);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Square 1:1' }).click();
  await page.getByRole('button', { name: 'Sage background' }).click();
  await page.getByRole('slider', { name: 'Padding', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await page.getByRole('combobox', { name: 'Resolution' }).click();
  await page.getByRole('option', { name: /720p/ }).click();
  await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
  const link = page.getByRole('link', { name: 'Download MP4' });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const downloadEvent = page.waitForEvent('download');
  await link.click();
  const download = await downloadEvent;
  const output = join(directory, 'browser-export.mp4');
  await download.saveAs(output);
  const meta = await probeVideo(output);
  expect(meta).toMatchObject({ width: 720, height: 720, hasAudio: true });
  expect(meta.duration).toBeCloseTo(3, 1);
  await page.getByRole('button', { name: 'Back to editor' }).click();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Download MP4' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to editor' }).click();
  await expect(page.getByRole('button', { name: 'Square 1:1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Sage background' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('invalid imports show an error and keep the previous recording usable', async ({ page }) => {
  await openStudio(page);
  await page.getByTestId('video-input').setInputFiles(source);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByTestId('video-input').setInputFiles({
    name: 'broken.mov',
    mimeType: 'video/quicktime',
    buffer: Buffer.from('invalid video'),
  });
  await expect(page.getByRole('alert')).toContainText('could not read this video');
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeEnabled();
});

test('the inspector stays usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStudio(page);
  await page.getByRole('button', { name: 'Portrait 9:16' }).click();
  await expect(page.getByRole('button', { name: 'Portrait 9:16' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('cancel an export and retry with original audio disabled', async ({ page }) => {
  await openStudio(page);
  await page.getByTestId('video-input').setInputFiles(source);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await page.getByRole('combobox', { name: 'Resolution' }).click();
  await page.getByRole('option', { name: /4K/ }).click();
  await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Export cancelled');
  await page.getByRole('combobox', { name: 'Resolution' }).click();
  await page.getByRole('option', { name: /720p/ }).click();
  await page.getByRole('switch', { name: 'Include original audio' }).click();
  await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
  const link = page.getByRole('link', { name: 'Download MP4' });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const downloadEvent = page.waitForEvent('download');
  await link.click();
  const download = await downloadEvent;
  const output = join(directory, 'muted-browser-export.mp4');
  await download.saveAs(output);
  expect((await probeVideo(output)).hasAudio).toBe(false);
});

test('refreshing an export restores cancellation and the recovered download', async ({ page }) => {
  await openStudio(page);
  await page.getByTestId('video-input').setInputFiles(longSource);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await page.getByRole('combobox', { name: 'Resolution' }).click();
  await page.getByRole('option', { name: /4K/ }).click();
  await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel export', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('progressbar', { name: 'Export progress' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Export cancelled');
  await page.getByRole('combobox', { name: 'Resolution' }).click();
  await page.getByRole('option', { name: /720p/ }).click();
  await page.getByRole('button', { name: 'Export MP4', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel export', exact: true })).toBeVisible();
  await page.reload();
  const link = page.getByRole('link', { name: 'Download MP4' });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const downloadEvent = page.waitForEvent('download');
  await link.click();
  const download = await downloadEvent;
  const output = join(directory, 'recovered.mp4');
  await download.saveAs(output);
  expect((await probeVideo(output)).duration).toBeCloseTo(15, 1);
});
