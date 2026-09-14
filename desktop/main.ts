import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeTheme, session } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { access } from 'node:fs/promises';
import { constants, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { startDesktopRuntime } from './runtime';
import { canvasStorageKey } from '../shared/composition';
import type { RecordingService } from '../shared/recording';
import { createRecorder } from './recorder-bridge';
import { createRecordingService } from './recording-service';
import { hideStopWindow, showStopWindow } from './stop-window';

const STOP_HOTKEY = 'CommandOrControl+Shift+/';
let recorderProcess: ReturnType<typeof createRecorder> | undefined;

app.setName('Frame Studio');
const profile = app.commandLine.getSwitchValue('user-data-dir');
if (profile) {
  mkdirSync(resolve(profile), { recursive: true });
  app.setPath('userData', resolve(profile));
  app.setPath('sessionData', resolve(profile));
}

let window: BrowserWindow | null = null;
let runtime: Awaited<ReturnType<typeof startDesktopRuntime>> | undefined;
let startup = Promise.resolve();
let quitRequested = false;
let mayQuit = false;
let closing: Promise<void> | undefined;

async function latestCanvas() {
  if (!window || window.webContents.isDestroyed()) return undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      window.webContents.executeJavaScript(
        `document.documentElement.dataset.desktopPreferencesReady === "true" ? localStorage.getItem(${JSON.stringify(canvasStorageKey)}) : null`,
      ),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 1000);
      }),
    ]);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.restore();
    window?.show();
    window?.focus();
  });
  app.on('activate', () => {
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (mayQuit) return;
    event.preventDefault();
    quitRequested = true;
    // Electron must wait for exports and file cleanup before closing its runtime.
    closing ??= (async () => {
      await startup.catch(() => {});
      try {
        await runtime?.close(await latestCanvas());
      } catch (error) {
        console.error('Desktop cleanup failed:', error);
      } finally {
        // Release the stop hotkey and the helper process before the app goes away.
        globalShortcut.unregisterAll();
        hideStopWindow();
        recorderProcess?.dispose();
        mayQuit = true;
        app.quit();
      }
    })();
  });

  startup = app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    const media = app.isPackaged
      ? dirname(process.execPath)
      : join(app.getAppPath(), '..', 'media', 'MacOS');
    const ffmpeg = join(media, 'ffmpeg');
    const ffprobe = join(media, 'ffprobe');
    await Promise.all([access(ffmpeg, constants.X_OK), access(ffprobe, constants.X_OK)]);
    process.env.FRAME_FFMPEG_PATH = ffmpeg;
    process.env.FRAME_FFPROBE_PATH = ffprobe;
    // Recording is additive, so a missing helper disables it rather than stopping the
    // app from importing and exporting as usual.
    const recorder = join(media, 'frame-recorder');
    try {
      await access(recorder, constants.X_OK);
      process.env.FRAME_RECORDER_PATH = recorder;
    } catch {
      console.warn('Screen recording is unavailable: the capture helper was not bundled.');
    }
    // Recording bundles live beside the canvas preferences so they survive restarts.
    const recordingsRoot = join(app.getPath('userData'), 'recordings');
    mkdirSync(recordingsRoot, { recursive: true });
    let recording: RecordingService | undefined;
    if (process.env.FRAME_RECORDER_PATH) {
      recorderProcess = createRecorder(process.env.FRAME_RECORDER_PATH);
      recording = createRecordingService({
        recorder: recorderProcess,
        root: recordingsRoot,
        hideWindow: () => window?.hide(),
        showWindow: () => window?.show(),
        showStop: (onStop) => showStopWindow(onStop),
        hideStop: () => hideStopWindow(),
        registerShortcut: (handler) => void globalShortcut.register(STOP_HOTKEY, handler),
        unregisterShortcut: () => globalShortcut.unregister(STOP_HOTKEY),
      });
    }

    const { startDesktopRuntime } = await import('./runtime');
    runtime = await startDesktopRuntime({
      rendererPath: join(app.getAppPath(), 'renderer'),
      preferencesPath: join(app.getPath('userData'), 'canvas.json'),
      recording,
      recordingsRoot,
    });
    if (quitRequested) return;
    const origin = runtime.origin;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (event, item) => {
      const url = new URL(item.getURL());
      if (url.origin !== origin || !url.pathname.startsWith('/api/download/')) {
        event.preventDefault();
        return;
      }
      item.setSaveDialogOptions({
        title: 'Save your framed video',
        defaultPath: join(app.getPath('downloads'), item.getFilename()),
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      item.once('done', (_event, state) => {
        if (state === 'interrupted' && !quitRequested)
          dialog.showErrorBox(
            'Video could not be saved',
            'Choose Download MP4 again and select a writable location.',
          );
      });
    });
    window = new BrowserWindow({
      width: 1400,
      height: 960,
      minWidth: 800,
      minHeight: 620,
      title: 'Frame Studio',
      backgroundColor: '#151618',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: !app.isPackaged,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.once('ready-to-show', () => {
      if (!quitRequested) window?.show();
    });
    // Keep the renderer alive long enough to capture its newest settings on window close.
    window.on('close', (event) => {
      if (!mayQuit) {
        event.preventDefault();
        app.quit();
      }
    });
    window.on('closed', () => {
      window = null;
    });

    const menu: MenuItemConstructorOptions[] = [
      { role: 'appMenu' },
      {
        label: 'File',
        submenu: [
          {
            id: 'import-video',
            label: 'Import video…',
            accelerator: 'CmdOrCtrl+O',
            click: () => {
              // A fixed DOM action opens Chromium's native file picker without exposing Node APIs.
              void window?.webContents.executeJavaScript(
                'document.querySelector("[data-testid=video-input]")?.click()',
                true,
              );
            },
          },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
    await window.loadURL(origin);
  });
  void startup.catch((error) => {
    console.error('Frame Studio could not start:', error);
    if (!quitRequested)
      dialog.showErrorBox(
        'Frame Studio could not start',
        'The local video workspace could not be opened. Check that the application bundle is complete and that your disk has free space.',
      );
    app.quit();
  });
}
