import { writeFile } from 'node:fs/promises';
import type {
  uIOhook,
  UiohookKeyboardEvent,
  UiohookMouseEvent,
  UiohookWheelEvent,
} from 'uiohook-napi';
import type { CursorEvent } from '../shared/recording';

// Why the cursor is tracked here rather than in the capture helper:
//
// macOS resolves Screen Recording against the RESPONSIBLE process, so the helper
// inherits the app's grant. Input tapping is resolved against the CALLING binary, and
// a bare executable inside Contents/MacOS is not a bundle, so it can never be granted.
// The helper's tap was created successfully and then never fed a single event, which
// produced a perfect video with an empty cursor track and no error anywhere.
//
// Running the tap in the Electron main process makes the calling process the app
// itself, which is something the user can actually grant.

// The slice of uiohook-napi used here. Taking the hook as a dependency keeps this file
// testable without loading a native module.
export type InputHook = Pick<typeof uIOhook, 'on' | 'off' | 'start' | 'stop'>;

// libuiohook event type numbers. Everything is read off the catch-all 'input' event so
// there is one listener, one buffer and one guaranteed ordering between moves and
// clicks, rather than three listeners writing into the same array.
const MOUSE_PRESSED = 7;
const MOUSE_RELEASED = 8;
const MOUSE_MOVED = 9;
// uiohook-napi rewrites dragged to moved before the event reaches JavaScript, so this
// never arrives in practice. Handled anyway, because that rewrite is an implementation
// detail and losing drags would freeze the cursor for the whole of every drag.
const MOUSE_DRAGGED = 10;

export interface CursorTracker {
  // Whether this process may tap input right now. libuiohook refuses to run without
  // Accessibility, so that is the grant that matters, not Input Monitoring.
  permitted(): boolean;
  // Asks macOS to show its Accessibility prompt, which carries the only reliable link
  // into the right System Settings pane. Reports whether the grant is already in place.
  requestPermission(): boolean;
  // Starts listening and returns the recording's time origin as seconds since epoch.
  // The capture helper is handed the same origin so both halves of the bundle agree
  // on what t=0 means.
  start(): number;
  stop(): void;
  // Writes cursor.jsonl and reports what was captured.
  write(path: string): Promise<{ count: number; clicks: number }>;
}

export interface CursorTrackerDeps {
  hook: InputHook;
  // Prompting is the caller's choice: the record dialog checks quietly, the grant
  // button asks macOS to put its own "Open System Settings" dialog on screen.
  trusted: (prompt: boolean) => boolean;
}

// libuiohook numbers buttons 1 left, 2 right, 3 middle. The bundle format counts from
// zero and lumps everything past right into "other".
function buttonOf(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : 1;
  if (value <= 1) return 0;
  return value === 2 ? 1 : 2;
}

export function createCursorTracker(deps: CursorTrackerDeps): CursorTracker {
  let events: CursorEvent[] = [];
  let origin = 0;
  let listening = false;
  const held = new Set<number>();

  const record = (event: UiohookKeyboardEvent | UiohookMouseEvent | UiohookWheelEvent) => {
    // Compared as plain numbers because the exported enum has no member for the
    // dragged type.
    const kind = event.type as number;
    const button = kind === MOUSE_PRESSED || kind === MOUSE_RELEASED;
    if (!button && kind !== MOUSE_MOVED && kind !== MOUSE_DRAGGED) return;

    // Narrowed by the type check above: only mouse events reach this point.
    const mouse = event as UiohookMouseEvent;
    // Global points, top-left origin, the same space the capture helper records the
    // capture rect in. libuiohook truncates them to whole points; the spring smoothing
    // in shared/cursor.ts absorbs that.
    const at = { t: (performance.now() - origin) / 1000, x: mouse.x, y: mouse.y };
    if (!button) {
      events.push({ ...at, e: 'm', b: -1 });
      return;
    }

    const b = buttonOf(mouse.button);
    // libuiohook reports the RELEASE of any button past right as another press: its
    // darwin kCGEventOtherMouseUp branch calls process_button_pressed. Left and right
    // are handled correctly, so this only bites on middle and extra buttons, where the
    // phantom press would fire a second click ripple and a second zoom trigger. A
    // button already down can only be going up, which reconstructs what happened.
    const e: CursorEvent['e'] = kind === MOUSE_RELEASED || held.has(b) ? 'u' : 'd';
    if (e === 'd') held.add(b);
    else held.delete(b);
    events.push({ ...at, e, b });
  };

  return {
    permitted: () => deps.trusted(false),

    requestPermission: () => deps.trusted(true),

    start() {
      events = [];
      held.clear();
      // Monotonic within the track, pinned to the wall clock only at the origin, so a
      // clock adjustment mid recording cannot bend the cursor timeline.
      origin = performance.now();
      const startedAt = Date.now() / 1000;
      deps.hook.on('input', record);
      try {
        deps.hook.start();
      } catch (cause) {
        deps.hook.off('input', record);
        // libuiohook prompts for Accessibility itself and then refuses to run, so the
        // system dialog and this message arrive together.
        throw new Error(
          'Frame Studio needs Accessibility to record the cursor. Enable it in System Settings, Privacy and Security, Accessibility, then start recording again.',
          { cause },
        );
      }
      listening = true;
      return startedAt;
    },

    stop() {
      if (!listening) return;
      listening = false;
      deps.hook.off('input', record);
      deps.hook.stop();
    },

    async write(path) {
      const ordered = [...events].sort((a, b) => a.t - b.t);
      const lines = ordered.map((event) => JSON.stringify(event));
      await writeFile(path, lines.length ? lines.join('\n') + '\n' : '');
      return { count: ordered.length, clicks: ordered.filter((event) => event.e === 'd').length };
    },
  };
}
