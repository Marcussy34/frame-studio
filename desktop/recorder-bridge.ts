import { type ChildProcess, spawn } from 'node:child_process';
import type { DisplayInfo, WindowInfo } from '../shared/recording';

export type { DisplayInfo, WindowInfo };

export interface RecordingResult {
  frames: number;
  samples: number;
  clicks: number;
  duration: number;
  // Present only when a display change stopped the stream early.
  interrupted?: string;
}

export interface Recorder {
  listDisplays(): Promise<DisplayInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  start(opts: { displayID?: number; windowID?: number; outDir: string }): Promise<void>;
  stop(): Promise<RecordingResult>;
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
        const index = waiters.findIndex((waiter) => waiter.match(event));
        if (index >= 0) waiters.splice(index, 1)[0].settle(event);
      }
    });
    next.on('exit', () => {
      child = null;
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
          else if (event.event === 'permission-required')
            reject(new Error(`permission required: ${String(event.permission)}`));
          else resolve(event);
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
    async listDisplays() {
      const reply = await send({ cmd: 'list-displays' }, (event) => event.event === 'displays');
      return reply.displays as DisplayInfo[];
    },
    async listWindows() {
      const reply = await send({ cmd: 'list-windows' }, (event) => event.event === 'windows');
      return reply.windows as WindowInfo[];
    },
    async start({ displayID, windowID, outDir }) {
      await send(
        windowID === undefined
          ? { cmd: 'start', display: displayID, out: outDir }
          : { cmd: 'start', window: windowID, out: outDir },
        (event) => event.event === 'started',
      );
    },
    async stop() {
      // Finalising writes the track and meta, so allow longer than a normal command.
      const reply = await send({ cmd: 'stop' }, (event) => event.event === 'finished', 60_000);
      return {
        frames: reply.frames as number,
        samples: reply.samples as number,
        clicks: reply.clicks as number,
        duration: reply.duration as number,
        interrupted: reply.interrupted as string | undefined,
      };
    },
    dispose() {
      child?.kill();
      child = null;
    },
  };
}
