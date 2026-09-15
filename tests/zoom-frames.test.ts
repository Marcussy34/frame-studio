import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  clickTimesOf,
  extractFrames,
  frameName,
  frameSchedule,
  MAX_FRAMES,
} from '../desktop/zoom-planner/frames';
import type { CursorEvent } from '../shared/recording';

describe('frameSchedule', () => {
  it('samples before and after every click', () => {
    // Before shows what prompted the click, after shows what it produced.
    expect(frameSchedule([5], 20, MAX_FRAMES)).toEqual(
      expect.arrayContaining([expect.closeTo(4.7, 3), expect.closeTo(5.5, 3)]),
    );
  });

  it('fills quiet stretches with a baseline so they are not invisible', () => {
    const times = frameSchedule([], 12);
    expect(times).toEqual([0, 3, 6, 9, 12]);
  });

  it('does not spend a baseline frame next to a click frame', () => {
    // A click at 3.3s puts a frame at 3.0s, which is exactly where a baseline would go.
    const times = frameSchedule([3.3], 12);
    const near3 = times.filter((t) => Math.abs(t - 3) < 0.4);
    expect(near3).toHaveLength(1);
  });

  it('never samples the same moment twice', () => {
    // A burst of clicks would otherwise produce a pile of near identical frames.
    const times = frameSchedule([5, 5.1, 5.2, 5.3, 5.4], 20);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.4 - 1e-9);
    }
  });

  it('stays inside the clip', () => {
    const times = frameSchedule([0.1, 19.9], 20);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...times)).toBeLessThanOrEqual(20);
  });

  it('keeps the budget, dropping baseline frames before click frames', () => {
    // Twelve minutes of idle recording would ask for 240 baseline frames.
    const idle = frameSchedule([], 720);
    expect(idle.length).toBeLessThanOrEqual(MAX_FRAMES);

    const clicks = Array.from({ length: 15 }, (_, i) => 2 + i * 3);
    const busy = frameSchedule(clicks, 720);
    expect(busy.length).toBeLessThanOrEqual(MAX_FRAMES);
    // The click frames survived: two per click, minus any the gap rule merged.
    expect(busy.length).toBeGreaterThanOrEqual(25);
  });

  it('thins click frames when even those overrun the budget, keeping the spread', () => {
    const clicks = Array.from({ length: 200 }, (_, i) => i * 2);
    const times = frameSchedule(clicks, 400);
    expect(times.length).toBeLessThanOrEqual(MAX_FRAMES);
    // Still covers the whole clip rather than a dense clump at the start.
    expect(Math.max(...times)).toBeGreaterThan(300);
  });

  it('returns something for a clip with no duration', () => {
    expect(frameSchedule([], 0)).toEqual([0]);
  });

  it('stays sorted, because the model is told these are in order', () => {
    const times = frameSchedule([9, 2, 15], 20);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('frameName', () => {
  it('encodes the moment so a filename maps back to a time', () => {
    expect(frameName(2.4)).toBe('t-0002400.jpg');
    expect(frameName(0)).toBe('t-0000000.jpg');
  });

  it('sorts lexically in the same order as time, which is how a model reads them', () => {
    const names = [12.5, 2.4, 0.5, 100].map(frameName);
    expect([...names].sort()).toEqual([0.5, 2.4, 12.5, 100].map(frameName));
  });
});

describe('clickTimesOf', () => {
  it('takes presses and ignores moves and releases', () => {
    const events: CursorEvent[] = [
      { t: 1, x: 0, y: 0, e: 'm', b: -1 },
      { t: 2, x: 0, y: 0, e: 'd', b: 0 },
      { t: 2.1, x: 0, y: 0, e: 'u', b: 0 },
    ];
    expect(clickTimesOf(events)).toEqual([2]);
  });
});

describe('extractFrames', () => {
  const directories: string[] = [];

  afterAll(async () => {
    await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // A limited range clip, which is what Frame Studio records. The mjpeg encoder refuses
  // that outright, so extraction has to convert the range rather than pass it through.
  async function limitedRangeClip(seconds: number): Promise<{ video: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'frame-studio-frames-'));
    directories.push(dir);
    const video = join(dir, 'clip.mov');
    await promisify(execFile)('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=320x240:rate=10:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-color_range',
      'tv',
      '-y',
      video,
    ]);
    return { video, dir };
  }

  it('reads frames out of a limited range recording', async () => {
    // Without the range conversion ffmpeg fails with "Non full-range YUV is
    // non-standard" and not a single frame comes out.
    const { video, dir } = await limitedRangeClip(3);
    const extracted = await extractFrames({
      video,
      directory: join(dir, 'frames'),
      times: [0.5, 1.5, 2.5],
      ffmpeg: 'ffmpeg',
    });
    expect(extracted.times).toEqual([0.5, 1.5, 2.5]);
    for (const t of extracted.times) {
      expect((await stat(join(dir, 'frames', frameName(t)))).size).toBeGreaterThan(0);
    }
  }, 60_000);

  it('drops moments that fall past the end rather than naming an empty frame', async () => {
    // The schedule is built from the cursor track, which runs longer than the movie.
    // Seeking past the last frame writes nothing and still exits cleanly, so a frame
    // that was never written must not be offered to the model as though it existed.
    const { video, dir } = await limitedRangeClip(2);
    const extracted = await extractFrames({
      video,
      directory: join(dir, 'frames'),
      times: [0.5, 1.5, 9],
      ffmpeg: 'ffmpeg',
    });
    expect(extracted.times).toEqual([0.5, 1.5]);
    await expect(stat(join(dir, 'frames', frameName(9)))).rejects.toThrow();
  }, 60_000);

  it('says so when nothing at all could be read', async () => {
    const { video, dir } = await limitedRangeClip(1);
    await expect(
      extractFrames({ video, directory: join(dir, 'frames'), times: [30, 40], ffmpeg: 'ffmpeg' }),
    ).rejects.toThrow(/none of the sampled moments/i);
  }, 60_000);
});
