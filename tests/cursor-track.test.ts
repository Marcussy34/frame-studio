import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createCursorTracker, type InputHook } from '../desktop/cursor-track';
import { parseCursorTrack } from '../shared/recording';

// libuiohook event type numbers, repeated here on purpose: if the constants in
// cursor-track.ts ever drift, these tests should fail rather than follow along.
const PRESSED = 7;
const RELEASED = 8;
const MOVED = 9;
const DRAGGED = 10;
const KEY_PRESSED = 4;

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frame-studio-cursor-'));
  directories.push(dir);
  return dir;
}

// Stands in for the native hook, so these tests need no permission and no display.
function fakeHook(overrides: Partial<InputHook> = {}) {
  const emitter = new EventEmitter();
  const hook = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  } as unknown as InputHook;
  const send = (event: Record<string, unknown>) => emitter.emit('input', event);
  return { hook, send, emitter };
}

describe('createCursorTracker', () => {
  it('records moves, drags, presses and releases in the bundle format', async () => {
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    send({ type: MOVED, x: 100, y: 200, button: 0 });
    // uiohook-napi rewrites dragged to moved before JavaScript sees it, so this shape
    // never arrives today. Covered anyway: if that rewrite ever goes, dropping drags
    // would freeze the cursor for the whole of every drag.
    send({ type: DRAGGED, x: 110, y: 210, button: 1 });
    send({ type: PRESSED, x: 120, y: 220, button: 1 });
    send({ type: RELEASED, x: 120, y: 220, button: 1 });
    tracker.stop();

    const dir = await scratch();
    const result = await tracker.write(join(dir, 'cursor.jsonl'));
    expect(result).toEqual({ count: 4, clicks: 1 });

    const events = parseCursorTrack(await readFile(join(dir, 'cursor.jsonl'), 'utf8'));
    expect(events.map((event) => event.e)).toEqual(['m', 'm', 'd', 'u']);
    expect(events[1]).toMatchObject({ x: 110, y: 210, e: 'm', b: -1 });
    expect(events[2]).toMatchObject({ x: 120, y: 220, e: 'd', b: 0 });
  });

  it('maps libuiohook buttons onto the bundle format, which counts from zero', async () => {
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    send({ type: PRESSED, x: 1, y: 1, button: 1 }); // left
    send({ type: PRESSED, x: 1, y: 1, button: 2 }); // right
    send({ type: PRESSED, x: 1, y: 1, button: 3 }); // middle
    tracker.stop();
    const dir = await scratch();
    await tracker.write(join(dir, 'cursor.jsonl'));
    const events = parseCursorTrack(await readFile(join(dir, 'cursor.jsonl'), 'utf8'));
    expect(events.map((event) => event.b)).toEqual([0, 1, 2]);
  });

  it('reads a repeated press of a held button as the release it really is', async () => {
    // libuiohook reports the release of any button past right as another press, in its
    // darwin kCGEventOtherMouseUp branch. Left over, that phantom press fires a second
    // click ripple and a second zoom trigger on every middle click.
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    send({ type: PRESSED, x: 1, y: 1, button: 3 });
    send({ type: PRESSED, x: 1, y: 1, button: 3 });
    send({ type: PRESSED, x: 1, y: 1, button: 3 });
    tracker.stop();
    const dir = await scratch();
    expect(await tracker.write(join(dir, 'cursor.jsonl'))).toEqual({ count: 3, clicks: 2 });
    const events = parseCursorTrack(await readFile(join(dir, 'cursor.jsonl'), 'utf8'));
    expect(events.map((event) => event.e)).toEqual(['d', 'u', 'd']);
  });

  it('leaves a normal press and release alone, and tracks buttons apart', async () => {
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    send({ type: PRESSED, x: 1, y: 1, button: 1 });
    send({ type: PRESSED, x: 1, y: 1, button: 2 });
    send({ type: RELEASED, x: 1, y: 1, button: 1 });
    send({ type: RELEASED, x: 1, y: 1, button: 2 });
    send({ type: PRESSED, x: 1, y: 1, button: 1 });
    tracker.stop();
    const dir = await scratch();
    await tracker.write(join(dir, 'cursor.jsonl'));
    const events = parseCursorTrack(await readFile(join(dir, 'cursor.jsonl'), 'utf8'));
    expect(events.map((event) => `${event.e}${event.b}`)).toEqual(['d0', 'd1', 'u0', 'u1', 'd0']);
  });

  it('forgets which buttons were down when a new recording starts', async () => {
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    send({ type: PRESSED, x: 1, y: 1, button: 1 });
    tracker.stop();
    tracker.start();
    // A press that opens a recording must never be read as a release of something
    // left over from the previous one.
    send({ type: PRESSED, x: 1, y: 1, button: 1 });
    tracker.stop();
    const dir = await scratch();
    expect(await tracker.write(join(dir, 'cursor.jsonl'))).toEqual({ count: 1, clicks: 1 });
  });

  it('ignores keyboard and wheel traffic', async () => {
    // The hook sees every input event in the session. Only the mouse belongs in a
    // recording, and nothing else should ever reach disk.
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    send({ type: KEY_PRESSED, keycode: 30 });
    send({ type: 11, x: 5, y: 5, rotation: 1 });
    send({ type: MOVED, x: 7, y: 8, button: 0 });
    tracker.stop();
    const dir = await scratch();
    expect(await tracker.write(join(dir, 'cursor.jsonl'))).toEqual({ count: 1, clicks: 0 });
  });

  it('times events from the start of the track, not from epoch', async () => {
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    const startedAt = tracker.start();
    send({ type: MOVED, x: 1, y: 1, button: 0 });
    tracker.stop();
    const dir = await scratch();
    await tracker.write(join(dir, 'cursor.jsonl'));
    const events = parseCursorTrack(await readFile(join(dir, 'cursor.jsonl'), 'utf8'));
    expect(events[0].t).toBeGreaterThanOrEqual(0);
    expect(events[0].t).toBeLessThan(5);
    // The origin itself is wall clock, because the capture helper measures
    // videoStartOffset against it from a different process.
    expect(startedAt).toBeGreaterThan(1_600_000_000);
  });

  it('drops events from a previous recording when a new one starts', async () => {
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    send({ type: MOVED, x: 1, y: 1, button: 0 });
    tracker.stop();
    tracker.start();
    send({ type: MOVED, x: 2, y: 2, button: 0 });
    tracker.stop();
    const dir = await scratch();
    expect(await tracker.write(join(dir, 'cursor.jsonl'))).toEqual({ count: 1, clicks: 0 });
  });

  it('stops listening once stopped, so nothing leaks between recordings', async () => {
    const { hook, send } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    tracker.stop();
    send({ type: MOVED, x: 9, y: 9, button: 0 });
    const dir = await scratch();
    expect(await tracker.write(join(dir, 'cursor.jsonl'))).toEqual({ count: 0, clicks: 0 });
  });

  it('explains the missing grant rather than passing the native error through', async () => {
    // libuiohook refuses to run without Accessibility and throws a bare
    // UIOHOOK_ERROR_AXAPI_DISABLED, which means nothing to anyone.
    const { hook } = fakeHook({
      start: vi.fn(() => {
        throw new Error('UIOHOOK_ERROR_AXAPI_DISABLED');
      }),
    });
    const tracker = createCursorTracker({ hook, trusted: () => false });
    expect(() => tracker.start()).toThrow(/Accessibility/);
  });

  it('does not leave a listener attached when starting fails', async () => {
    const { hook, emitter } = fakeHook({
      start: vi.fn(() => {
        throw new Error('UIOHOOK_ERROR_AXAPI_DISABLED');
      }),
    });
    const tracker = createCursorTracker({ hook, trusted: () => false });
    expect(() => tracker.start()).toThrow();
    expect(emitter.listenerCount('input')).toBe(0);
  });

  it('writes an empty file rather than a stray newline when nothing was captured', async () => {
    const { hook } = fakeHook();
    const tracker = createCursorTracker({ hook, trusted: () => true });
    tracker.start();
    tracker.stop();
    const dir = await scratch();
    await tracker.write(join(dir, 'cursor.jsonl'));
    expect(await readFile(join(dir, 'cursor.jsonl'), 'utf8')).toBe('');
  });

  it('reports whether this process may tap input at all', () => {
    const { hook } = fakeHook();
    expect(createCursorTracker({ hook, trusted: () => true }).permitted()).toBe(true);
    expect(createCursorTracker({ hook, trusted: () => false }).permitted()).toBe(false);
  });

  it('checks quietly but asks loudly, so opening a dialog never raises a system prompt', () => {
    const { hook } = fakeHook();
    const trusted = vi.fn(() => false);
    const tracker = createCursorTracker({ hook, trusted });
    tracker.permitted();
    expect(trusted).toHaveBeenLastCalledWith(false);
    tracker.requestPermission();
    expect(trusted).toHaveBeenLastCalledWith(true);
  });
});
