import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AudioInput,
  AudioOptions,
  CaptureRegion,
  DisplayInfo,
  MicrophoneAccess,
  RecordingOutcome,
  RecordingService,
  WindowInfo,
} from '../shared/recording';
import type { CursorTracker } from './cursor-track';
import type { Recorder } from './recorder-bridge';
import { createRecordingController } from './recording-controller';

export interface RecordingServiceDeps {
  recorder: Recorder;
  // Records the cursor in this process. The helper cannot: input grants are keyed to
  // the calling binary, and a bare executable is not something macOS can grant.
  cursor: CursorTracker;
  // Directory that holds one subdirectory per recording bundle.
  root: string;
  hideWindow: () => void;
  showWindow: () => void;
  showStop: (onStop: () => void) => void;
  hideStop: () => void;
  registerShortcut: (handler: () => void) => void;
  unregisterShortcut: () => void;
  selectRegion: () => Promise<CaptureRegion | null>;
  // Asked of Electron rather than of the helper, because this grant belongs to the app
  // bundle. Injected so the service stays testable without an Electron runtime.
  microphoneAccess: () => MicrophoneAccess;
  askForMicrophone: () => Promise<boolean>;
}

// Bundle ids are timestamps, which sorts them naturally and avoids a counter that
// would have to survive a restart.
function newBundleId(now = new Date()): string {
  return `recording-${now.toISOString().replace(/[:.]/g, '-')}`;
}

// Electron caches its answer for the life of the process: granting the microphone while
// the app is running leaves getMediaAccessStatus reporting 'not-determined' until the next
// launch, which would keep the record dialog insisting it had never asked. The helper
// reads the grant fresh every time and is the process that actually opens the input, so it
// wins. Electron's answer still supplies the difference between never asked and refused.
function microphoneGrant(helperSees: boolean, electronSees: MicrophoneAccess): MicrophoneAccess {
  return helperSees ? 'granted' : electronSees;
}

export function createRecordingService(deps: RecordingServiceDeps): RecordingService {
  let currentId: string | null = null;
  let last: RecordingOutcome | null = null;

  const controller = createRecordingController({
    recorder: deps.recorder,
    cursor: deps.cursor,
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

    // The halves of a recording answer to different grants and different processes, so
    // the report is composed from all of them rather than asked of one.
    async permissions() {
      const { screenRecording, microphone } = await deps.recorder.permissions();
      return {
        screenRecording,
        accessibility: deps.cursor.permitted(),
        microphone: microphoneGrant(microphone, deps.microphoneAccess()),
      };
    },

    async requestCursorAccess() {
      const accessibility = deps.cursor.requestPermission();
      const { screenRecording, microphone } = await deps.recorder.permissions();
      return {
        screenRecording,
        accessibility,
        microphone: microphoneGrant(microphone, deps.microphoneAccess()),
      };
    },

    async requestMicrophoneAccess() {
      // The answer is ignored in favour of reading the status back: a denial and a
      // never-asked both come back false here, and only the status tells them apart.
      await deps.askForMicrophone().catch(() => false);
      const { screenRecording, microphone } = await deps.recorder.permissions();
      return {
        screenRecording,
        accessibility: deps.cursor.permitted(),
        microphone: microphoneGrant(microphone, deps.microphoneAccess()),
      };
    },

    listWindows(): Promise<WindowInfo[]> {
      return deps.recorder.listWindows();
    },

    listAudioInputs(): Promise<AudioInput[]> {
      return deps.recorder.listAudioInputs();
    },

    startMicCheck(device: string): Promise<void> {
      return deps.recorder.startMicCheck(device);
    },

    stopMicCheck(): Promise<void> {
      return deps.recorder.stopMicCheck();
    },

    micLevel() {
      return deps.recorder.micLevel();
    },

    selectRegion(): Promise<CaptureRegion | null> {
      return deps.selectRegion();
    },

    async start(target: {
      displayID?: number;
      windowID?: number;
      region?: CaptureRegion;
      audio?: AudioOptions;
    }) {
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
