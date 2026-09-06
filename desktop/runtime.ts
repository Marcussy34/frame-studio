import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createPreferencesStore } from './preferences';
import { settingsSchema } from '../shared/composition';

export async function startDesktopRuntime({
  rendererPath,
  preferencesPath,
  sessionRoot = tmpdir(),
}: {
  rendererPath: string;
  preferencesPath: string;
  sessionRoot?: string;
}) {
  await readFile(join(rendererPath, 'index.html'));
  const preferences = await createPreferencesStore(preferencesPath);
  const directory = await mkdtemp(join(sessionRoot, 'frame-studio-desktop-session-'));
  // Configure bundled executable paths before importing the video API.
  let studio: Awaited<ReturnType<(typeof import('../server/app'))['createApp']>>;
  try {
    const { createApp } = await import('../server/app');
    studio = await createApp({ directory, preferences });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const shell = express();
  shell.disable('x-powered-by');
  shell.use((_req, res, next) => {
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
    );
    next();
  });
  shell.use(studio.app);
  shell.use(express.static(rendererPath));
  shell.get('/', (_req, res) => res.sendFile(join(rendererPath, 'index.html')));
  const server = createServer(shell);
  let closing: Promise<void> | undefined;
  const close = (latestPreferences?: unknown) =>
    (closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      await studio.close();
      server.closeAllConnections();
      await stopped;
      // Commit the visible canvas last, after older requests can no longer change it.
      const latest = settingsSchema.safeParse(latestPreferences);
      try {
        if (latest.success) await preferences.write(latest.data);
        else await preferences.flush();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, directory, close };
}
