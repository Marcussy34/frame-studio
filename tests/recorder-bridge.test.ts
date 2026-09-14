import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRecorder } from '../desktop/recorder-bridge';

const directories: string[] = [];

// Drives the bridge against a stand-in helper, so these tests need no display and
// no granted permission.
async function fakeHelper(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frame-studio-fake-'));
  directories.push(dir);
  const path = join(dir, 'fake-recorder');
  await writeFile(path, `#!/usr/bin/env node\n${script}`);
  await chmod(path, 0o755);
  return path;
}

afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createRecorder', () => {
  it('lists displays', async () => {
    const binary = await fakeHelper(`
      process.stdin.on('data', () => {
        console.log(JSON.stringify({ event: 'displays', displays: [
          { id: 1, width: 1920, height: 1080, scale: 2, name: 'Built-in' },
        ] }));
      });
    `);
    const recorder = createRecorder(binary);
    const displays = await recorder.listDisplays();
    expect(displays[0].name).toBe('Built-in');
    recorder.dispose();
  });

  it('names the Screen Recording pane when that permission is missing', async () => {
    const binary = await fakeHelper(`
      process.stdin.on('data', () => {
        console.log(JSON.stringify({
          event: 'permission-required', permission: 'screen-recording', needsRestart: true,
        }));
      });
    `);
    const recorder = createRecorder(binary);
    await expect(recorder.start({ displayID: 1, outDir: '/tmp/x' })).rejects.toThrow(
      /Screen Recording/,
    );
    recorder.dispose();
  });

  it('names the Input Monitoring pane instead when that is the missing one', async () => {
    // These live in different System Settings panes, and Input Monitoring is not
    // guessable from the symptom, so the message has to say which.
    const binary = await fakeHelper(`
      process.stdin.on('data', () => {
        console.log(JSON.stringify({
          event: 'permission-required', permission: 'input-monitoring', needsRestart: true,
        }));
      });
    `);
    const recorder = createRecorder(binary);
    await expect(recorder.start({ displayID: 1, outDir: '/tmp/x' })).rejects.toThrow(
      /Input Monitoring/,
    );
    recorder.dispose();
  });

  it('reports a recording that captured no cursor events', async () => {
    const binary = await fakeHelper(`
      let seen = 0;
      process.stdin.on('data', () => {
        seen += 1;
        if (seen === 1) console.log(JSON.stringify({ event: 'started', tapInstalled: true }));
        else console.log(JSON.stringify({
          event: 'finished', frames: 100, samples: 0, clicks: 0, duration: 3, noCursorData: true,
        }));
      });
    `);
    const recorder = createRecorder(binary);
    await recorder.start({ displayID: 1, outDir: '/tmp/x' });
    expect((await recorder.stop()).noCursorData).toBe(true);
    recorder.dispose();
  });

  it('resolves stop with the finished totals', async () => {
    const binary = await fakeHelper(`
      let seen = 0;
      process.stdin.on('data', () => {
        seen += 1;
        if (seen === 1) console.log(JSON.stringify({ event: 'started', tapInstalled: true }));
        else console.log(JSON.stringify({
          event: 'finished', frames: 429, samples: 2745, clicks: 8, duration: 7.9,
        }));
      });
    `);
    const recorder = createRecorder(binary);
    await recorder.start({ displayID: 1, outDir: '/tmp/x' });
    const result = await recorder.stop();
    expect(result.frames).toBe(429);
    expect(result.clicks).toBe(8);
    recorder.dispose();
  });

  it('surfaces an error event as a rejection rather than hanging', async () => {
    const binary = await fakeHelper(`
      process.stdin.on('data', () => {
        console.log(JSON.stringify({ event: 'error', message: 'display 9 not found' }));
      });
    `);
    const recorder = createRecorder(binary);
    await expect(recorder.listDisplays()).rejects.toThrow(/display 9 not found/);
    recorder.dispose();
  });

  it('fails pending calls when the helper exits, so callers never hang on a dead process', async () => {
    const binary = await fakeHelper(`process.stdin.on('data', () => process.exit(1));`);
    const recorder = createRecorder(binary);
    await expect(recorder.listDisplays()).rejects.toThrow(/exited/);
    recorder.dispose();
  });
});
