import { bundlePaths, type RecordingOutcome } from '../shared/recording';
import type { CursorTracker } from './cursor-track';
import type { Recorder } from './recorder-bridge';

// A finished recording, before the bundle id is attached.
export type RecordingResult = Omit<RecordingOutcome, 'id'>;

export interface ControllerDeps {
  recorder: Recorder;
  cursor: CursorTracker;
  hideWindow: () => void;
  showWindow: () => void;
  showStop: (onStop: () => void) => void;
  hideStop: () => void;
  registerShortcut: (handler: () => void) => void;
  unregisterShortcut: () => void;
  onFinished: (result: RecordingResult) => void;
}

export interface RecordingController {
  start(opts: {
    displayID?: number;
    windowID?: number;
    region?: { x: number; y: number; width: number; height: number };
    outDir: string;
  }): Promise<void>;
  stop(): Promise<RecordingResult | null>;
  isRecording(): boolean;
}

// The Electron wiring is injected so this logic can be tested without a packaged app,
// a real display, or a granted permission.
export function createRecordingController(deps: ControllerDeps): RecordingController {
  let recording = false;
  let stopping: Promise<RecordingResult | null> | null = null;
  let outDir = '';

  async function stop(): Promise<RecordingResult | null> {
    // The hotkey and the floating button can both fire, so collapse them onto one
    // in-flight stop instead of asking the helper to finish twice.
    if (stopping) return stopping;
    if (!recording) return null;
    recording = false;
    const dir = outDir;
    stopping = (async () => {
      deps.unregisterShortcut();
      deps.hideStop();
      try {
        let capture;
        try {
          // The cursor keeps being tracked until the helper has finished, so the track
          // covers the whole video rather than stopping just short of its last frame.
          capture = await deps.recorder.stop();
        } finally {
          // Never leave a global input hook running, even if the helper failed.
          deps.cursor.stop();
        }
        const track = await deps.cursor.write(bundlePaths(dir).track);
        const result: RecordingResult = {
          ...capture,
          samples: track.count,
          clicks: track.clicks,
          // The video looks perfectly fine when this happens, so nothing else would
          // reveal it.
          ...(track.count === 0 ? { noCursorData: true } : {}),
        };
        deps.onFinished(result);
        return result;
      } finally {
        deps.showWindow();
        stopping = null;
      }
    })();
    return stopping;
  }

  return {
    async start(opts) {
      deps.hideWindow();
      outDir = opts.outDir;
      // The cursor listener goes first so nothing is missed while the capture helper
      // spins up, and its origin becomes the timebase for the whole bundle.
      let startedAt: number;
      try {
        startedAt = deps.cursor.start();
      } catch (error) {
        deps.showWindow();
        throw error;
      }
      try {
        await deps.recorder.start({ ...opts, startedAt });
      } catch (error) {
        // A refused permission must never leave the window hidden with no way back.
        deps.cursor.stop();
        deps.hideStop();
        deps.showWindow();
        recording = false;
        throw error;
      }
      recording = true;
      deps.showStop(() => void stop());
      deps.registerShortcut(() => void stop());
    },
    stop,
    isRecording: () => recording,
  };
}
