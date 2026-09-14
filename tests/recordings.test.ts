import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteRecording, listRecordings } from '../server/recordings';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'frame-studio-recordings-'));
  const dir = join(root, 'recording-1');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'video.mov'), Buffer.alloc(2048));
  await writeFile(join(dir, 'cursor.jsonl'), '{"t":0,"x":1,"y":2,"e":"m","b":-1}\n');
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      displayScale: 2,
      displayPoints: { w: 1920, h: 1080 },
      videoStartOffset: 0.03,
      duration: 5.5,
      createdAt: '2026-09-14T13:02:00.000Z',
    }),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listRecordings', () => {
  it('reports each bundle with its total size on disk', async () => {
    const list = await listRecordings(root);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('recording-1');
    expect(list[0].duration).toBe(5.5);
    expect(list[0].bytes).toBeGreaterThan(2048);
  });

  it('ignores directories that are not valid bundles', async () => {
    await mkdir(join(root, 'junk'), { recursive: true });
    expect(await listRecordings(root)).toHaveLength(1);
  });

  it('returns an empty list when the root does not exist yet', async () => {
    expect(await listRecordings(join(root, 'missing'))).toEqual([]);
  });
});

describe('deleteRecording', () => {
  it('refuses an id containing a path separator, so it cannot escape the root', async () => {
    await expect(deleteRecording(root, '../evil')).rejects.toThrow();
    await expect(deleteRecording(root, 'a/b')).rejects.toThrow();
    await expect(deleteRecording(root, '  ')).rejects.toThrow();
  });

  it('removes the bundle directory', async () => {
    await deleteRecording(root, 'recording-1');
    expect(await listRecordings(root)).toHaveLength(0);
  });
});
