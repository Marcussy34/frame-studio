import { describe, expect, it, vi } from 'vitest';
import { type ControllerDeps, createRecordingController } from '../desktop/recording-controller';

function deps(overrides: Partial<ControllerDeps> = {}): ControllerDeps {
  return {
    recorder: {
      permissions: vi.fn(),
      listDisplays: vi.fn(),
      listWindows: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => ({ frames: 429, samples: 2745, clicks: 8, duration: 7.9 })),
      dispose: vi.fn(),
    },
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
    expect(injected.recorder.start).toHaveBeenCalledWith({ displayID: 1, outDir: '/tmp/x' });
    expect(injected.hideWindow).toHaveBeenCalled();
    expect(injected.showStop).toHaveBeenCalled();
    expect(injected.registerShortcut).toHaveBeenCalled();
    expect(controller.isRecording()).toBe(true);
  });

  it('restores the window and reports the result on stop', async () => {
    const injected = deps();
    const controller = createRecordingController(injected);
    await controller.start({ displayID: 1, outDir: '/tmp/x' });
    const result = await controller.stop();
    expect(result?.frames).toBe(429);
    expect(injected.hideStop).toHaveBeenCalled();
    expect(injected.unregisterShortcut).toHaveBeenCalled();
    expect(injected.showWindow).toHaveBeenCalled();
    expect(injected.onFinished).toHaveBeenCalledWith(result);
    expect(controller.isRecording()).toBe(false);
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
    const injected = deps({
      recorder: {
        permissions: vi.fn(),
        listDisplays: vi.fn(),
        listWindows: vi.fn(),
        start: vi.fn(async () => {
          throw new Error('permission required: screen-recording');
        }),
        stop: vi.fn(),
        dispose: vi.fn(),
      },
    });
    const controller = createRecordingController(injected);
    await expect(controller.start({ displayID: 1, outDir: '/tmp/x' })).rejects.toThrow(
      /screen-recording/,
    );
    expect(controller.isRecording()).toBe(false);
    expect(injected.showWindow).toHaveBeenCalled();
    expect(injected.hideStop).toHaveBeenCalled();
  });
});
