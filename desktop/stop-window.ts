import { BrowserWindow, screen } from 'electron';

let stopWindow: BrowserWindow | null = null;

// A small always-on-top control. The main window hides during a recording, so the
// global hotkey alone would leave no visible way to finish.
export function showStopWindow(onStop: () => void) {
  if (stopWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  const panel = new BrowserWindow({
    width: 160,
    height: 54,
    x: area.x + area.width - 184,
    y: area.y + 24,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // Keep the stop button out of the recording it is controlling.
  panel.setContentProtection(true);
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void panel.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`
        <style>
          body { margin:0; height:100vh; display:flex; align-items:center;
                 justify-content:center; background:#1b1b22; color:#fff;
                 font:600 13px -apple-system,system-ui,sans-serif;
                 -webkit-app-region:drag; }
          button { -webkit-app-region:no-drag; background:#e5484d; color:#fff; border:0;
                   border-radius:7px; padding:9px 14px; font:inherit; cursor:pointer; }
        </style>
        <button onclick="window.close()">Stop recording</button>
      `),
  );
  panel.on('closed', () => {
    // Closing is the stop gesture, whether the user clicked or something else
    // destroyed the panel.
    if (stopWindow === panel) {
      stopWindow = null;
      onStop();
    }
  });
  stopWindow = panel;
}

export function hideStopWindow() {
  const current = stopWindow;
  // Cleared first so the closed handler does not report this as a user stop.
  stopWindow = null;
  current?.destroy();
}
