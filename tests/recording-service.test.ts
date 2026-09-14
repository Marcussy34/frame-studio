import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { CursorTracker } from '../desktop/cursor-track';
import type { Recorder } from '../desktop/recorder-bridge';
import { createRecordingService, type RecordingServiceDeps } from '../desktop/recording-service';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

function recorder(overrides: Partial<Recorder> = {}): Recorder {
  return {
    permissions: vi.fn(async () => ({ screenRecording: true })),
    listDisplays: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ frames: 429, duration: 7.9 })),
    dispose: vi.fn(),
    ...overrides,
  };
}

function cursor(overrides: Partial<CursorTracker> = {}): CursorTracker {
  return {
    permitted: vi.fn(() => true),
    requestPermission: vi.fn(() => true),
    start: vi.fn(() => 1_700_000_000),
    stop: vi.fn(),
    write: vi.fn(async () => ({ count: 2745, clicks: 8 })),
    ...overrides,
  };
}

async function service(overrides: Partial<RecordingServiceDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'frame-studio-service-'));
  directories.push(root);
  const deps: RecordingServiceDeps = {
    recorder: recorder(),
    cursor: cursor(),
    root,
    hideWindow: vi.fn(),
    showWindow: vi.fn(),
    showStop: vi.fn(),
    hideStop: vi.fn(),
    registerShortcut: vi.fn(),
    unregisterShortcut: vi.fn(),
    selectRegion: vi.fn(async () => null),
    ...overrides,
  };
  return { service: createRecordingService(deps), deps, root };
}

describe('createRecordingService', () => {
  it('composes the permission report from both processes', async () => {
    // The two halves of a recording answer to different grants: the helper holds Screen
    // Recording, this process holds Accessibility. Neither can speak for the other.
    const { service: recording } = await service({
      recorder: recorder({ permissions: vi.fn(async () => ({ screenRecording: true })) }),
      cursor: cursor({ permitted: vi.fn(() => false) }),
    });
    expect(await recording.permissions()).toEqual({
      screenRecording: true,
      accessibility: false,
    });
  });

  it('asks for cursor access without a recording being started', async () => {
    const tracker = cursor({ requestPermission: vi.fn(() => false) });
    const { service: recording } = await service({ cursor: tracker });
    expect(await recording.requestCursorAccess()).toEqual({
      screenRecording: true,
      accessibility: false,
    });
    expect(tracker.requestPermission).toHaveBeenCalled();
    expect(tracker.start).not.toHaveBeenCalled();
  });

  it('creates a bundle directory and reports the outcome under its id', async () => {
    const { service: recording, root } = await service();
    const { id } = await recording.start({ displayID: 1 });
    expect(await readdir(root)).toContain(id);
    const outcome = await recording.stop();
    expect(outcome).toMatchObject({ id, frames: 429, samples: 2745, clicks: 8 });
  });

  it('keeps the last outcome for the renderer to collect after a hotkey stop', async () => {
    // Stop can come from the floating button or the hotkey, with nobody asking, so the
    // result has to wait somewhere for the poll to find it.
    const { service: recording } = await service();
    const { id } = await recording.start({ displayID: 1 });
    await recording.stop();
    expect(recording.status()).toMatchObject({ recording: false, last: { id } });
  });

  it('does not leave a half started recording behind when start fails', async () => {
    const { service: recording } = await service({
      recorder: recorder({
        start: vi.fn(async () => {
          throw new Error('Frame Studio needs Screen Recording.');
        }),
      }),
    });
    await expect(recording.start({ displayID: 1 })).rejects.toThrow(/Screen Recording/);
    expect(recording.status()).toEqual({ recording: false, last: null });
  });
});
