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

// What was asked for and what actually arrived. ScreenCaptureKit mixes system audio and
// the microphone into a single track before it reaches the file, so the peaks are the
// only record of which source contributed what, and the mix cannot be undone afterwards.
export const recordingAudioSchema = z.object({
  system: z.boolean().default(false),
  microphone: z.boolean().default(false),
  // AVCaptureDevice uniqueID. Empty means the system default input.
  device: z.string().default(''),
  // dBFS peak over the whole recording, present only for a source that was requested.
  systemPeak: z.number().optional(),
  microphonePeak: z.number().optional(),
  // The microphone was asked for and macOS would not allow it, so the recording went
  // ahead without it. Never refused outright: by then the countdown has run and the
  // window is hidden, and losing the take costs more than losing the sound.
  microphoneBlocked: z.boolean().optional(),
});
export type RecordingAudio = z.infer<typeof recordingAudioSchema>;

// How far down a reported level is allowed to go, mirroring LEVEL_FLOOR_DB in the
// capture helper. Used as the "nothing has arrived yet" value, so a meter that is never
// fed reads as empty rather than as a quarter of a bar of signal.
export const LEVEL_FLOOR_DBFS = -120;
// Below this a track holds nothing worth keeping. Measured on a real machine: a quiet
// room through a real microphone sits near -74 dBFS, a tone heard across the room
// reaches -43, and the same tone played into the system mix reaches -40.
export const SILENT_DBFS = -60;
// Audible, but low enough that narration will struggle against anything else in the mix.
export const QUIET_DBFS = -35;

export function describeLevel(peak: number | undefined): 'unknown' | 'silent' | 'quiet' | 'good' {
  if (peak === undefined) return 'unknown';
  if (peak < SILENT_DBFS) return 'silent';
  if (peak < QUIET_DBFS) return 'quiet';
  return 'good';
}

export interface AudioInput {
  id: string;
  name: string;
  isDefault: boolean;
}

// What the record dialog asks for. Both off by default: system audio picks up whatever
// happens to be playing, and the microphone needs a grant of its own. A schema rather
// than an interface because this arrives from the client over the local API.
export const audioOptionsSchema = z.object({
  system: z.boolean().default(false),
  microphone: z.boolean().default(false),
  // Checked against the real device list by macOS, which falls back to the default
  // input for anything it does not recognise.
  device: z.string().default(''),
});
export type AudioOptions = z.infer<typeof audioOptionsSchema>;

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
  // Defaulted rather than required, so bundles recorded before audio existed still load.
  audio: recordingAudioSchema.default({ system: false, microphone: false, device: '' }),
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
  // The capture helper gave up waiting for the movie to be finalised, so the file may be
  // short or unreadable. See RecDelegate in the capture helper.
  unfinalised?: boolean;
  // The video recorded but no cursor events arrived, so the cursor cannot be drawn.
  noCursorData?: boolean;
  // Absent when no audio was asked for. Carries the peaks, so a microphone that
  // recorded nothing can be reported instead of discovered on playback.
  audio?: RecordingAudio;
}

// What to say after a recording when something the user asked for did not arrive.
// Both cases look perfectly fine on playback until the moment they matter, which is why
// they are reported rather than left to be discovered.
export function recordingNotice(outcome: {
  unfinalised?: boolean;
  noCursorData?: boolean;
  audio?: RecordingAudio;
}): string | null {
  // First, because it is the only one that can leave a file that will not open at all.
  if (outcome.unfinalised) {
    return 'This recording did not finish writing, so it may be short or unreadable. Try recording again, and give it a moment to finish before opening it.';
  }
  if (outcome.noCursorData) {
    return 'This recording has no cursor data. Enable Accessibility for Frame Studio in System Settings, Privacy and Security, then record again.';
  }
  const audio = outcome.audio;
  if (!audio) return null;
  if (audio.microphoneBlocked) {
    return 'This recording has no narration: macOS has not allowed Frame Studio to use the microphone. Allow it in System Settings, Privacy and Security, Microphone, then record again.';
  }
  const silent: string[] = [];
  if (audio.microphone && describeLevel(audio.microphonePeak) === 'silent') {
    silent.push('microphone');
  }
  if (audio.system && describeLevel(audio.systemPeak) === 'silent') silent.push('system audio');
  if (!silent.length) return null;
  // One track carries both sources, so there is nothing to recover from the file. The
  // only useful thing to say is what to change before recording again.
  return `This recording picked up no sound from the ${silent.join(' or ')}. The two are mixed into one track as they are captured, so this cannot be fixed afterwards. Check the level in the record dialog before recording again.`;
}

// Electron's own vocabulary for a media grant, kept verbatim so there is no translation
// layer to get wrong.
export type MicrophoneAccess = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

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
  // Held by the app, and only needed when the microphone is switched on. Reported as
  // Electron sees it, which is the app's own identity rather than the helper's.
  microphone: MicrophoneAccess;
}

export interface RecordingService {
  // What the capture helper can actually see. These grants are keyed to code identity,
  // so a stale System Settings entry can read as enabled while the process is denied.
  permissions(): Promise<PermissionReport>;
  // Triggers the macOS Accessibility prompt and reports where things stand after it.
  requestCursorAccess(): Promise<PermissionReport>;
  // Triggers the macOS Microphone prompt. Only the first ever call shows a dialog; after
  // a denial macOS answers from its record and the user has to go to System Settings.
  requestMicrophoneAccess(): Promise<PermissionReport>;
  listDisplays(): Promise<DisplayInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  // uniqueIDs and names for every audio input. Needs no permission, so the picker can
  // be filled in before the microphone has ever been granted.
  listAudioInputs(): Promise<AudioInput[]>;
  // Opens an input so its level can be watched before recording starts. Asking again
  // with a different device switches to it rather than opening a second listener.
  startMicCheck(device: string): Promise<void>;
  stopMicCheck(): Promise<void>;
  // Polled by the renderer, like recording status. peak is dBFS since the last read.
  micLevel(): { listening: boolean; peak: number };
  // Opens the drag-to-select overlay. Resolves null when the user cancels.
  selectRegion(): Promise<CaptureRegion | null>;
  // Exactly one of displayID or windowID. A region narrows a display capture.
  start(target: {
    displayID?: number;
    windowID?: number;
    region?: CaptureRegion;
    audio?: AudioOptions;
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
