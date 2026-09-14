import { BrowserWindow, screen } from 'electron';

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  displayID: number;
}

// Drag-to-select overlay, the same gesture as Command Shift 4. A transparent window
// covers the display the pointer is on, the user drags a rectangle, and the result comes
// back in the display's own point coordinates.
//
// The page reports its result through document.title, which avoids giving the overlay a
// preload script and keeps it fully sandboxed.
export function selectRegion(): Promise<Region | null> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.bounds;

  return new Promise((resolve) => {
    const overlay = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      enableLargerThanScreen: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    let settled = false;
    const finish = (region: Region | null) => {
      if (settled) return;
      settled = true;
      resolve(region);
      if (!overlay.isDestroyed()) overlay.destroy();
    };

    // Floats above full screen apps so a region can be drawn over anything.
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Keep the overlay itself out of any recording that follows.
    overlay.setContentProtection(true);

    overlay.webContents.on('page-title-updated', (_event, title) => {
      if (title === 'cancel') {
        finish(null);
        return;
      }
      if (!title.startsWith('{')) return;
      try {
        const rect = JSON.parse(title) as { x: number; y: number; w: number; h: number };
        // Points are local to the overlay, so shift them into the display's space.
        finish({
          x: Math.round(bounds.x + rect.x),
          y: Math.round(bounds.y + rect.y),
          width: Math.round(rect.w),
          height: Math.round(rect.h),
          displayID: display.id,
        });
      } catch {
        finish(null);
      }
    });
    overlay.on('closed', () => finish(null));

    void overlay.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          html, body { width:100%; height:100%; overflow:hidden; cursor:crosshair;
                       background:rgba(10,10,14,0.32);
                       font:500 12px -apple-system,system-ui,sans-serif; color:#fff;
                       -webkit-user-select:none; user-select:none; }
          #box { position:fixed; display:none; border:1.5px solid #fff;
                 background:rgba(255,255,255,0.10);
                 box-shadow:0 0 0 9999px rgba(10,10,14,0.32); }
          #size { position:fixed; display:none; padding:4px 7px; border-radius:6px;
                  background:#16161c; font-variant-numeric:tabular-nums;
                  box-shadow:0 4px 14px rgba(0,0,0,0.45); white-space:nowrap; }
          #hint { position:fixed; left:50%; top:28px; transform:translateX(-50%);
                  padding:8px 14px; border-radius:9px; background:#16161c;
                  box-shadow:0 6px 20px rgba(0,0,0,0.5); }
        </style>
        <div id="hint">Drag to choose an area. Press Escape to cancel.</div>
        <div id="box"></div>
        <div id="size"></div>
        <script>
          const box = document.getElementById('box');
          const size = document.getElementById('size');
          const hint = document.getElementById('hint');
          let sx = 0, sy = 0, drawing = false;

          const rect = (e) => {
            const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
            return { x, y, w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy) };
          };
          const paint = (r) => {
            box.style.display = 'block';
            box.style.left = r.x + 'px'; box.style.top = r.y + 'px';
            box.style.width = r.w + 'px'; box.style.height = r.h + 'px';
            size.style.display = 'block';
            size.textContent = Math.round(r.w) + ' x ' + Math.round(r.h);
            // Keep the readout on screen when the drag reaches an edge.
            size.style.left = Math.min(r.x, window.innerWidth - 90) + 'px';
            size.style.top = (r.y > 34 ? r.y - 28 : r.y + r.h + 8) + 'px';
          };

          addEventListener('mousedown', (e) => {
            drawing = true; sx = e.clientX; sy = e.clientY;
            hint.style.display = 'none';
            paint(rect(e));
          });
          addEventListener('mousemove', (e) => { if (drawing) paint(rect(e)); });
          addEventListener('mouseup', (e) => {
            if (!drawing) return;
            drawing = false;
            const r = rect(e);
            // Ignore a stray click, which would otherwise start a zero sized recording.
            if (r.w < 24 || r.h < 24) {
              box.style.display = 'none'; size.style.display = 'none';
              hint.style.display = 'block';
              return;
            }
            document.title = JSON.stringify(r);
          });
          addEventListener('keydown', (e) => {
            if (e.key === 'Escape') document.title = 'cancel';
          });
        </script>
      `),
    );
    overlay.once('ready-to-show', () => overlay.focus());
  });
}
