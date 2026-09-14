import type { Recorder, RecordingResult } from './recorder-bridge';

export interface ControllerDeps {
  recorder: Recorder;
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

  async function stop(): Promise<RecordingResult | null> {
    // The hotkey and the floating button can both fire, so collapse them onto one
    // in-flight stop instead of asking the helper to finish twice.
    if (stopping) return stopping;
    if (!recording) return null;
    recording = false;
    stopping = (async () => {
      deps.unregisterShortcut();
      deps.hideStop();
      try {
        const result = await deps.recorder.stop();
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
      try {
        await deps.recorder.start(opts);
      } catch (error) {
        // A refused permission must never leave the window hidden with no way back.
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
