// Wires the zoom planner into the local API: reads a bundle off disk, plans it, and
// writes the result back as the bundle's fourth member.

import { readFile, writeFile } from 'node:fs/promises';
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

      const outcome = await deps.planner.plan({
        video: paths.video,
        track,
        settings: PLANNING_SETTINGS,
        duration: track.meta.duration,
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
