import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const binary =
  process.env.FRAME_DESKTOP_APP ||
  resolve('release/mac-arm64/Frame Studio.app/Contents/MacOS/Frame Studio');

test('the record button opens a dialog listing the available displays', async () => {
  expect(existsSync(binary), 'The standalone desktop app must be built').toBe(true);
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-recorder-'));
  const application = await electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${join(directory, 'profile')}`],
    env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: directory },
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.getByRole('button', { name: 'Record screen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Record your screen' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Display' })).toBeVisible();
    // Every option is visible at once, and the chosen one is marked, so assert on the
    // selection actually landing rather than on any internal markup.
    await expect(page.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true', {
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('recording produces a bundle that loads into the editor', async () => {
  expect(existsSync(binary)).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-record-run-'));
  const profile = join(directory, 'profile');
  const application = await electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: directory },
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: 'Record screen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Record your screen' })).toBeVisible();
    await page.getByRole('button', { name: 'Start recording', exact: true }).click();

    // Three second countdown, then let a little real footage accumulate.
    await page.waitForTimeout(6000);

    // The window is hidden at this point, so finish through the local API the same
    // way the floating stop control ultimately does.
    const stopped = await page.evaluate(async () => {
      const response = await fetch('/api/recording/stop', {
        method: 'POST',
        headers: { 'X-Frame-Studio': '1' },
      });
      return (await response.json()) as { outcome: { id: string; frames: number } | null };
    });
    expect(stopped.outcome).toBeTruthy();
    expect(stopped.outcome!.frames).toBeGreaterThan(0);

    // The bundle survives on disk with all three members.
    const bundles = await readdir(join(profile, 'recordings'));
    expect(bundles).toContain(stopped.outcome!.id);
    const members = await readdir(join(profile, 'recordings', stopped.outcome!.id));
    expect(members.sort()).toEqual(['cursor.jsonl', 'meta.json', 'video.mov']);

    // The editor picks it up and becomes playable.
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
      timeout: 60_000,
    });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the picker can switch to recording a single window', async () => {
  expect(existsSync(binary)).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-window-pick-'));
  const application = await electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${join(directory, 'profile')}`],
    env: { ...process.env, PATH: '/usr/bin:/bin', TMPDIR: directory },
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.getByRole('button', { name: 'Record screen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Record your screen' })).toBeVisible();
    await page.getByRole('button', { name: 'Window', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Window', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Frame Studio is itself an open window, so the list can never be empty here.
    await expect(page.getByRole('radiogroup', { name: 'Window' })).toBeVisible();
    await expect(page.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true', {
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
