// The planner that needs no model: clusters clicks into tasks and sizes each shot from
// how tightly those clicks sit together.
//
// It exists for three reasons beyond being useful on its own. It is the fallback when
// the model planner is unavailable, refused or returns nonsense. It is the draft the
// model is asked to improve, so the model edits rather than invents. And it is the only
// planner the test suite can run without a network.
//
// Lives in shared/ so the preview can plan without a round trip to the server.

import { captureOriginAt, ZOOM_LEAD, ZOOM_TAIL, type ZoomSettings } from './cursor';
import type { CaptureFrame, CursorEvent } from './recording';
import type { ZoomPlan, ZoomShot } from './zoom-plan';

// Clicks closer together than this are one piece of work, not two. Chosen to match the
// tail the automatic zoom already uses, so a burst reads as a burst either way.
const CLUSTER_GAP = 1.5;

// Above this spread the pointer is travelling, so a fixed centre would leave it off
// frame and the shot has to follow instead.
const FOLLOW_ABOVE = 0.15;

interface Cluster {
  first: number;
  last: number;
  count: number;
  cx: number;
  cy: number;
  spread: number;
}

export interface HeuristicInput {
  events: CursorEvent[];
  settings: ZoomSettings;
  duration: number;
  displayScale: number;
  frames: CaptureFrame[];
  source: { width: number; height: number };
}

// Groups clicks by time, then measures where each group sits in source pixels.
function cluster(input: HeuristicInput): Cluster[] {
  const clicks = input.events.filter((event) => event.e === 'd');
  if (!clicks.length) return [];

  const groups: CursorEvent[][] = [[clicks[0]]];
  for (const click of clicks.slice(1)) {
    const group = groups[groups.length - 1];
    if (click.t - group[group.length - 1].t <= CLUSTER_GAP) group.push(click);
    else groups.push([click]);
  }

  const diagonal = Math.hypot(input.source.width, input.source.height);
  return groups.map((group) => {
    // Cursor events are global points; the visible region is source pixels. Converting
    // here means every coordinate the planner emits downstream is already in the space
    // the compiler expects.
    const points = group.map((click) => {
      const origin = captureOriginAt(input.frames, click.t);
      return {
        x: (click.x - (origin?.x ?? 0)) * input.displayScale,
        y: (click.y - (origin?.y ?? 0)) * input.displayScale,
      };
    });
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    return {
      first: group[0].t,
      last: group[group.length - 1].t,
      count: group.length,
      cx: xs.reduce((a, b) => a + b, 0) / xs.length,
      cy: ys.reduce((a, b) => a + b, 0) / ys.length,
      // How much of the frame the group covers, 0 for a single point and 1 for corner
      // to corner. This is what decides how far in the shot goes.
      spread: diagonal > 0 ? Math.hypot(width, height) / diagonal : 0,
    };
  });
}

export function planZoomHeuristically(input: HeuristicInput): ZoomPlan {
  const ceiling = Math.max(1, Math.min(3, input.settings.strength));
  const shots: ZoomShot[] = cluster(input).map((group) => {
    // A cluster confined to a tenth of the screen goes most of the way in. One spanning
    // half of it barely moves, because there is nothing small to look at.
    const zoom = Math.max(1.2, Math.min(ceiling, ceiling - group.spread * (ceiling - 1) * 2));
    const follow = group.spread > FOLLOW_ABOVE;
    return {
      start: Math.max(0, group.first - ZOOM_LEAD),
      end: Math.min(input.duration, group.last + ZOOM_TAIL),
      zoom,
      focus: follow
        ? ('cursor' as const)
        : {
            x: clamp01(group.cx / input.source.width),
            y: clamp01(group.cy / input.source.height),
          },
      // A lone click is usually a deliberate target worth arriving at sharply. A burst
      // is usually someone working, where a softer move is less distracting.
      ease: group.count === 1 ? ('snap' as const) : ('normal' as const),
      why:
        group.count === 1
          ? 'a single click, held close'
          : `${group.count} clicks in one go${follow ? ', following the pointer' : ''}`,
    };
  });

  return {
    version: 1,
    source: 'heuristic',
    model: '',
    createdAt: new Date().toISOString(),
    shots,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
