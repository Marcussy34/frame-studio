import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  extractJson,
  parsePlan,
  summariseTrack,
} from '../desktop/zoom-planner/prompt';
import type { CursorEvent, RecordingMeta } from '../shared/recording';
import { planZoomHeuristically } from '../shared/zoom-heuristic';

const meta: RecordingMeta = {
  version: 1,
  captureKind: 'display',
  captureTitle: '',
  captureFrames: [],
  displayScale: 2,
  displayPoints: { w: 960, h: 540 },
  videoStartOffset: 0.5,
  duration: 20,
  createdAt: '2026-09-14T00:00:00.000Z',
  audio: { system: false, microphone: false, device: '' },
};

const shot = '{"start":1,"end":4,"zoom":2,"focus":"cursor","ease":"snap","why":"the button"}';

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"shots":[]}')).toBe('{"shots":[]}');
  });

  it('reads an object out of a code fence, which is what agy actually returned', () => {
    const reply = 'Here you go:\n```json\n{"shots":[]}\n```\nHope that helps.';
    expect(extractJson(reply)).toBe('{"shots":[]}');
  });

  it('keeps nested objects rather than stopping at the first closing brace', () => {
    const reply = `prose {"shots":[{"focus":{"x":0.5,"y":0.5}}]} more prose`;
    expect(extractJson(reply)).toBe('{"shots":[{"focus":{"x":0.5,"y":0.5}}]}');
  });

  it('is not fooled by braces inside strings', () => {
    const reply = '{"why":"the } button","shots":[]}';
    expect(extractJson(reply)).toBe(reply);
  });

  it('is not fooled by an escaped quote inside a string', () => {
    const reply = '{"why":"say \\"hi\\" }","shots":[]}';
    expect(extractJson(reply)).toBe(reply);
  });

  it('gives up on a truncated reply rather than returning half an object', () => {
    expect(extractJson('{"shots":[{"start":1,')).toBeNull();
  });

  it('gives up when there is no object at all', () => {
    expect(extractJson('I could not do that.')).toBeNull();
  });
});

describe('parsePlan', () => {
  it('accepts shots and supplies the envelope the model always forgets', () => {
    const plan = parsePlan(`{"shots":[${shot}]}`, 'flash');
    expect(plan?.source).toBe('model');
    expect(plan?.model).toBe('flash');
    expect(plan?.shots).toHaveLength(1);
  });

  it('accepts a fenced reply with prose around it', () => {
    const plan = parsePlan(`Sure.\n\`\`\`json\n{"shots":[${shot}]}\n\`\`\``, 'flash');
    expect(plan?.shots).toHaveLength(1);
  });

  it('returns null rather than throwing on anything unusable', () => {
    // Each of these must cost the fallback, never the recording.
    expect(parsePlan('nope', 'flash')).toBeNull();
    expect(parsePlan('{"shots":[{"start":1,', 'flash')).toBeNull();
    expect(parsePlan('{"shots":"lots"}', 'flash')).toBeNull();
    expect(
      parsePlan('{"shots":[{"start":1,"end":4,"zoom":99,"focus":"cursor"}]}', 'flash'),
    ).toBeNull();
  });

  it('treats an empty plan as a failure, since the automatic zoom serves better', () => {
    expect(parsePlan('{"shots":[]}', 'flash')).toBeNull();
  });
});

describe('summariseTrack', () => {
  function events(): CursorEvent[] {
    return [
      { t: 0.2, x: 0, y: 0, e: 'm', b: -1 },
      { t: 0.4, x: 30, y: 40, e: 'm', b: -1 }, // 50pt of travel
      { t: 1.0, x: 30, y: 40, e: 'd', b: 0 },
      { t: 1.2, x: 60, y: 40, e: 'm', b: -1 }, // dragging, button still down
      { t: 1.4, x: 60, y: 40, e: 'u', b: 0 },
      { t: 2.0, x: 60, y: 40, e: 'd', b: 0 },
      { t: 2.3, x: 60, y: 40, e: 'd', b: 0 },
    ];
  }

  it('counts clicks in the second they happened', () => {
    const seconds = summariseTrack(events(), 4);
    expect(seconds[1].clicks).toBe(1);
    expect(seconds[2].clicks).toBe(2);
    expect(seconds[3].clicks).toBe(0);
  });

  it('measures how far the pointer travelled', () => {
    expect(summariseTrack(events(), 4)[0].travel).toBeCloseTo(50, 0);
  });

  it('marks a drag, which reads differently from a click', () => {
    const seconds = summariseTrack(events(), 4);
    expect(seconds[1].dragging).toBe(true);
    expect(seconds[0].dragging).toBe(false);
  });

  it('covers the whole clip even where nothing happened', () => {
    expect(summariseTrack([], 5)).toHaveLength(6);
  });
});

describe('buildPrompt', () => {
  const draft = planZoomHeuristically({
    events: [{ t: 2, x: 300, y: 200, e: 'd', b: 0 }],
    settings: { enabled: true, strength: 2.5, speed: 55 },
    duration: 20,
    displayScale: 2,
    frames: [],
    source: { width: 1920, height: 1080 },
  });

  function prompt(overrides: Partial<Parameters<typeof buildPrompt>[0]> = {}) {
    return buildPrompt({
      meta,
      events: [{ t: 2, x: 300, y: 200, e: 'd', b: 0 }],
      duration: 20,
      source: { width: 1920, height: 1080 },
      frameTimes: [0, 1.7, 2.5],
      draft,
      ...overrides,
    });
  }

  it('tells the model how to map a filename back to a moment', () => {
    expect(prompt()).toContain('t-0002400.jpg');
  });

  it('hands over the draft so the model edits rather than invents', () => {
    expect(prompt()).toContain('"zoom"');
    expect(prompt()).toContain('A STARTING POINT');
  });

  it('states the clip bounds the reply has to respect', () => {
    expect(prompt()).toContain('0 to 20.0 seconds');
  });

  it('says when the capture is already cropped, so shots are not planned off frame', () => {
    const windowed = prompt({ meta: { ...meta, captureKind: 'window' } });
    expect(windowed).toContain('already cropped');
    expect(prompt()).toContain('a whole display');
  });

  it('includes the per-second track rather than the raw events', () => {
    const text = prompt();
    expect(text).toContain('2s, 1 click');
    // A real track is tens of thousands of events and would crowd out the frames.
    expect(text.length).toBeLessThan(20_000);
  });
});
