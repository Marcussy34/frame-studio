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
    await expect(recorder.start({ displayID: 1, outDir: '/tmp/x', startedAt: 1 })).rejects.toThrow(
      /Screen Recording/,
    );
    recorder.dispose();
  });

  it('hands the helper the cursor track origin, so both halves share a timebase', async () => {
    // videoStartOffset is measured against this. Dropping it would silently misalign
    // the redrawn cursor by however long the stream took to warm up.
    const binary = await fakeHelper(`
      process.stdin.on('data', (chunk) => {
        const command = JSON.parse(String(chunk));
        console.log(JSON.stringify(command.startedAt === 1700000000.5
          ? { event: 'started' }
          : { event: 'error', message: 'startedAt arrived as ' + command.startedAt }));
      });
    `);
    const recorder = createRecorder(binary);
    await expect(
      recorder.start({ displayID: 1, outDir: '/tmp/x', startedAt: 1_700_000_000.5 }),
    ).resolves.toBeUndefined();
    recorder.dispose();
  });

  it('resolves stop with the finished totals', async () => {
    const binary = await fakeHelper(`
      let seen = 0;
      process.stdin.on('data', () => {
        seen += 1;
        if (seen === 1) console.log(JSON.stringify({ event: 'started' }));
        else console.log(JSON.stringify({ event: 'finished', frames: 429, duration: 7.9 }));
      });
    `);
    const recorder = createRecorder(binary);
    await recorder.start({ displayID: 1, outDir: '/tmp/x', startedAt: 1 });
    const result = await recorder.stop();
    expect(result.frames).toBe(429);
    expect(result.duration).toBe(7.9);
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
