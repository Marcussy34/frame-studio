// Wires the zoom planner into the local API: reads a bundle off disk, plans it, and
// writes the result back as the bundle's fourth member.

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ZoomSettings } from '../shared/cursor';
import {
  bundlePaths,
  parseCursorTrack,
  parseRecordingMeta,
  type CursorTrack,
} from '../shared/recording';
import type { ZoomPlanRequest, ZoomPlanResult, ZoomPlanService } from '../server/zoom-plan-service';
import { createZoomPlanner, type ZoomPlanner } from './zoom-planner';

// A stored plan carries the planner's full intent. The user's strength slider is
// applied as a ceiling later, by normalisePlan at render time, so moving that slider
// changes the result immediately instead of needing the recording planned again.
const PLAN_CEILING = 3;

// Speed is unused by the planners: a plan carries per shot easing instead of one global
// setting, which is most of the point of having a plan.
const PLANNING_SETTINGS: ZoomSettings = { enabled: true, strength: PLAN_CEILING, speed: 55 };

export interface ZoomPlanServiceDeps {
  planner: ZoomPlanner;
  ffmpeg: string;
  ffprobe: string;
}

const execute = promisify(execFile);

// meta.duration is wall clock from the first frame to the end of the recording, and the
// movie is often shorter: ScreenCaptureKit stops emitting frames when nothing on screen
// changes, so a still final stretch is simply not in the file. Measured on a real
// recording: meta said 25.62s, the movie was 20.90s.
//
// Planning against the wall clock asks for frames that do not exist and produces shots
// past the end of the video, so the movie's own length is what bounds a plan.
async function videoDuration(ffprobe: string, video: string, fallback: number): Promise<number> {
  try {
    const { stdout } = await execute(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      video,
    ]);
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
  } catch {
    // A plan against a slightly long clip is better than no plan at all.
    return fallback;
  }
}

async function readBundle(directory: string): Promise<CursorTrack> {
  const paths = bundlePaths(directory);
  return {
    meta: parseRecordingMeta(JSON.parse(await readFile(paths.meta, 'utf8'))),
    events: parseCursorTrack(await readFile(paths.track, 'utf8')),
  };
}

export function createZoomPlanService(deps: ZoomPlanServiceDeps): ZoomPlanService {
  return {
    async plan(request: ZoomPlanRequest): Promise<ZoomPlanResult> {
      const paths = bundlePaths(request.directory);
      const track = await readBundle(request.directory);
      // The recording knows its own size in points and its scale, which is exactly the
      // pixel size of the capture. Probing again would be a second source of truth.
      const source = {
        width: Math.round(track.meta.displayPoints.w * track.meta.displayScale),
        height: Math.round(track.meta.displayPoints.h * track.meta.displayScale),
      };

      const duration = await videoDuration(deps.ffprobe, paths.video, track.meta.duration);

      const outcome = await deps.planner.plan({
        video: paths.video,
        track,
        settings: PLANNING_SETTINGS,
        duration,
        source,
        ffmpeg: deps.ffmpeg,
        useFrames: request.useFrames,
        signal: request.signal,
        progress: request.progress,
      });

      await writeFile(paths.plan, JSON.stringify(outcome.plan, null, 2) + '\n');
      return outcome;
    },
  };
}

export { createZoomPlanner };
