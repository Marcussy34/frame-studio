import { describe, expect, it, vi } from 'vitest';
import type { CursorTracker } from '../desktop/cursor-track';
import type { Recorder } from '../desktop/recorder-bridge';
import { type ControllerDeps, createRecordingController } from '../desktop/recording-controller';

function tracker(overrides: Partial<CursorTracker> = {}): CursorTracker {
  return {
    permitted: vi.fn(() => true),
    requestPermission: vi.fn(() => true),
    start: vi.fn(() => 1_700_000_000),
    stop: vi.fn(),
    write: vi.fn(async () => ({ count: 2745, clicks: 8 })),
    ...overrides,
  };
}

// One place to build a helper stand-in, so a new command on the Recorder interface does
// not have to be repeated in every test that only cares about start and stop.
function recorder(overrides: Partial<Recorder> = {}): Recorder {
  return {
    permissions: vi.fn(),
    listDisplays: vi.fn(),
    listWindows: vi.fn(),
    listAudioInputs: vi.fn(async () => []),
    startMicCheck: vi.fn(async () => {}),
    stopMicCheck: vi.fn(async () => {}),
    micLevel: vi.fn(() => ({ listening: false, peak: -120 })),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ frames: 429, duration: 7.9 })),
    dispose: vi.fn(),
    ...overrides,
  };
}

function deps(overrides: Partial<ControllerDeps> = {}): ControllerDeps {
  return {
    recorder: recorder(),
    cursor: tracker(),
    hideWindow: vi.fn(),
    showWindow: vi.fn(),
    showStop: vi.fn(),
    hideStop: vi.fn(),
    registerShortcut: vi.fn(),
    unregisterShortcut: vi.fn(),
    onFinished: vi.fn(),
    ...overrides,
  };
}

describe('createRecordingController', () => {
  it('hides the window, shows the stop control and registers the hotkey on start', async () => {
    const injected = deps();
    const controller = createRecordingController(injected);
    await controller.start({ displayID: 1, outDir: '/tmp/x' });
    expect(injected.hideWindow).toHaveBeenCalled();
    expect(injected.showStop).toHaveBeenCalled();
    expect(injected.registerShortcut).toHaveBeenCalled();
    expect(controller.isRecording()).toBe(true);
  });

  it('opens the cursor track first and passes its origin to the helper', async () => {
    // The two halves of a bundle are lined up by this number, so the order matters:
    // listening has to begin before the helper does or the first moments are lost.
    const injected = deps();
    const controller = createRecordingController(injected);
    await controller.start({ displayID: 1, outDir: '/tmp/x' });
    expect(injected.cursor.start).toHaveBeenCalled();
    expect(injected.recorder.start).toHaveBeenCalledWith({
      displayID: 1,
      outDir: '/tmp/x',
      startedAt: 1_700_000_000,
    });
  });

  it('restores the window and reports the merged result on stop', async () => {
    const injected = deps();
    const controller = createRecordingController(injected);
    await controller.start({ displayID: 1, outDir: '/tmp/x' });
    const result = await controller.stop();
    // The helper counts frames, this process counts the cursor. Neither knows both.
    expect(result).toMatchObject({ frames: 429, duration: 7.9, samples: 2745, clicks: 8 });
    expect(result?.noCursorData).toBeUndefined();
    expect(injected.cursor.write).toHaveBeenCalledWith('/tmp/x/cursor.jsonl');
    expect(injected.hideStop).toHaveBeenCalled();
    expect(injected.unregisterShortcut).toHaveBeenCalled();
    expect(injected.showWindow).toHaveBeenCalled();
    expect(injected.onFinished).toHaveBeenCalledWith(result);
    expect(controller.isRecording()).toBe(false);
  });

  it('flags a recording that captured no cursor events', async () => {
    // The video looks perfectly fine in this case, so nothing else would reveal it.
    const injected = deps({
      cursor: tracker({ write: vi.fn(async () => ({ count: 0, clicks: 0 })) }),
    });
    const controller = createRecordingController(injected);
    await controller.start({ displayID: 1, outDir: '/tmp/x' });
    expect((await controller.stop())?.noCursorData).toBe(true);
  });

  it('stops listening even when the helper fails to finish', async () => {
    // A global input hook left running after a failure would keep watching the mouse
    // for the rest of the session.
    const cursor = tracker();
    const injected = deps({
      cursor,
      recorder: recorder({
        stop: vi.fn(async () => {
          throw new Error('recorder helper exited');
        }),
      }),
    });
    const controller = createRecordingController(injected);
    await controller.start({ displayID: 1, outDir: '/tmp/x' });
    await expect(controller.stop()).rejects.toThrow(/exited/);
    expect(cursor.stop).toHaveBeenCalled();
    expect(injected.showWindow).toHaveBeenCalled();
  });

  it('is idempotent, so the hotkey and the stop button cannot double stop', async () => {
    const injected = deps();
    const controller = createRecordingController(injected);
    await controller.start({ displayID: 1, outDir: '/tmp/x' });
    const [first, second] = await Promise.all([controller.stop(), controller.stop()]);
    expect(injected.recorder.stop).toHaveBeenCalledTimes(1);
    expect(first ?? second).toBeTruthy();
  });

  it('returns null when stopping while not recording', async () => {
    const controller = createRecordingController(deps());
    expect(await controller.stop()).toBeNull();
  });

  it('restores the window when start fails, so a denied permission cannot strand the user', async () => {
    const cursor = tracker();
    const injected = deps({
      cursor,
      recorder: recorder({
        start: vi.fn(async () => {
          throw new Error('permission required: screen-recording');
        }),
      }),
    });
    const controller = createRecordingController(injected);
    await expect(controller.start({ displayID: 1, outDir: '/tmp/x' })).rejects.toThrow(
      /screen-recording/,
    );
    expect(controller.isRecording()).toBe(false);
    expect(cursor.stop).toHaveBeenCalled();
    expect(injected.showWindow).toHaveBeenCalled();
    expect(injected.hideStop).toHaveBeenCalled();
  });

  it('restores the window when the cursor track cannot open', async () => {
    // Accessibility is refused here, which is now the failure that stops a recording
    // before it starts.
    const injected = deps({
      cursor: tracker({
        start: vi.fn(() => {
          throw new Error('Frame Studio needs Accessibility to record the cursor.');
        }),
      }),
    });
    const controller = createRecordingController(injected);
    await expect(controller.start({ displayID: 1, outDir: '/tmp/x' })).rejects.toThrow(
      /Accessibility/,
    );
    expect(controller.isRecording()).toBe(false);
    expect(injected.recorder.start).not.toHaveBeenCalled();
    expect(injected.showWindow).toHaveBeenCalled();
  });
});
