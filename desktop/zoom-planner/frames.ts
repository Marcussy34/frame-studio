// Picking which moments of a recording a model should actually look at, and cutting
// them out with the bundled ffmpeg.
//
// A recording is thousands of frames and a model is not going to read them all, so the
// budget is spent where something happened: around clicks, plus a thin baseline so long
// quiet stretches are not invisible.

import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CursorEvent } from '../../shared/recording';

const execute = promisify(execFile);

// What the model sees. A click is preceded by whatever prompted it and followed by
// whatever it produced, and both are worth a frame.
const BEFORE_CLICK = 0.3;
const AFTER_CLICK = 0.5;
const BASELINE_EVERY = 3;
// Two frames closer than this show the same thing, so one of them is wasted budget.
const MIN_GAP = 0.4;
export const MAX_FRAMES = 40;

// Keeps the first of any run of samples closer together than MIN_GAP.
function thinByGap(times: number[]): number[] {
  const kept: number[] = [];
  for (const t of times) {
    if (!kept.length || t - kept[kept.length - 1] >= MIN_GAP) kept.push(t);
  }
  return kept;
}

// Reduces a list to at most `limit` entries while keeping them spread across the clip,
// rather than keeping a dense head and losing the end entirely.
function spread(times: number[], limit: number): number[] {
  if (limit <= 0) return [];
  if (times.length <= limit) return times;
  const step = times.length / limit;
  return Array.from({ length: limit }, (_, i) => times[Math.floor(i * step)]);
}

// Which seconds of the recording to sample. Pure, so the budget rules are testable
// without touching ffmpeg.
export function frameSchedule(
  clickTimes: number[],
  duration: number,
  max: number = MAX_FRAMES,
): number[] {
  if (duration <= 0) return [0];
  const clamp = (t: number) => Math.max(0, Math.min(duration, t));

  const aroundClicks = thinByGap(
    clickTimes
      .flatMap((t) => [clamp(t - BEFORE_CLICK), clamp(t + AFTER_CLICK)])
      .sort((a, b) => a - b),
  );

  // Baseline frames fill the gaps rather than competing with the click frames, so a
  // busy recording spends nothing on them.
  const baseline = thinByGap(
    Array.from({ length: Math.floor(duration / BASELINE_EVERY) + 1 }, (_, i) =>
      clamp(i * BASELINE_EVERY),
    ),
  ).filter((t) => aroundClicks.every((click) => Math.abs(click - t) >= MIN_GAP));

  // Clicks are where the interesting things happen, so baseline frames give way first.
  const kept = spread(baseline, max - aroundClicks.length);
  const all = [...aroundClicks, ...kept].sort((a, b) => a - b);
  // Only reached when the clicks alone overrun the budget.
  return all.length <= max ? all : spread(aroundClicks, max);
}

export function clickTimesOf(events: CursorEvent[]): number[] {
  return events.filter((event) => event.e === 'd').map((event) => event.t);
}

// Frames are named by their millisecond offset, so a model can map an image back to a
// moment without being handed a separate manifest to keep in sync.
export function frameName(t: number): string {
  return `t-${String(Math.round(t * 1000)).padStart(7, '0')}.jpg`;
}

export interface ExtractedFrames {
  directory: string;
  // Sorted, and the same times the names encode.
  times: number[];
  cleanup(): Promise<void>;
}

// Cuts the chosen moments out of the video. Downscaled hard on purpose: reading a
// screen semantically does not need the source resolution, and the whole batch has to
// fit somewhere a model will accept it.
export async function extractFrames(options: {
  video: string;
  directory: string;
  times: number[];
  ffmpeg: string;
  width?: number;
  signal?: AbortSignal;
}): Promise<ExtractedFrames> {
  const { video, directory, times, ffmpeg, width = 640, signal } = options;
  await mkdir(directory, { recursive: true });
  // Only the moments that actually produced an image. The schedule is built from the
  // cursor track, which runs longer than the video, so some of it can fall past the end.
  const kept: number[] = [];
  for (const t of times) {
    signal?.throwIfAborted();
    const frame = join(directory, frameName(t));
    // -ss before -i seeks by keyframe, which is approximate but fast. Exactness does
    // not matter here: the point is what was roughly on screen at that moment.
    await execute(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      t.toFixed(3),
      '-i',
      video,
      '-frames:v',
      '1',
      '-vf',
      // Frame Studio recordings are limited range (color_range=tv), and the mjpeg
      // encoder refuses that outright: "Non full-range YUV is non-standard". The range
      // is expanded properly by scale rather than just relabelled, so the frames the
      // model sees have the contrast the screen actually had.
      `scale=${width}:-2:out_range=pc,format=yuvj420p`,
      '-q:v',
      '6',
      '-y',
      frame,
    ]).catch(() => undefined);
    // A seek past the last frame writes nothing and still exits cleanly, so the file has
    // to be checked rather than the exit code trusted. Passing an empty or absent frame
    // on would hand the model a filename for a moment it cannot see.
    const written = await stat(frame)
      .then((info) => info.size > 0)
      .catch(() => false);
    if (written) kept.push(t);
    else await rm(frame, { force: true }).catch(() => {});
  }
  if (!kept.length) {
    throw new Error('None of the sampled moments could be read out of this recording.');
  }
  return {
    directory,
    times: kept,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
