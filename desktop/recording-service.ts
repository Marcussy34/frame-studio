import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CaptureRegion,
  DisplayInfo,
  RecordingOutcome,
  RecordingService,
  WindowInfo,
} from '../shared/recording';
import type { Recorder } from './recorder-bridge';
import { createRecordingController } from './recording-controller';

export interface RecordingServiceDeps {
  recorder: Recorder;
  // Directory that holds one subdirectory per recording bundle.
  root: string;
  hideWindow: () => void;
  showWindow: () => void;
  showStop: (onStop: () => void) => void;
  hideStop: () => void;
  registerShortcut: (handler: () => void) => void;
  unregisterShortcut: () => void;
  selectRegion: () => Promise<CaptureRegion | null>;
}

// Bundle ids are timestamps, which sorts them naturally and avoids a counter that
// would have to survive a restart.
function newBundleId(now = new Date()): string {
  return `recording-${now.toISOString().replace(/[:.]/g, '-')}`;
}

export function createRecordingService(deps: RecordingServiceDeps): RecordingService {
  let currentId: string | null = null;
  let last: RecordingOutcome | null = null;

  const controller = createRecordingController({
    recorder: deps.recorder,
    hideWindow: deps.hideWindow,
    showWindow: deps.showWindow,
    showStop: deps.showStop,
    hideStop: deps.hideStop,
    registerShortcut: deps.registerShortcut,
    unregisterShortcut: deps.unregisterShortcut,
    // The hotkey and the floating button can finish a recording without the renderer
    // asking, so the outcome is stored for the renderer to pick up when it polls.
    onFinished: (result) => {
      last = { id: currentId ?? 'unknown', ...result };
      currentId = null;
    },
  });

  return {
    listDisplays(): Promise<DisplayInfo[]> {
      return deps.recorder.listDisplays();
    },

    listWindows(): Promise<WindowInfo[]> {
      return deps.recorder.listWindows();
    },

    selectRegion(): Promise<CaptureRegion | null> {
      return deps.selectRegion();
    },

    async start(target: { displayID?: number; windowID?: number; region?: CaptureRegion }) {
      const id = newBundleId();
      const outDir = join(deps.root, id);
      await mkdir(outDir, { recursive: true });
      currentId = id;
      try {
        await controller.start({ ...target, outDir });
      } catch (error) {
        currentId = null;
        throw error;
      }
      return { id };
    },

    async stop() {
      const id = currentId;
      const result = await controller.stop();
      if (!result) return last;
      const outcome: RecordingOutcome = { id: id ?? 'unknown', ...result };
      last = outcome;
      return outcome;
    },

    status() {
      return { recording: controller.isRecording(), last };
    },
  };
}
