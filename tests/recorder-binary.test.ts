import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
let binary: string;

// The build script prints only the output path, so the tests can locate the binary
// without duplicating the staging directory layout.
async function buildRecorder(): Promise<string> {
  const { stdout } = await execute('node', ['desktop/recorder/build.mjs']);
  return stdout.trim();
}

beforeAll(async () => {
  binary = await buildRecorder();
}, 180_000);

// Sends one command and resolves with the first JSON line the helper writes back.
function ask(command: object, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, []);
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timed out waiting for a reply'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n').find((candidate) => candidate.trim().length > 0);
      if (!line) return;
      clearTimeout(timer);
      child.kill();
      resolve(JSON.parse(line));
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(JSON.stringify(command) + '\n');
  });
}

describe('frame-recorder', () => {
  it('lists at least one display with positive dimensions and a scale factor', async () => {
    const reply = await ask({ cmd: 'list-displays' });
    expect(reply.event).toBe('displays');
    const displays = reply.displays as {
      id: number;
      width: number;
      height: number;
      scale: number;
      name: string;
    }[];
    expect(Array.isArray(displays)).toBe(true);
    expect(displays.length).toBeGreaterThan(0);
    expect(displays[0].width).toBeGreaterThan(0);
    expect(displays[0].height).toBeGreaterThan(0);
    expect(displays[0].scale).toBeGreaterThan(0);
    expect(typeof displays[0].id).toBe('number');
  }, 40_000);

  it('replies with an error event for an unknown command rather than exiting silently', async () => {
    const reply = await ask({ cmd: 'nonsense' });
    expect(reply.event).toBe('error');
    expect(typeof reply.message).toBe('string');
  }, 40_000);
});
