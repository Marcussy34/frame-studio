import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { startDesktopRuntime } from '../desktop/runtime';
import { defaultSettings } from '../shared/composition';

it('serves desktop preferences and removes only temporary session files on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frame-desktop-runtime-test-'));
  const renderer = join(root, 'renderer');
  const preferences = join(root, 'profile', 'canvas.json');
  await mkdir(renderer);
  await writeFile(join(renderer, 'index.html'), '<!doctype html><title>Frame Studio</title>');
  const runtime = await startDesktopRuntime({
    rendererPath: renderer,
    preferencesPath: preferences,
    sessionRoot: root,
  });
  try {
    const response = await fetch(runtime.origin);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    const session = await (await fetch(runtime.origin + '/api/session')).json();
    expect(session.preferences).toEqual(defaultSettings);
    const updated = await fetch(runtime.origin + '/api/preferences', {
      method: 'PUT',
      headers: { 'X-Frame-Studio': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...defaultSettings, background: 'ocean' }),
    });
    expect(updated.status).toBe(200);
    expect(JSON.parse(await readFile(preferences, 'utf8')).background).toBe('ocean');
    await runtime.close({ ...defaultSettings, background: 'sage' });
    expect(
      (await readdir(root)).some((name) => name.startsWith('frame-studio-desktop-session-')),
    ).toBe(false);
    expect(JSON.parse(await readFile(preferences, 'utf8')).background).toBe('sage');
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a missing renderer without leaving a session directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frame-desktop-runtime-test-'));
  let unexpected: Awaited<ReturnType<typeof startDesktopRuntime>> | undefined;
  try {
    await expect(
      startDesktopRuntime({
        rendererPath: join(root, 'missing'),
        preferencesPath: join(root, 'canvas.json'),
        sessionRoot: root,
      }).then((value) => {
        unexpected = value;
        return value;
      }),
    ).rejects.toThrow();
    expect(
      (await readdir(root)).some((name) => name.startsWith('frame-studio-desktop-session-')),
    ).toBe(false);
  } finally {
    await unexpected?.close();
    await rm(root, { recursive: true, force: true });
  }
});
