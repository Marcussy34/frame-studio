import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { zoomAt, zoomExpressions } from '../shared/cursor';
import type { CursorEvent } from '../shared/recording';
import {
  compileZoomPlan,
  normalisePlan,
  zoomCurveFor,
  zoomPlanSchema,
  type ZoomPlan,
} from '../shared/zoom-plan';

const execute = promisify(execFile);

function plan(shots: ZoomPlan['shots']): ZoomPlan {
  return {
    version: 1,
    source: 'heuristic',
    model: '',
    createdAt: '2026-09-14T00:00:00.000Z',
    shots,
  };
}

describe('zoomPlanSchema', () => {
  it('accepts a plan and fills in the parts a model tends to omit', () => {
    const parsed = zoomPlanSchema.parse({
      version: 1,
      source: 'model',
      createdAt: '2026-09-14T00:00:00.000Z',
      shots: [{ start: 1, end: 3, zoom: 2, focus: 'cursor' }],
    });
    expect(parsed.shots[0].ease).toBe('normal');
    expect(parsed.shots[0].why).toBe('');
    expect(parsed.model).toBe('');
  });

  it('accepts a fixed focus in normalised frame coordinates', () => {
    const parsed = zoomPlanSchema.parse({
      version: 1,
      source: 'model',
      createdAt: '2026-09-14T00:00:00.000Z',
      shots: [{ start: 0, end: 2, zoom: 1.5, focus: { x: 0.25, y: 0.8 } }],
    });
    expect(parsed.shots[0].focus).toEqual({ x: 0.25, y: 0.8 });
  });

  it('refuses values a model could plausibly invent', () => {
    const base = { version: 1, source: 'model', createdAt: 'x' };
    const bad = [
      { shots: [{ start: 1, end: 3, zoom: 9, focus: 'cursor' }] }, // past any sane zoom
      { shots: [{ start: -1, end: 3, zoom: 2, focus: 'cursor' }] }, // before the clip
      { shots: [{ start: 1, end: 3, zoom: 2, focus: { x: 4, y: 0 } }] }, // not normalised
      { shots: [{ start: 1, end: 3, zoom: 2, focus: 'pointer' }] }, // invented enum
    ];
    for (const shots of bad) {
      expect(zoomPlanSchema.safeParse({ ...base, ...shots }).success).toBe(false);
    }
  });
});

describe('normalisePlan', () => {
  const ceiling = 2.5;

  it('sorts shots by start time', () => {
    const result = normalisePlan(
      plan([
        { start: 5, end: 7, zoom: 2, focus: 'cursor', ease: 'normal', why: 'b' },
        { start: 1, end: 3, zoom: 2, focus: 'cursor', ease: 'normal', why: 'a' },
      ]),
      10,
      ceiling,
    );
    expect(result.shots.map((shot) => shot.why)).toEqual(['a', 'b']);
  });

  it('delays an overlapping shot rather than letting two fight over the frame', () => {
    // The earlier shot keeps its whole run. Cutting it short instead could shrink a
    // deliberate shot below the readable minimum and lose it altogether.
    const result = normalisePlan(
      plan([
        { start: 1, end: 6, zoom: 2, focus: 'cursor', ease: 'normal', why: 'a' },
        { start: 4, end: 8, zoom: 2, focus: 'cursor', ease: 'normal', why: 'b' },
      ]),
      10,
      ceiling,
    );
    expect(result.shots[0]).toMatchObject({ start: 1, end: 6, why: 'a' });
    expect(result.shots[1]).toMatchObject({ start: 6, end: 8, why: 'b' });
  });

  it('drops a shot swallowed whole by the one before it', () => {
    const result = normalisePlan(
      plan([
        { start: 1, end: 8, zoom: 2, focus: 'cursor', ease: 'normal', why: 'a' },
        { start: 3, end: 5, zoom: 2, focus: 'cursor', ease: 'normal', why: 'swallowed' },
      ]),
      10,
      ceiling,
    );
    expect(result.shots.map((shot) => shot.why)).toEqual(['a']);
  });

  it('clamps shots to the clip and drops anything left outside it', () => {
    const result = normalisePlan(
      plan([
        { start: 8, end: 20, zoom: 2, focus: 'cursor', ease: 'normal', why: 'tail' },
        { start: 30, end: 40, zoom: 2, focus: 'cursor', ease: 'normal', why: 'gone' },
      ]),
      10,
      ceiling,
    );
    expect(result.shots).toHaveLength(1);
    expect(result.shots[0].end).toBe(10);
  });

  it('drops shots too short to read', () => {
    // A quarter second push in and straight back out is a flinch, not a shot.
    const result = normalisePlan(
      plan([{ start: 1, end: 1.25, zoom: 2, focus: 'cursor', ease: 'normal', why: '' }]),
      10,
      ceiling,
    );
    expect(result.shots).toHaveLength(0);
  });

  it('applies the strength slider as a ceiling, so the control still does something', () => {
    const result = normalisePlan(
      plan([{ start: 1, end: 4, zoom: 3, focus: 'cursor', ease: 'normal', why: '' }]),
      10,
      1.6,
    );
    expect(result.shots[0].zoom).toBe(1.6);
  });

  it('never lets a shot zoom out below 1', () => {
    const result = normalisePlan(
      plan([{ start: 1, end: 4, zoom: 1, focus: 'cursor', ease: 'normal', why: '' }]),
      10,
      1.6,
    );
    expect(result.shots[0].zoom).toBeGreaterThanOrEqual(1);
  });

  it('leaves an empty plan alone', () => {
    expect(normalisePlan(plan([]), 10, ceiling).shots).toEqual([]);
  });
});

describe('compileZoomPlan', () => {
  const settings = { enabled: true, strength: 2.5, speed: 55 };
  const source = { width: 1920, height: 1080 };

  // Enough movement for a 'cursor' focus to have something to follow.
  function events(): CursorEvent[] {
    const out: CursorEvent[] = [];
    for (let i = 0; i <= 200; i++) {
      out.push({ t: i / 20, x: 100 + i * 3, y: 200 + i, e: 'm', b: -1 });
    }
    return out;
  }

  function modelPlan(shots: ZoomPlan['shots']): ZoomPlan {
    return {
      version: 1,
      source: 'model',
      model: 'test',
      createdAt: '2026-09-14T00:00:00.000Z',
      shots,
    };
  }

  function compile(shots: ZoomPlan['shots'], duration = 10) {
    return compileZoomPlan(modelPlan(shots), events(), settings, duration, 2, [], source);
  }

  it('reaches each shot and returns to rest between them', () => {
    const curve = compile([
      { start: 1, end: 3, zoom: 2.4, focus: { x: 0.3, y: 0.4 }, ease: 'snap', why: 'a' },
      { start: 6, end: 8, zoom: 1.4, focus: { x: 0.7, y: 0.6 }, ease: 'snap', why: 'b' },
    ]);
    // Sampled just before each shot ends, by which point a snap spring has settled.
    expect(zoomAt(curve, 2.9).z).toBeGreaterThan(2.1);
    expect(zoomAt(curve, 7.9).z).toBeGreaterThan(1.25);
    expect(zoomAt(curve, 7.9).z).toBeLessThan(1.6);
    // Well clear of both shots, the frame is back out.
    expect(zoomAt(curve, 5.5).z).toBeLessThan(1.1);
    expect(zoomAt(curve, 0.1).z).toBeLessThan(1.1);
  });

  it('never overshoots past a shot, because the spring is critically damped', () => {
    const curve = compile([
      { start: 1, end: 6, zoom: 2, focus: { x: 0.5, y: 0.5 }, ease: 'snap', why: '' },
    ]);
    for (const key of curve) expect(key.z).toBeLessThanOrEqual(2.001);
  });

  it('honours the strength slider as a ceiling on a model that asked for more', () => {
    const curve = compileZoomPlan(
      modelPlan([{ start: 1, end: 6, zoom: 3, focus: { x: 0.5, y: 0.5 }, ease: 'snap', why: '' }]),
      events(),
      { enabled: true, strength: 1.5, speed: 55 },
      10,
      2,
      [],
      source,
    );
    for (const key of curve) expect(key.z).toBeLessThanOrEqual(1.501);
  });

  it('eases more slowly on drift than on snap', () => {
    const shot = (ease: 'snap' | 'drift') => [
      { start: 1, end: 9, zoom: 2.4, focus: { x: 0.5, y: 0.5 } as const, ease, why: '' },
    ];
    expect(zoomAt(compile(shot('snap')), 1.6).z).toBeGreaterThan(
      zoomAt(compile(shot('drift')), 1.6).z,
    );
  });

  it('follows the pointer when a shot asks it to', () => {
    const curve = compile([{ start: 1, end: 9, zoom: 2, focus: 'cursor', ease: 'snap', why: '' }]);
    // The cursor travels right across the clip, so the frame centre must travel too.
    expect(zoomAt(curve, 8).cx).toBeGreaterThan(zoomAt(curve, 2).cx + 100);
  });

  it('returns a flat curve for an empty plan or a disabled setting', () => {
    expect(compile([])).toEqual([{ t: 0, z: 1, cx: 0, cy: 0 }]);
    const disabled = compileZoomPlan(
      modelPlan([{ start: 1, end: 6, zoom: 2, focus: 'cursor', ease: 'snap', why: '' }]),
      events(),
      { enabled: false, strength: 2.5, speed: 55 },
      10,
      2,
      [],
      source,
    );
    expect(disabled).toEqual([{ t: 0, z: 1, cx: 0, cy: 0 }]);
  });

  it('produces a curve ffmpeg can still parse, which varied plans stress hardest', async () => {
    // The reason the nested expression builder had to go. A plan deliberately alternates
    // zoom levels, which is exactly what stops simplifyCurve collapsing the curve.
    const shots = Array.from({ length: 12 }, (_, i) => ({
      start: 1 + i * 4,
      end: 3.5 + i * 4,
      zoom: 1.3 + (i % 4) * 0.4,
      focus: { x: (i % 5) / 5, y: (i % 3) / 3 },
      ease: 'snap' as const,
      why: '',
    }));
    const curve = compile(shots, 50);
    expect(curve.length).toBeGreaterThan(100);

    const expressions = zoomExpressions(curve, 1920, 1080, 30);
    await execute('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=1920x1080:r=30:d=0.2',
      '-vf',
      `zoompan=z='${expressions.z}':x='${expressions.x}':y='${expressions.y}':d=1:s=1920x1080:fps=30`,
      '-frames:v',
      '3',
      '-f',
      'null',
      '-',
    ]);
  }, 60_000);
});

describe('zoomCurveFor', () => {
  const settings = { enabled: true, strength: 2.5, speed: 55 };
  const source = { width: 1920, height: 1080 };

  const track = {
    meta: {
      version: 1 as const,
      captureKind: 'display' as const,
      captureTitle: '',
      captureFrames: [],
      displayScale: 2,
      displayPoints: { w: 960, h: 540 },
      videoStartOffset: 0,
      duration: 10,
      createdAt: '2026-09-14T00:00:00.000Z',
    },
    events: [
      { t: 1, x: 200, y: 150, e: 'd' as const, b: 0 },
      { t: 1.1, x: 200, y: 150, e: 'u' as const, b: 0 },
    ],
  };

  const planned: ZoomPlan = {
    version: 1,
    source: 'model',
    model: 'test',
    createdAt: '2026-09-14T00:00:00.000Z',
    shots: [{ start: 4, end: 8, zoom: 2.4, focus: { x: 0.8, y: 0.8 }, ease: 'snap', why: '' }],
  };

  it('uses the plan when asked and it exists', () => {
    const auto = zoomCurveFor(track, settings, false, 10, source, planned);
    const fromPlan = zoomCurveFor(track, settings, true, 10, source, planned);
    // The click is at 1s and the only shot runs 4s to 8s, so the two cameras must
    // disagree at 6s or the plan is being ignored.
    expect(zoomAt(fromPlan, 6).z).toBeGreaterThan(2);
    expect(zoomAt(auto, 6).z).toBeLessThan(1.2);
  });

  it('falls back to automatic zoom when the recording has never been planned', () => {
    // Selecting 'plan' on an unplanned recording must show a camera, not nothing.
    const missing = zoomCurveFor(track, settings, true, 10, source, undefined);
    const auto = zoomCurveFor(track, settings, false, 10, source, undefined);
    expect(missing).toEqual(auto);
  });

  it('falls back when a plan exists but has no shots in it', () => {
    const empty: ZoomPlan = { ...planned, shots: [] };
    expect(zoomCurveFor(track, settings, true, 10, source, empty)).toEqual(
      zoomCurveFor(track, settings, false, 10, source, empty),
    );
  });
});

describe('compileZoomPlan opening frame', () => {
  it('starts pointed at the first shot rather than at the corner', () => {
    // The centre is invisible at zoom 1, so starting at the default origin costs
    // nothing to see, but makes the frame race diagonally across the picture while the
    // first shot's zoom is already rising.
    const track = {
      meta: {
        version: 1 as const,
        captureKind: 'display' as const,
        captureTitle: '',
        captureFrames: [],
        displayScale: 2,
        displayPoints: { w: 960, h: 540 },
        videoStartOffset: 0,
        duration: 10,
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      events: [{ t: 1, x: 200, y: 150, e: 'd' as const, b: 0 }],
    };
    const plan: ZoomPlan = {
      version: 1,
      source: 'model',
      model: 'test',
      createdAt: '2026-09-14T00:00:00.000Z',
      shots: [{ start: 4, end: 8, zoom: 2.4, focus: { x: 0.8, y: 0.8 }, ease: 'snap', why: '' }],
    };
    const curve = zoomCurveFor(
      track,
      { enabled: true, strength: 2.5, speed: 55 },
      true,
      10,
      { width: 1920, height: 1080 },
      plan,
    );
    // 0.8 of 1920 is 1536, and 0.8 of 1080 is 864.
    expect(curve[0].cx).toBeCloseTo(1536, 0);
    expect(curve[0].cy).toBeCloseTo(864, 0);
  });
});
