import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { defaultSettings } from '../shared/composition';
import { probeVideo } from '../server/media';
import type { Job } from '../shared/types';

let directory: string;
let studio: Awaited<ReturnType<typeof createApp>>;
let source: string;
const execute = promisify(execFile);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frame-studio-api-test-'));
  source = join(directory, 'fixture.mov');
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x180:r=24:d=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    source,
  ]);
  studio = await createApp({ directory });
});
afterAll(async () => {
  await studio?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function finished(id: string): Promise<Job> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await request(studio.app).get(`/api/jobs/${id}`);
    if (response.body.status !== 'processing') return response.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Video job did not finish.');
}

describe('local studio API', () => {
  it('blocks foreign origins and rejects mutations without the app header', async () => {
    expect(
      (await request(studio.app).get('/api/session').set('Origin', 'https://foreign.example'))
        .status,
    ).toBe(403);
    expect((await request(studio.app).post('/api/export').send({})).status).toBe(403);
    expect(
      (await request(studio.app).get('/api/session').set('Host', 'foreign.example')).status,
    ).toBe(403);
  });

  it('rejects a fake video by its contents and remains usable afterwards', async () => {
    const response = await request(studio.app)
      .post('/api/import')
      .set('X-Frame-Studio', '1')
      .attach('video', Buffer.from('not a video'), 'fake.mov');
    expect(response.status).toBe(202);
    const job = await finished(response.body.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/video|read|open/i);
    expect((await request(studio.app).get('/api/session')).body.asset).toBeNull();
  });

  it('imports video, supports byte-range preview, and exports a downloadable MP4', async () => {
    const imported = await request(studio.app)
      .post('/api/import')
      .set('X-Frame-Studio', '1')
      .attach('video', source);
    expect(imported.status).toBe(202);
    const job = await finished(imported.body.id);
    expect(job.status).toBe('ready');
    expect(job.asset).toMatchObject({ width: 320, height: 180, hasAudio: false });
    const preview = await request(studio.app).get(job.asset!.previewUrl).set('Range', 'bytes=0-99');
    expect(preview.status).toBe(206);
    expect(preview.headers['content-length']).toBe('100');
    const invalid = await request(studio.app)
      .post('/api/export')
      .set('X-Frame-Studio', '1')
      .send({
        assetId: job.asset!.id,
        settings: { ...defaultSettings, scale: -100 },
        resolution: 720,
        includeAudio: true,
      });
    expect(invalid.status).toBe(400);
    const exporting = await request(studio.app)
      .post('/api/export')
      .set('X-Frame-Studio', '1')
      .send({
        assetId: job.asset!.id,
        settings: { ...defaultSettings, ratio: '9:16' },
        resolution: 720,
        includeAudio: true,
      });
    expect(exporting.status).toBe(202);
    const exported = await finished(exporting.body.id);
    expect(exported.status).toBe('ready');
    const downloaded = await request(studio.app)
      .get(exported.downloadUrl!)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(downloaded.headers['content-disposition']).toMatch(/attachment/);
    const output = join(directory, 'downloaded.mp4');
    await writeFile(output, downloaded.body);
    expect(await probeVideo(output)).toMatchObject({ width: 720, height: 1280, hasAudio: false });
    expect((await readFile(source)).length).toBeGreaterThan(0);
    expect((await request(studio.app).get('/api/session')).body.asset.id).toBe(job.asset!.id);
    expect((await request(studio.app).get('/api/session')).body).toMatchObject({
      job: { status: 'ready', kind: 'export', downloadUrl: exported.downloadUrl },
    });
  });

  it('does not expose arbitrary files or accept an unknown source', async () => {
    expect((await request(studio.app).get('/api/media/unknown')).status).toBe(404);
    expect((await request(studio.app).get('/api/download/unknown')).status).toBe(404);
    expect(
      (
        await request(studio.app).post('/api/export').set('X-Frame-Studio', '1').send({
          assetId: '../../fixture.mov',
          settings: defaultSettings,
          resolution: 720,
          includeAudio: true,
        })
      ).status,
    ).toBe(404);
  });
});
