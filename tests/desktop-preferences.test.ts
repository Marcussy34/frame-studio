import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createPreferencesStore } from '../desktop/preferences';
import { defaultSettings } from '../shared/composition';

const directories: string[] = [];
async function preferencesPath() {
  const directory = await mkdtemp(join(tmpdir(), 'frame-desktop-preferences-test-'));
  directories.push(directory);
  return join(directory, 'canvas.json');
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('desktop preferences', () => {
  it('uses defaults when settings do not exist or are corrupt', async () => {
    const path = await preferencesPath();
    expect((await createPreferencesStore(path)).read()).toEqual(defaultSettings);
    await writeFile(path, '{broken json');
    expect((await createPreferencesStore(path)).read()).toEqual(defaultSettings);
  });

  it('preserves the latest requested settings across reopening', async () => {
    const path = await preferencesPath();
    const store = await createPreferencesStore(path);
    await Promise.all(
      [55, 70, 95].map((scale) => store.write({ ...defaultSettings, scale, background: 'sage' })),
    );
    await store.flush();
    expect((await createPreferencesStore(path)).read()).toMatchObject({
      scale: 95,
      background: 'sage',
    });
    expect(JSON.parse(await readFile(path, 'utf8')).scale).toBe(95);
  });

  it('rejects invalid settings and keeps the last valid preferences', async () => {
    const path = await preferencesPath();
    const store = await createPreferencesStore(path);
    await store.write({ ...defaultSettings, padding: 18 });
    await expect(
      store.write({ ...defaultSettings, color: 'url(file:///private)' }),
    ).rejects.toThrow();
    expect(store.read().padding).toBe(18);
    expect((await createPreferencesStore(path)).read().padding).toBe(18);
  });
});
