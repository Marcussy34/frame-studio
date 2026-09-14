import { join } from 'node:path';
import { z } from 'zod';

// A recording is a directory, not a loose file. The video is meaningless without
// the cursor track, and the track is meaningless without the metadata that says
// how to map its coordinates onto the video.
export const BUNDLE_VIDEO = 'video.mov';
export const BUNDLE_TRACK = 'cursor.jsonl';
export const BUNDLE_META = 'meta.json';
// Optional fourth member. Absent until a recording is planned, and deletable without
// harming the bundle, because the raw track is what everything else derives from.
export const BUNDLE_PLAN = 'zoom-plan.json';

// Bundle ids arrive from the client, so never let one traverse out of the recordings
// root. One implementation on purpose: this guard had grown two slightly different
// copies, and two copies of a path check is how they drift apart.
export function isBundleId(id: string): boolean {
  return id.trim().length > 0 && !/[\\/]|\.\./.test(id);
}

export function bundlePaths(dir: string) {
  return {
    video: join(dir, BUNDLE_VIDEO),
    track: join(dir, BUNDLE_TRACK),
    meta: join(dir, BUNDLE_META),
    plan: join(dir, BUNDLE_PLAN),
  };
}

// Raw event tap output, stored exactly as captured. Smoothing, motion blur and
// the zoom curve stay derived values, so they can be retuned without re-recording.
export const cursorEventSchema = z.object({
  t: z.number(), // seconds since track start
  x: z.number(), // points, top-left origin (CGEvent.location needs no flip)
  y: z.number(),
  e: z.enum(['m', 'd', 'u']), // move, down, up
  b: z.number().int(), // button: 0 left, 1 right, 2 other, -1 for moves
});
export type CursorEvent = z.infer<typeof cursorEventSchema>;

// Where the captured pixels sit in global screen space, sampled over time because a
// window can be moved mid-recording. Cursor events are global, so without this the
// cursor lands hundreds of pixels away from where it actually was.
export const captureFrameSchema = z.object({
  t: z.number(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type CaptureFrame = z.infer<typeof captureFrameSchema>;

export const recordingMetaSchema = z.object({
  version: z.literal(1),
  // Defaults keep bundles recorded before window capture existing loading unchanged.
  captureKind: z.enum(['display', 'window', 'region']).default('display'),
  captureTitle: z.string().default(''),
  // Only written when it changes, so a window that never moves costs one entry.
  captureFrames: z.array(captureFrameSchema).default([]),
  // Measured per display. A hardcoded 2x is wrong on non-retina and mixed setups.
  displayScale: z.number().positive(),
  displayPoints: z.object({ w: z.number().positive(), h: z.number().positive() }),
  // Measured gap between track t0 and the first video frame. Never assumed to be
  // zero: the event tap starts fractionally before startCapture returns.
  videoStartOffset: z.number(),
  duration: z.number().nonnegative(),
  createdAt: z.string(),
});
export type RecordingMeta = z.infer<typeof recordingMetaSchema>;

export interface CursorTrack {
  meta: RecordingMeta;
  events: CursorEvent[];
}

export interface DisplayInfo {
  id: number;
  width: number;
  height: number;
  scale: number;
  name: string;
}

export interface WindowInfo {
  id: number;
  title: string;
  app: string;
  width: number;
  height: number;
}

export const captureRegionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  // A stray click must never start a zero sized recording.
  width: z.number().finite().min(16),
  height: z.number().finite().min(16),
  displayID: z.number().finite(),
});
export type CaptureRegion = z.infer<typeof captureRegionSchema>;

export interface RecordingOutcome {
  id: string;
  frames: number;
  samples: number;
  clicks: number;
  duration: number;
  // Present only when a display change stopped the stream early.
  interrupted?: string;
  // The video recorded but no cursor events arrived, so the cursor cannot be drawn.
  noCursorData?: boolean;
}

// Implemented by the desktop process and injected into the local API, the same way
// preferences already are. Absent in the browser-only dev server, where screen capture
// is not available at all.
export interface PermissionReport {
  // Held by the capture helper. This grant follows the responsible process, so granting
  // it to Frame Studio covers the helper too.
  screenRecording: boolean;
  // Held by the app itself, which is where the cursor is tapped. libuiohook refuses to
  // run without it, so Accessibility is the grant to check, not Input Monitoring.
  accessibility: boolean;
}

export interface RecordingService {
  // What the capture helper can actually see. These grants are keyed to code identity,
  // so a stale System Settings entry can read as enabled while the process is denied.
  permissions(): Promise<PermissionReport>;
  // Triggers the macOS Accessibility prompt and reports where things stand after it.
  requestCursorAccess(): Promise<PermissionReport>;
  listDisplays(): Promise<DisplayInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  // Opens the drag-to-select overlay. Resolves null when the user cancels.
  selectRegion(): Promise<CaptureRegion | null>;
  // Exactly one of displayID or windowID. A region narrows a display capture.
  start(target: {
    displayID?: number;
    windowID?: number;
    region?: CaptureRegion;
  }): Promise<{ id: string }>;
  stop(): Promise<RecordingOutcome | null>;
  status(): { recording: boolean; last: RecordingOutcome | null };
}

// One malformed line must never cost the user a whole recording, so bad lines are
// skipped rather than thrown.
export function parseCursorTrack(jsonl: string): CursorEvent[] {
  const events: CursorEvent[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(cursorEventSchema.parse(JSON.parse(trimmed)));
    } catch {
      continue;
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

export function parseRecordingMeta(raw: unknown): RecordingMeta {
  return recordingMetaSchema.parse(raw);
}
