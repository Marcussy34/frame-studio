import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { createApp } from './app';
import { runProcess } from './media';

const port = Number(process.env.FRAME_PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('FRAME_PORT must be between 1024 and 65535.');

try {
  await Promise.all([
    runProcess(process.env.FRAME_FFMPEG_PATH || 'ffmpeg', ['-version']),
    runProcess(process.env.FRAME_FFPROBE_PATH || 'ffprobe', ['-version']),
  ]);
} catch {
  console.error('Frame Studio needs FFmpeg. Install it with: brew install ffmpeg');
  process.exit(1);
}

const directory = await mkdtemp(join(tmpdir(), 'frame-studio-session-'));
const studio = await createApp({ directory });
const server = createServer(studio.app);
let vite: Awaited<ReturnType<(typeof import('vite'))['createServer']>> | undefined;

if (process.env.NODE_ENV === 'production') {
  studio.app.use(express.static(resolve('dist')));
  studio.app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server }, fs: { allow: [resolve('.')] } },
    appType: 'spa',
  });
  studio.app.use(vite.middlewares);
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await studio.close();
  server.closeAllConnections();
  await vite?.close();
  await rm(directory, { recursive: true, force: true });
}

// npm can forward a signal the process group already received. Keep cleanup idempotent.
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
server.on('error', (error) => {
  console.error(error.message);
  void shutdown().then(() => {
    process.exitCode = 1;
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(
    `\n  Frame Studio\n  http://127.0.0.1:${port}\n\n  Your videos stay on this Mac. Press Ctrl+C to quit.\n`,
  );
  if (process.argv.includes('--open'))
    void runProcess('open', [`http://127.0.0.1:${port}`]).catch(() => {});
});
