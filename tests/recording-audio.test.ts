import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRecorder } from '../desktop/recorder-bridge';
import {
  describeLevel,
  parseRecordingMeta,
  recordingNotice,
  LEVEL_FLOOR_DBFS,
  QUIET_DBFS,
  SILENT_DBFS,
} from '../shared/recording';

const directories: string[] = [];

async function fakeHelper(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frame-studio-audio-'));
  directories.push(dir);
  const path = join(dir, 'fake-recorder');
  await writeFile(path, `#!/usr/bin/env node\n${script}`);
  await chmod(path, 0o755);
  return path;
}

afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

// Levels arrive asynchronously through the helper's stdout, so waiting a fixed moment
// makes the test fail whenever the machine is busy. Wait for the condition instead.
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('describeLevel', () => {
  it('separates nothing at all from faint from usable', () => {
    // Measured on a real machine: a quiet room through a real microphone sits near
    // -74 dBFS, and a tone heard across the room reaches -43.
    expect(describeLevel(-74)).toBe('silent');
    expect(describeLevel(-43)).toBe('quiet');
    expect(describeLevel(-18)).toBe('good');
  });

  it('says nothing when there is no measurement, rather than guessing silence', () => {
    expect(describeLevel(undefined)).toBe('unknown');
  });

  it('puts the boundaries where the constants say they are', () => {
    expect(describeLevel(SILENT_DBFS)).toBe('quiet');
    expect(describeLevel(SILENT_DBFS - 0.1)).toBe('silent');
    expect(describeLevel(QUIET_DBFS)).toBe('good');
  });
});

describe('recordingNotice', () => {
  it('says nothing when the recording worked', () => {
    expect(recordingNotice({})).toBeNull();
    expect(
      recordingNotice({
        audio: { system: true, microphone: true, device: '', systemPeak: -20, microphonePeak: -18 },
      }),
    ).toBeNull();
  });

  it('reports a microphone that recorded nothing', () => {
    const notice = recordingNotice({
      audio: { system: false, microphone: true, device: '', microphonePeak: -120 },
    });
    expect(notice).toMatch(/microphone/);
    // The two sources are mixed as they are captured, so there is nothing to recover.
    expect(notice).toMatch(/cannot be fixed afterwards/);
  });

  it('never blames a source that was not asked for', () => {
    // A recording with the microphone off has no microphone peak, and reporting that as
    // silence would send someone hunting for a problem that does not exist.
    expect(
      recordingNotice({
        audio: { system: true, microphone: false, device: '', systemPeak: -12 },
      }),
    ).toBeNull();
  });

  it('names both sources when both were silent', () => {
    const notice = recordingNotice({
      audio: {
        system: true,
        microphone: true,
        device: '',
        systemPeak: -120,
        microphonePeak: -120,
      },
    });
    expect(notice).toMatch(/microphone or system audio/);
  });

  it('tells the user macOS blocked the microphone, rather than blaming the input', () => {
    // A recording that went ahead without the microphone because the grant was missing
    // is a different problem from one where the microphone was simply too quiet, and
    // the fix is in System Settings rather than in the room.
    const notice = recordingNotice({
      audio: { system: false, microphone: true, device: '', microphoneBlocked: true },
    });
    expect(notice).toMatch(/System Settings/);
    expect(notice).toMatch(/Microphone/);
  });

  it('puts a missing cursor track first, since it costs more than silence', () => {
    const notice = recordingNotice({
      noCursorData: true,
      audio: { system: false, microphone: true, device: '', microphonePeak: -120 },
    });
    expect(notice).toMatch(/Accessibility/);
  });
});

describe('recordingMetaSchema audio', () => {
  const base = {
    version: 1,
    displayScale: 2,
    displayPoints: { w: 1920, h: 1080 },
    videoStartOffset: 0.4,
    duration: 8,
    createdAt: '2026-09-15T00:00:00.000Z',
  };

  it('defaults to no audio, so bundles recorded before sound existed still load', () => {
    const meta = parseRecordingMeta(base);
    expect(meta.audio).toEqual({ system: false, microphone: false, device: '' });
  });

  it('keeps the peaks, which are the only record of what each source contributed', () => {
    const meta = parseRecordingMeta({
      ...base,
      audio: { system: true, microphone: true, device: 'BuiltIn', microphonePeak: -41.03 },
    });
    expect(meta.audio.microphonePeak).toBeCloseTo(-41.03, 2);
    expect(meta.audio.systemPeak).toBeUndefined();
  });
});

describe('createRecorder audio', () => {
  it('passes both switches and the chosen device to the helper', async () => {
    const binary = await fakeHelper(`
      process.stdin.on('data', (chunk) => {
        const command = JSON.parse(String(chunk));
        const a = command.audio || {};
        console.log(JSON.stringify(
          a.system === true && a.microphone === true && a.device === 'Razer'
            ? { event: 'started' }
            : { event: 'error', message: 'audio arrived as ' + JSON.stringify(a) }));
      });
    `);
    const recorder = createRecorder(binary);
    await expect(
      recorder.start({
        displayID: 1,
        outDir: '/tmp/x',
        startedAt: 1,
        audio: { system: true, microphone: true, device: 'Razer' },
      }),
    ).resolves.toBeUndefined();
    recorder.dispose();
  });

  it('carries the measured peaks back off the finished event', async () => {
    const binary = await fakeHelper(`
      process.stdin.on('data', () => {
        console.log(JSON.stringify({ event: 'finished', frames: 12, duration: 3, audio: {
          system: true, microphone: true, device: '', systemPeak: -40, microphonePeak: -120,
        } }));
      });
    `);
    const recorder = createRecorder(binary);
    const result = await recorder.stop();
    expect(result.audio?.microphonePeak).toBe(-120);
    expect(recordingNotice(result)).toMatch(/microphone/);
    recorder.dispose();
  });

  it('keeps the latest level without anything waiting on it', async () => {
    // Levels arrive unprompted and continuously, so a waiter would consume one and drop
    // the rest. The renderer polls for the most recent instead.
    const binary = await fakeHelper(`
      process.stdin.on('data', (chunk) => {
        const command = JSON.parse(String(chunk));
        if (command.cmd === 'mic-test') {
          console.log(JSON.stringify({ event: 'mic-test-started' }));
          console.log(JSON.stringify({ event: 'mic-level', peak: -55 }));
          console.log(JSON.stringify({ event: 'mic-level', peak: -21.5 }));
        }
        if (command.cmd === 'mic-test-stop') {
          console.log(JSON.stringify({ event: 'mic-test-stopped' }));
        }
      });
    `);
    const recorder = createRecorder(binary);
    // The floor, not the silence threshold: a meter that is never fed has to read as
    // empty rather than as a quarter of a bar of signal.
    expect(recorder.micLevel()).toEqual({ listening: false, peak: LEVEL_FLOOR_DBFS });
    await recorder.startMicCheck('');
    await until(() => recorder.micLevel().peak === -21.5, 'the second level');
    expect(recorder.micLevel()).toEqual({ listening: true, peak: -21.5 });
    await recorder.stopMicCheck();
    expect(recorder.micLevel().listening).toBe(false);
    recorder.dispose();
  });

  it('stops claiming to listen once a recording starts', async () => {
    // The helper takes the microphone for the recording itself, so a meter still
    // showing the last level it saw would be reporting a stream that no longer exists.
    const binary = await fakeHelper(`
      process.stdin.on('data', (chunk) => {
        const command = JSON.parse(String(chunk));
        if (command.cmd === 'mic-test') {
          console.log(JSON.stringify({ event: 'mic-test-started' }));
          console.log(JSON.stringify({ event: 'mic-level', peak: -20 }));
        }
        if (command.cmd === 'start') console.log(JSON.stringify({ event: 'started' }));
      });
    `);
    const recorder = createRecorder(binary);
    await recorder.startMicCheck('');
    await until(() => recorder.micLevel().peak === -20, 'a level');
    expect(recorder.micLevel().listening).toBe(true);
    await recorder.start({ displayID: 1, outDir: '/tmp/x', startedAt: 1 });
    expect(recorder.micLevel().listening).toBe(false);
    recorder.dispose();
  });

  it('lists inputs with the uniqueIDs the capture configuration needs', async () => {
    const binary = await fakeHelper(`
      process.stdin.on('data', () => {
        console.log(JSON.stringify({ event: 'audio-inputs', inputs: [
          { id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', isDefault: true },
        ] }));
      });
    `);
    const recorder = createRecorder(binary);
    const inputs = await recorder.listAudioInputs();
    expect(inputs[0].id).toBe('BuiltInMicrophoneDevice');
    expect(inputs[0].isDefault).toBe(true);
    recorder.dispose();
  });
});
