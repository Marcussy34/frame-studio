import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultSettings, settingsSchema } from '../shared/composition';
import type { PreferencesStore } from '../shared/types';

export async function createPreferencesStore(path: string): Promise<PreferencesStore> {
  let current = { ...defaultSettings };
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (parsed.success) current = parsed.data;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  let pending = Promise.resolve();
  return {
    read: () => ({ ...current }),
    async write(settings) {
      const next = settingsSchema.parse(settings);
      current = next;
      // Serialize atomic writes so an earlier change cannot overwrite a newer one.
      pending = pending
        .catch(() => {})
        .then(async () => {
          await writeFile(path + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600 });
          await rename(path + '.tmp', path);
        });
      await pending;
    },
    flush: () => pending,
  };
}
