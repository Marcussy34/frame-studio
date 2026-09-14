import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { bundlePaths, isBundleId, parseRecordingMeta } from '../shared/recording';

export interface RecordingSummary {
  id: string;
  createdAt: string;
  duration: number;
  bytes: number;
}

async function bundleBytes(dir: string): Promise<number> {
  const entries = await readdir(dir);
  const sizes = await Promise.all(entries.map(async (name) => (await stat(join(dir, name))).size));
  return sizes.reduce((total, size) => total + size, 0);
}

// Capture runs at roughly 3MB per second at 4K, so a five minute recording is close to
// a gigabyte. Sizes are reported so the user can see what is filling their disk.
export async function listRecordings(root: string): Promise<RecordingSummary[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const summaries: RecordingSummary[] = [];
  for (const id of entries) {
    const dir = join(root, id);
    try {
      const meta = parseRecordingMeta(JSON.parse(await readFile(bundlePaths(dir).meta, 'utf8')));
      summaries.push({
        id,
        createdAt: meta.createdAt,
        duration: meta.duration,
        bytes: await bundleBytes(dir),
      });
    } catch {
      // Not a valid bundle, most likely a recording that never finished. Skip it
      // rather than failing the whole listing.
      continue;
    }
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteRecording(root: string, id: string): Promise<void> {
  if (!isBundleId(id)) throw new Error('invalid recording id');
  await rm(join(root, id), { recursive: true, force: true });
}
