// What the model is told, and how its answer is read back.
//
// The wrapper around agy is text in, text out, with no structured output mode, so the
// reply is prose that happens to contain JSON. Everything here assumes the model will
// wrap it in a code fence, explain itself first, or simply get it wrong.

import type { CursorEvent, RecordingMeta } from '../../shared/recording';
import type { ZoomPlan } from '../../shared/zoom-plan';
import { zoomPlanSchema } from '../../shared/zoom-plan';
import { frameName } from './frames';

export interface PromptInput {
  meta: RecordingMeta;
  events: CursorEvent[];
  duration: number;
  source: { width: number; height: number };
  frameTimes: number[];
  draft: ZoomPlan;
}

interface Second {
  at: number;
  clicks: number;
  travel: number;
  dragging: boolean;
}

// One line per second instead of the raw track. A three minute recording is tens of
// thousands of events, which would crowd out the frames for no benefit: the model needs
// the rhythm of the session, not every sample of it.
export function summariseTrack(events: CursorEvent[], duration: number): Second[] {
  const seconds: Second[] = Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => ({
    at: i,
    clicks: 0,
    travel: 0,
    dragging: false,
  }));
  let held = false;
  let previous: CursorEvent | null = null;

  for (const event of events) {
    const slot = seconds[Math.floor(event.t)];
    if (!slot) continue;
    if (event.e === 'd') {
      slot.clicks += 1;
      held = true;
    } else if (event.e === 'u') {
      held = false;
    } else {
      if (previous) slot.travel += Math.hypot(event.x - previous.x, event.y - previous.y);
      // A drag is movement with the button down, which reads very differently from a
      // click: it is one continuous action rather than a moment of attention.
      if (held) slot.dragging = true;
    }
    previous = event;
  }
  return seconds;
}

function describeTrack(events: CursorEvent[], duration: number): string {
  return summariseTrack(events, duration)
    .map((second) => {
      const parts = [`${second.at}s`];
      if (second.clicks) parts.push(`${second.clicks} click${second.clicks > 1 ? 's' : ''}`);
      if (second.dragging) parts.push('dragging');
      parts.push(`moved ${Math.round(second.travel)}pt`);
      return parts.join(', ');
    })
    .join('\n');
}

export function buildPrompt(input: PromptInput): string {
  const { meta, duration, source, frameTimes, draft } = input;
  const captured =
    meta.captureKind === 'display'
      ? 'a whole display'
      : `a single ${meta.captureKind}, so the frame is already cropped to it`;

  return `You are directing the camera for a screen recording. Decide when to move in,
how close, where to point, and how quickly to arrive.

THE RECORDING
- ${duration.toFixed(1)} seconds long, ${source.width}x${source.height} pixels.
- Captured ${captured}.
- The cursor is drawn back in afterwards, so do not worry about it being missing.

FRAMES
Sampled frames are in the frames/ directory of this workspace. Each is named by its
moment in the recording: ${frameName(0)} is 0.0s, ${frameName(2.4)} is 2.4s. There are
${frameTimes.length} of them. Look at them. They are what the viewer will see.

WHAT THE POINTER DID, one line per second
${describeTrack(input.events, duration)}

A STARTING POINT
This plan was generated mechanically from the clicks alone, with no understanding of
what is on screen. Improve it. Merge shots that are really one task, drop ones that
emphasise nothing, move in closer on small targets, and pull out when the viewer needs
context.

${JSON.stringify(draft.shots, null, 2)}

WHAT GOOD LOOKS LIKE
- Fewer, longer shots beat many short ones. Constant movement is exhausting to watch.
- Zoom in far on something small and precise. Stay wide when the point is the layout.
- "focus": "cursor" follows the pointer, for when the user is moving through something.
  A fixed {"x": 0.5, "y": 0.5} point holds still, for when they are reading a result.
  Fixed coordinates are fractions of the frame, 0 to 1, measured from the top left.
- "ease": "snap" arrives quickly, "normal" is the default, "drift" eases in slowly.
- Leave quiet stretches alone. A shot that emphasises nothing is worse than no shot.

RULES
- Shots must not overlap and must sit inside 0 to ${duration.toFixed(1)} seconds.
- "zoom" is between 1 and 3. Nothing shorter than 0.6 seconds.
- At most 40 shots.
- "why" is one short phrase explaining the choice, for a human reading the plan.

Reply with ONLY this JSON object and nothing else:
{"shots":[{"start":0,"end":0,"zoom":1,"focus":"cursor","ease":"normal","why":""}]}`;
}

// Pulls the first balanced JSON object out of a reply, so a code fence or a sentence of
// preamble does not cost the whole plan. Counting braces rather than matching a regex
// because a regex cannot tell a nested object from the end of the outer one.
export function extractJson(reply: string): string | null {
  const start = reply.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < reply.length; i++) {
    const character = reply[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') inString = !inString;
    if (inString) continue;
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return reply.slice(start, i + 1);
    }
  }
  // Ran out of text with braces still open, so the reply was truncated.
  return null;
}

// Turns a reply into a plan, or null if it cannot be trusted. Never throws: a model
// that answers badly must cost the fallback, not the whole recording.
export function parsePlan(reply: string, model: string): ZoomPlan | null {
  const json = extractJson(reply);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  // Models reliably return the shots and forget the envelope, so it is supplied here
  // rather than demanded of them.
  const shots = (raw as { shots?: unknown })?.shots;
  const parsed = zoomPlanSchema.safeParse({
    version: 1,
    source: 'model',
    model,
    createdAt: new Date().toISOString(),
    shots: Array.isArray(shots) ? shots : [],
  });
  if (!parsed.success) return null;
  // An empty plan from a model is indistinguishable from it having failed, and a
  // recording with no shots is better served by the automatic zoom.
  return parsed.data.shots.length ? parsed.data : null;
}
