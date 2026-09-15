import { type ChildProcess, spawn } from 'node:child_process';
import {
  LEVEL_FLOOR_DBFS,
  type AudioInput,
  type AudioOptions,
  type DisplayInfo,
  type RecordingAudio,
  type WindowInfo,
} from '../shared/recording';

export type { AudioInput, AudioOptions, DisplayInfo, WindowInfo };

// What the helper alone can report. The cursor half of a recording is produced in the
// Electron main process, so samples and clicks are merged in by the controller.
export interface CaptureResult {
  frames: number;
  duration: number;
  // Present only when a display change stopped the stream early.
  interrupted?: string;
  // The helper gave up waiting for the movie to be finalised.
  unfinalised?: boolean;
  // Absent when no audio was asked for.
  audio?: RecordingAudio;
}

export interface Recorder {
  // What the helper can see for itself. Its view of the microphone matters because it is
  // the process that opens the input, and because it is read fresh on every call, unlike
  // Electron's, which caches for the life of the process.
  permissions(): Promise<{ screenRecording: boolean; microphone: boolean }>;
  listDisplays(): Promise<DisplayInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  listAudioInputs(): Promise<AudioInput[]>;
  startMicCheck(device: string): Promise<void>;
  stopMicCheck(): Promise<void>;
  // The helper reports levels unprompted while listening, so the latest one is kept
  // here rather than asked for, which is what makes polling cheap.
  micLevel(): { listening: boolean; peak: number };
  start(opts: {
    displayID?: number;
    windowID?: number;
    region?: { x: number; y: number; width: number; height: number };
    outDir: string;
    // Seconds since epoch. The cursor track's t=0, handed over so the helper measures
    // videoStartOffset against the same origin.
    startedAt: number;
    audio?: AudioOptions;
  }): Promise<void>;
  stop(): Promise<CaptureResult>;
  dispose(): void;
}

interface Waiter {
  match: (event: Record<string, unknown>) => boolean;
  settle: (event: Record<string, unknown>) => void;
  fail: (error: Error) => void;
}

// One helper process per recorder. Events arrive as newline delimited JSON, so waiters
// are keyed by the event they expect rather than by call order.
export function createRecorder(binaryPath: string): Recorder {
  let child: ChildProcess | null = null;
  let buffer = '';
  const waiters: Waiter[] = [];
  // Nothing waits on a level: the helper sends them continuously while listening and
  // the renderer polls for the latest, the same shape as recording status.
  let listening = false;
  let peak = LEVEL_FLOOR_DBFS;

  function ensure(): ChildProcess {
    if (child) return child;
    const next = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    next.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.event === 'mic-level') {
          peak = Number(event.peak);
          continue;
        }
        const index = waiters.findIndex((waiter) => waiter.match(event));
        if (index >= 0) waiters.splice(index, 1)[0].settle(event);
      }
    });
    next.on('exit', () => {
      child = null;
      listening = false;
      // Fail anything still waiting so callers never hang on a dead helper.
      while (waiters.length) waiters.pop()!.fail(new Error('recorder helper exited'));
    });
    next.on('error', (error) => {
      while (waiters.length) waiters.pop()!.fail(error);
    });
    child = next;
    return next;
  }

  function send(
    command: object,
    wanted: (event: Record<string, unknown>) => boolean,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> {
    const process = ensure();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('recorder timed out')), timeoutMs);
      waiters.push({
        // Errors and permission prompts can arrive in place of any expected reply.
        match: (event) =>
          wanted(event) || event.event === 'error' || event.event === 'permission-required',
        settle: (event) => {
          clearTimeout(timer);
          if (event.event === 'error') reject(new Error(String(event.message)));
          else if (event.event === 'permission-required') {
            // macOS needs the process restarted after this grant before capture works,
            // so the message has to say so.
            reject(
              new Error(
                'Frame Studio needs Screen Recording. Enable it in System Settings, Privacy and Security, Screen and System Audio Recording, then quit and reopen Frame Studio.',
              ),
            );
          } else resolve(event);
        },
        fail: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      process.stdin?.write(JSON.stringify(command) + '\n');
    });
  }

  return {
    async permissions() {
      const reply = await send({ cmd: 'permissions' }, (event) => event.event === 'permissions');
      return {
        screenRecording: reply.screenRecording as boolean,
        // Absent from helpers built before audio existed, which reads as not granted.
        microphone: reply.microphone === true,
      };
    },
    async listDisplays() {
      const reply = await send({ cmd: 'list-displays' }, (event) => event.event === 'displays');
      return reply.displays as DisplayInfo[];
    },
    async listWindows() {
      const reply = await send({ cmd: 'list-windows' }, (event) => event.event === 'windows');
      return reply.windows as WindowInfo[];
    },
    async listAudioInputs() {
      const reply = await send(
        { cmd: 'list-audio-inputs' },
        (event) => event.event === 'audio-inputs',
      );
      return reply.inputs as AudioInput[];
    },
    async startMicCheck(device) {
      // Reset first, so a device that turns out to be silent shows silence rather than
      // the previous device's level until its first buffer arrives.
      peak = LEVEL_FLOOR_DBFS;
      await send({ cmd: 'mic-test', device }, (event) => event.event === 'mic-test-started');
      listening = true;
    },
    async stopMicCheck() {
      listening = false;
      peak = LEVEL_FLOOR_DBFS;
      // Never let a failed stop leave the dialog stuck: the check is a convenience and
      // the helper drops it on quit anyway.
      await send({ cmd: 'mic-test-stop' }, (event) => event.event === 'mic-test-stopped').catch(
        () => {},
      );
    },
    micLevel() {
      return { listening, peak };
    },
    async start({ displayID, windowID, region, outDir, startedAt, audio }) {
      // The helper stops any microphone check itself when a recording starts, but the
      // meter here would otherwise keep reporting the last level it saw.
      listening = false;
      const target =
        windowID === undefined
          ? { display: displayID, ...(region ? { region } : {}) }
          : { window: windowID };
      const command = {
        cmd: 'start',
        out: outDir,
        startedAt,
        ...target,
        ...(audio ? { audio } : {}),
      };
      await send(command, (event) => event.event === 'started');
    },
    async stop() {
      // Finalising writes the meta, so allow longer than a normal command.
      const reply = await send({ cmd: 'stop' }, (event) => event.event === 'finished', 60_000);
      return {
        frames: reply.frames as number,
        duration: reply.duration as number,
        interrupted: reply.interrupted as string | undefined,
        ...(reply.unfinalised === true ? { unfinalised: true } : {}),
        audio: reply.audio as RecordingAudio | undefined,
      };
    },
    dispose() {
      child?.kill();
      child = null;
    },
  };
}
