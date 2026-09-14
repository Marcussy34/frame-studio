// Planning a recording's camera: sample some frames, ask the model, validate hard, and
// fall back to the mechanical plan whenever the answer cannot be trusted.
//
// The contract this file keeps is that planning NEVER fails destructively. Every path
// out of here returns a usable plan, because the alternative is a user watching a
// progress bar and then getting nothing.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CursorTrack } from '../../shared/recording';
import type { ZoomSettings } from '../../shared/cursor';
import { planZoomHeuristically } from '../../shared/zoom-heuristic';
import type { ZoomPlan } from '../../shared/zoom-plan';
import { findAgy, PLANNING_MODEL, runAgy, type AgyLocation } from './agy';
import { clickTimesOf, extractFrames, frameSchedule } from './frames';
import { buildPrompt, parsePlan } from './prompt';

export interface PlanRequest {
  video: string;
  track: CursorTrack;
  settings: ZoomSettings;
  duration: number;
  source: { width: number; height: number };
  ffmpeg: string;
  // Off means the model is given the cursor track alone and never sees the screen.
  useFrames: boolean;
  signal: AbortSignal;
  progress(fraction: number): void;
}

export interface PlanOutcome {
  plan: ZoomPlan;
  // Set when the model was asked but could not be used. The plan is still usable, so
  // this is something to mention rather than something to fail on.
  note?: string;
}

export interface ZoomPlannerDeps {
  locate?: () => AgyLocation | null;
  ask?: typeof runAgy;
}

export function createZoomPlanner(deps: ZoomPlannerDeps = {}) {
  const locate = deps.locate ?? (() => findAgy());
  const ask = deps.ask ?? runAgy;

  return {
    // Whether model planning can be offered at all. The UI hides the button rather than
    // showing one that always fails.
    available(): boolean {
      return locate() !== null;
    },

    async plan(request: PlanRequest): Promise<PlanOutcome> {
      const draft = planZoomHeuristically({
        events: request.track.events,
        settings: request.settings,
        duration: request.duration,
        displayScale: request.track.meta.displayScale,
        frames: request.track.meta.captureFrames,
        source: request.source,
      });

      const location = locate();
      if (!location) return { plan: draft, note: 'Antigravity is not installed on this Mac.' };
      request.signal.throwIfAborted();

      const directory = await mkdtemp(join(tmpdir(), 'frame-studio-plan-'));
      let cleanup: (() => Promise<void>) | null = null;
      try {
        const times = request.useFrames
          ? frameSchedule(clickTimesOf(request.track.events), request.duration)
          : [];
        if (times.length) {
          const extracted = await extractFrames({
            video: request.video,
            directory: join(directory, 'frames'),
            times,
            ffmpeg: request.ffmpeg,
            signal: request.signal,
          });
          cleanup = extracted.cleanup;
        }
        // Extraction is most of the wall clock before the model starts thinking.
        request.progress(0.4);

        const prompt = buildPrompt({
          meta: request.track.meta,
          events: request.track.events,
          duration: request.duration,
          source: request.source,
          frameTimes: times,
          draft,
        });
        // Kept beside the frames so the whole request is inspectable after the fact,
        // which matters a great deal when a plan comes back odd.
        await writeFile(join(directory, 'prompt.txt'), prompt);

        const reply = await ask({
          location,
          prompt,
          directory,
          signal: request.signal,
        });
        request.progress(0.95);

        const plan = parsePlan(reply, PLANNING_MODEL);
        if (!plan) {
          return { plan: draft, note: 'The model did not return a usable plan.' };
        }
        return { plan };
      } catch (error) {
        if (request.signal.aborted) throw error;
        // Quota, auth, timeout and a missing CLI all land here already translated.
        return { plan: draft, note: (error as Error).message };
      } finally {
        await cleanup?.().catch(() => {});
        request.progress(1);
      }
    },
  };
}

export type ZoomPlanner = ReturnType<typeof createZoomPlanner>;
