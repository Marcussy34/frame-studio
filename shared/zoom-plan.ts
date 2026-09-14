// A camera plan for a recording, and the code that turns it into a zoom curve.
//
// Imported by both the browser preview and the FFmpeg export, like shared/cursor.ts,
// so there is one implementation of what the camera does and no way for the two to
// drift apart.
//
// The split this file exists to enforce: a planner decides INTENT, which shot, how
// close, pointed where. The compiler below produces MOTION, using the same spring the
// automatic zoom already uses. Nothing that plans is allowed to emit keyframes.

import { z } from 'zod';
import type { CaptureFrame, CursorEvent, CursorTrack } from './recording';
import {
  buildZoomCurve,
  integrateZoom,
  simplifyCurve,
  smoothPath,
  captureOriginAt,
  type ZoomKey,
  type ZoomSettings,
} from './cursor';

// A shot is too short to read below this. A quarter second push in and straight back
// out reads as a flinch rather than as emphasis.
const MIN_SHOT = 0.6;

export const zoomShotSchema = z.object({
  start: z.number().nonnegative(), // seconds, in cursor-track time
  end: z.number().positive(),
  zoom: z.number().min(1).max(3),
  // 'cursor' follows the smoothed pointer. A fixed point holds still, which is what is
  // wanted while someone reads a result rather than moves toward one.
  focus: z.union([
    z.literal('cursor'),
    // Normalised to the captured frame, so a planner can answer in the coordinates of
    // the images it was shown without knowing the source resolution.
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  ]),
  // Maps onto spring stiffness further down.
  ease: z.enum(['snap', 'normal', 'drift']).default('normal'),
  // The planner's own reason. Shown in the UI so an odd choice is explainable. Never
  // parsed, so a model is free to write whatever it likes here.
  why: z.string().max(200).default(''),
});
export type ZoomShot = z.infer<typeof zoomShotSchema>;

export const zoomPlanSchema = z.object({
  version: z.literal(1),
  source: z.enum(['heuristic', 'model']),
  model: z.string().default(''),
  createdAt: z.string(),
  // Enforced here rather than requested in a prompt, because a prompt is a suggestion.
  shots: z.array(zoomShotSchema).max(120),
});
export type ZoomPlan = z.infer<typeof zoomPlanSchema>;

// Nothing that produces a plan is trusted, a model least of all. This makes any plan
// safe to compile: ordered, inside the clip, non-overlapping, and within the user's
// own strength setting.
export function normalisePlan(plan: ZoomPlan, duration: number, ceiling: number): ZoomPlan {
  const limit = Math.max(1, Math.min(3, ceiling));
  const shots: ZoomShot[] = [];
  let previousEnd = 0;

  for (const shot of [...plan.shots].sort((a, b) => a.start - b.start)) {
    // Two shots cannot both own the frame. The earlier one keeps its full run and the
    // later one starts late, rather than cutting the first short, which could otherwise
    // shrink a deliberate shot below MIN_SHOT and lose it entirely.
    const start = Math.max(previousEnd, Math.min(shot.start, duration));
    const end = Math.min(shot.end, duration);
    if (end - start < MIN_SHOT) continue;
    shots.push({ ...shot, start, end, zoom: Math.max(1, Math.min(limit, shot.zoom)) });
    previousEnd = end;
  }
  return { ...plan, shots };
}

// Stiffer springs arrive sooner. Friction stays critically damped at 2*sqrt(tension),
// as in buildZoomCurve, so the frame settles instead of bouncing.
const STIFFNESS: Record<ZoomShot['ease'], number> = { drift: 20, normal: 45, snap: 80 };

// Turns intent into motion. Deliberately the same integrator the automatic zoom uses,
// so a planned camera move feels like the automatic one rather than like a different
// product bolted on.
export function compileZoomPlan(
  plan: ZoomPlan,
  events: CursorEvent[],
  settings: ZoomSettings,
  duration: number,
  displayScale: number,
  frames: CaptureFrame[],
  source: { width: number; height: number },
): ZoomKey[] {
  const normalised = normalisePlan(plan, duration, settings.strength);
  const flat: ZoomKey[] = [{ t: 0, z: 1, cx: 0, cy: 0 }];
  if (!settings.enabled || !normalised.shots.length) return flat;

  // Only needed for shots that follow the pointer, but building it once is cheaper than
  // deciding whether to.
  const path = smoothPath(events, { smoothing: 0 }, duration);

  // Where a shot wants the frame pointed, in source pixels.
  const focusOf = (shot: ZoomShot, t: number) => {
    if (shot.focus !== 'cursor') {
      return { x: shot.focus.x * source.width, y: shot.focus.y * source.height };
    }
    const origin = captureOriginAt(frames, t);
    const point = path.at(t);
    return {
      x: (point.x - (origin?.x ?? 0)) * displayScale,
      y: (point.y - (origin?.y ?? 0)) * displayScale,
    };
  };

  // Start already pointed at the first shot. The centre is invisible at zoom 1, so
  // beginning at the default origin costs nothing to see but makes the frame race
  // diagonally across the picture while that first shot's zoom is already rising.
  const first = normalised.shots[0];
  const opening = focusOf(first, first.start);

  // Shots are ordered and non-overlapping after normalisePlan, so a cursor that only
  // moves forward can find the active one without scanning the whole list every step.
  let index = 0;
  const raw = integrateZoom(
    duration,
    (t, current) => {
      while (index < normalised.shots.length && t > normalised.shots[index].end) index += 1;
      const shot = normalised.shots[index];
      if (!shot || t < shot.start) {
        // Between shots the frame eases back out and holds where it is, rather than
        // drifting with the pointer, which is far less nauseating to watch.
        return { z: 1, x: current.cx, y: current.cy, tension: STIFFNESS.normal };
      }
      const point = focusOf(shot, t);
      return { z: shot.zoom, x: point.x, y: point.y, tension: STIFFNESS[shot.ease] };
    },
    { cx: opening.x, cy: opening.y },
  );
  return simplifyCurve(raw);
}

// The one place that decides whether a recording's camera comes from a plan or from
// the automatic zoom. Both the live preview and the FFmpeg export call this, so the two
// cannot end up showing different things, which is the whole reason shared/ exists.
//
// A missing or empty plan always falls back, so selecting 'plan' on a recording that
// has never been planned shows the automatic zoom rather than nothing at all.
export function zoomCurveFor(
  track: CursorTrack,
  settings: ZoomSettings,
  usePlan: boolean,
  duration: number,
  source: { width: number; height: number },
  plan?: ZoomPlan,
): ZoomKey[] {
  if (usePlan && plan && plan.shots.length) {
    return compileZoomPlan(
      plan,
      track.events,
      settings,
      duration,
      track.meta.displayScale,
      track.meta.captureFrames,
      source,
    );
  }
  return buildZoomCurve(
    track.events,
    settings,
    duration,
    track.meta.displayScale,
    track.meta.captureFrames,
  );
}
