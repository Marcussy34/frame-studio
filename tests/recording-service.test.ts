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
    permissions: vi.fn(async () => ({ screenRecording: true, microphone: false })),
    listDisplays: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
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
    microphoneAccess: vi.fn(() => 'granted' as const),
    askForMicrophone: vi.fn(async () => true),
    ...overrides,
  };
  return { service: createRecordingService(deps), deps, root };
}

describe('createRecordingService', () => {
  it('composes the permission report from every process that holds a grant', async () => {
    // The halves of a recording answer to different grants: the helper holds Screen
    // Recording, this process holds Accessibility. Neither can speak for the other.
    const { service: recording } = await service({
      recorder: recorder({
        permissions: vi.fn(async () => ({ screenRecording: true, microphone: false })),
      }),
      cursor: cursor({ permitted: vi.fn(() => false) }),
      microphoneAccess: vi.fn(() => 'denied' as const),
    });
    expect(await recording.permissions()).toEqual({
      screenRecording: true,
      accessibility: false,
      microphone: 'denied',
    });
  });

  it('believes the helper over Electron when the microphone grant is fresh', async () => {
    // Measured on a real machine: granting the microphone while the app is running leaves
    // getMediaAccessStatus reporting 'not-determined' until the next launch, because
    // Electron caches it for the life of the process. The helper reads it fresh and is
    // the process that actually opens the input, so it wins. Without this the record
    // dialog goes on insisting it has never asked, and refuses to start the meter.
    const { service: recording } = await service({
      recorder: recorder({
        permissions: vi.fn(async () => ({ screenRecording: true, microphone: true })),
      }),
      microphoneAccess: vi.fn(() => 'not-determined' as const),
    });
    expect((await recording.permissions()).microphone).toBe('granted');
  });

  it("keeps Electron's answer when the helper cannot use the microphone either", async () => {
    // Electron is the only one that can tell a refusal from a question never asked, which
    // is the difference between offering a button and pointing at System Settings.
    const { service: recording } = await service({
      recorder: recorder({
        permissions: vi.fn(async () => ({ screenRecording: true, microphone: false })),
      }),
      microphoneAccess: vi.fn(() => 'denied' as const),
    });
    expect((await recording.permissions()).microphone).toBe('denied');
  });

  it('asks for cursor access without a recording being started', async () => {
    const tracker = cursor({ requestPermission: vi.fn(() => false) });
    const { service: recording } = await service({ cursor: tracker });
    expect(await recording.requestCursorAccess()).toEqual({
      screenRecording: true,
      accessibility: false,
      microphone: 'granted',
    });
    expect(tracker.requestPermission).toHaveBeenCalled();
    expect(tracker.start).not.toHaveBeenCalled();
  });

  it('reads the microphone grant back rather than trusting what the prompt returned', async () => {
    // askForMediaAccess answers false both for a fresh denial and for a grant that was
    // already refused long ago, so only the status afterwards is worth reporting.
    const ask = vi.fn(async () => false);
    const { service: recording } = await service({
      askForMicrophone: ask,
      microphoneAccess: vi.fn(() => 'denied' as const),
    });
    const report = await recording.requestMicrophoneAccess();
    expect(ask).toHaveBeenCalled();
    expect(report.microphone).toBe('denied');
  });

  it('still reports a grant when the prompt itself throws', async () => {
    // A prompt that fails must not take the whole permission check down with it.
    const { service: recording } = await service({
      askForMicrophone: vi.fn(async () => {
        throw new Error('no window to attach the prompt to');
      }),
      microphoneAccess: vi.fn(() => 'granted' as const),
    });
    expect((await recording.requestMicrophoneAccess()).microphone).toBe('granted');
  });

  it('stays busy until the outcome is published, so a poll cannot read the one before', async () => {
    // isRecording goes false the instant a stop begins, but the movie is still being
    // finalised and the cursor track still being written. A renderer told "not
    // recording" in that window reads the PREVIOUS outcome and opens the wrong bundle
    // with the wrong warning, which is exactly what happened in practice.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service: recording } = await service({
      recorder: recorder({
        stop: vi.fn(async () => {
          await held;
          return { frames: 12, duration: 2 };
        }),
      }),
    });
    await recording.start({ displayID: 1 });
    const stopping = recording.stop();
    // Mid stop: the helper has not finished, so nothing may be reported as ready yet.
    expect(recording.status().recording).toBe(true);
    expect(recording.status().last).toBeNull();
    release();
    await stopping;
    expect(recording.status().recording).toBe(false);
    expect(recording.status().last?.frames).toBe(12);
  });

  it('forgets the previous outcome when a new recording starts', async () => {
    // A recording that fails before publishing anything must leave the renderer with
    // nothing, rather than the recording before it.
    const { service: recording } = await service();
    await recording.start({ displayID: 1 });
    await recording.stop();
    expect(recording.status().last).not.toBeNull();
    await recording.start({ displayID: 1 });
    expect(recording.status().last).toBeNull();
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
