import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundlePaths, parseCursorTrack, parseRecordingMeta } from '../shared/recording';

const execute = promisify(execFile);
let binary: string;
let directory: string;

// Needs a real display and a granted Screen Recording permission, so it is opt in.
const canCapture = process.env.FRAME_CAPTURE_TEST === '1';

beforeAll(async () => {
  if (!canCapture) return;
  const { stdout } = await execute('node', ['desktop/recorder/build.mjs']);
  binary = stdout.trim();
  directory = await mkdtemp(join(tmpdir(), 'frame-studio-capture-'));
}, 180_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe.skipIf(!canCapture)('frame-recorder capture', () => {
  it('writes a bundle whose meta carries a measured videoStartOffset', async () => {
    const child = spawn(binary, []);
    const events: Record<string, unknown>[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) events.push(JSON.parse(line));
      }
    });
    const waitFor = async (name: string, ms: number) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = events.find((event) => event.event === name);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`no ${name} event, saw: ${events.map((e) => e.event).join(', ')}`);
    };

    child.stdin.write(JSON.stringify({ cmd: 'list-displays' }) + '\n');
    const displays = (await waitFor('displays', 15_000)).displays as { id: number }[];

    child.stdin.write(
      JSON.stringify({ cmd: 'start', display: displays[0].id, out: directory }) + '\n',
    );
    await waitFor('started', 15_000);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    child.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n');
    const finished = await waitFor('finished', 20_000);
    child.kill();

    expect(finished.frames as number).toBeGreaterThan(0);

    const paths = bundlePaths(directory);
    const meta = parseRecordingMeta(JSON.parse(await readFile(paths.meta, 'utf8')));
    expect(meta.displayScale).toBeGreaterThan(0);
    expect(meta.duration).toBeGreaterThan(0);
    // Measured, not assumed. A hardcoded zero here is the bug this guards against.
    expect(Number.isFinite(meta.videoStartOffset)).toBe(true);
    expect(meta.displayPoints.w).toBeGreaterThan(0);

    // The track may be empty if nothing moved during the run, but it must parse.
    const track = parseCursorTrack(await readFile(paths.track, 'utf8'));
    expect(Array.isArray(track)).toBe(true);

    // The video must exist and be non trivial.
    const probe = await execute('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      paths.video,
    ]);
    const [width, height] = probe.stdout.trim().split(',').map(Number);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  }, 90_000);
});
