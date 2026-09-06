import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { defaultSettings } from '../shared/composition';

it('stops an active export and removes the session when the app receives a shutdown signal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-studio-shutdown-test-'));
  const fixture = join(directory, 'source.mov');
  await promisify(execFile)('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=320x180:r=24:d=2',
    '-c:v',
    'libx264',
    fixture,
  ]);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const service = spawn('npm', ['run', 'dev'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FRAME_PORT: String(port), TMPDIR: directory },
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = { 'X-Frame-Studio': '1' };
  const eventually = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The app did not complete the expected lifecycle transition.');
  };
  try {
    await eventually(async () =>
      fetch(endpoint + '/api/session').then(
        (response) => response.ok,
        () => false,
      ),
    );
    const form = new FormData();
    form.append('video', new Blob([await readFile(fixture)]), 'shutdown.mov');
    const importing = await (
      await fetch(endpoint + '/api/import', { method: 'POST', headers, body: form })
    ).json();
    let assetId = '';
    await eventually(async () => {
      const job = await (await fetch(endpoint + '/api/jobs/' + importing.id)).json();
      assetId = job.asset?.id ?? '';
      return job.status === 'ready';
    });
    const exporting = await (
      await fetch(endpoint + '/api/export', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId,
          settings: defaultSettings,
          resolution: 2160,
          includeAudio: false,
        }),
      })
    ).json();
    expect(exporting.status).toBe('processing');
    process.kill(-service.pid!, 'SIGTERM');
    // Observe filesystem cleanup, not just the parent process exiting.
    await eventually(
      async () =>
        !(await readdir(directory)).some((name) => name.startsWith('frame-studio-session-')),
    );
  } finally {
    try {
      process.kill(-service.pid!, 'SIGKILL');
    } catch {
      /* The owned process group has already exited. */
    }
    await rm(directory, { recursive: true, force: true });
  }
});
