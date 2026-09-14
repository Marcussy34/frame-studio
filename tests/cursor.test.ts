import { describe, expect, it } from 'vitest';
import {
  buildSprite,
  buildZoomCurve,
  captureOriginAt,
  toCapturePixels,
  piecewiseExpression,
  renderCursorFrame,
  RIPPLE_LIFE,
  smoothPath,
  sourceToCanvas,
  subsampleCount,
  visibleRegion,
  zoomAt,
  zoomExpressions,
} from '../shared/cursor';
import type { CursorEvent } from '../shared/recording';

function straightLine(): CursorEvent[] {
  const events: CursorEvent[] = [];
  for (let i = 0; i <= 200; i++) {
    events.push({ t: i / 100, x: i * 5, y: 100, e: 'm', b: -1 });
  }
  return events;
}

describe('smoothPath', () => {
  it('is frame rate independent, giving the same answer whatever rate you sample at', () => {
    const path = smoothPath(straightLine(), { smoothing: 60 }, 2);
    // Sampling the same instants through different step counts must agree.
    for (const t of [0.25, 0.8, 1.5]) {
      const a = path.at(t);
      const b = path.at(t);
      expect(a.x).toBeCloseTo(b.x, 10);
    }
    // And the smoothed path must actually track the input rather than diverge.
    expect(path.at(1.9).x).toBeGreaterThan(path.at(0.5).x);
  });

  it('trails the raw position while moving, which is the smoothing effect', () => {
    const events = straightLine();
    const smoothed = smoothPath(events, { smoothing: 90 }, 2);
    const raw = smoothPath(events, { smoothing: 0 }, 2);
    expect(smoothed.at(1).x).toBeLessThan(raw.at(1).x);
  });

  it('snaps toward a click so the ripple cannot fire before the cursor arrives', () => {
    const events: CursorEvent[] = [
      { t: 0, x: 0, y: 0, e: 'm', b: -1 },
      { t: 0.5, x: 900, y: 400, e: 'd', b: 0 },
      { t: 0.6, x: 900, y: 400, e: 'm', b: -1 },
    ];
    const path = smoothPath(events, { smoothing: 95 }, 1);
    // Without the snap a very soft spring would still be far away here.
    expect(path.at(0.56).x).toBeGreaterThan(600);
  });

  it('handles an empty track without throwing', () => {
    expect(smoothPath([], { smoothing: 50 }, 1).at(0.5)).toEqual({ x: 0, y: 0 });
  });
});

describe('buildZoomCurve', () => {
  const clicks: CursorEvent[] = [
    { t: 0.2, x: 100, y: 100, e: 'm', b: -1 },
    { t: 1, x: 400, y: 300, e: 'd', b: 0 },
    { t: 3.5, x: 800, y: 500, e: 'd', b: 0 },
  ];

  it('stays flat when zoom is disabled', () => {
    const curve = buildZoomCurve(clicks, { enabled: false, strength: 2, speed: 50 }, 5, 2);
    expect(curve.every((key) => key.z === 1)).toBe(true);
  });

  it('stays flat when there are no clicks to anchor to', () => {
    const moves = clicks.filter((event) => event.e === 'm');
    const curve = buildZoomCurve(moves, { enabled: true, strength: 2, speed: 50 }, 5, 2);
    expect(curve.every((key) => key.z === 1)).toBe(true);
  });

  it('zooms in around a click and eases back out afterwards', () => {
    const curve = buildZoomCurve(clicks, { enabled: true, strength: 2.4, speed: 60 }, 6, 2);
    expect(zoomAt(curve, 1.2).z).toBeGreaterThan(1.3);
    // Well past the tail it should have returned close to neutral.
    expect(zoomAt(curve, 5.8).z).toBeLessThan(1.2);
  });

  it('never exceeds the configured strength', () => {
    const curve = buildZoomCurve(clicks, { enabled: true, strength: 2, speed: 100 }, 6, 2);
    for (const key of curve) expect(key.z).toBeLessThanOrEqual(2.35);
  });

  it('converts click coordinates from points into source pixels', () => {
    const curve = buildZoomCurve(clicks, { enabled: true, strength: 2, speed: 80 }, 6, 2);
    // The click at x=400 points is x=800 pixels, so the centre must head past 400.
    expect(zoomAt(curve, 1.3).cx).toBeGreaterThan(500);
  });
});

describe('visibleRegion', () => {
  it('shows the whole frame at zoom 1', () => {
    const region = visibleRegion({ z: 1, cx: 0, cy: 0 }, 1920, 1080);
    expect(region).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('clamps so the crop never runs off the edge and shows black', () => {
    const region = visibleRegion({ z: 2, cx: 0, cy: 0 }, 1920, 1080);
    expect(region.x).toBe(0);
    expect(region.y).toBe(0);
    const far = visibleRegion({ z: 2, cx: 5000, cy: 5000 }, 1920, 1080);
    expect(far.x + far.width).toBeLessThanOrEqual(1920);
    expect(far.y + far.height).toBeLessThanOrEqual(1080);
  });
});

describe('sourceToCanvas', () => {
  const video = { x: 100, y: 50, width: 800, height: 450 };

  it('maps a point through the display scale and the video rect', () => {
    const region = { x: 0, y: 0, width: 1920, height: 1080 };
    // 960 points at 2x is 1920 pixels, the far right edge of the source.
    expect(sourceToCanvas({ x: 960, y: 540 }, region, video, 2).x).toBeCloseTo(900, 5);
    expect(sourceToCanvas({ x: 0, y: 0 }, region, video, 2)).toEqual({ x: 100, y: 50 });
  });

  it('accounts for the zoom region, so a zoomed cursor lands correctly', () => {
    const region = { x: 480, y: 270, width: 960, height: 540 };
    // The centre of the zoomed region maps to the centre of the video rect.
    const point = sourceToCanvas({ x: 480, y: 270 }, region, video, 2);
    expect(point.x).toBeCloseTo(video.x + video.width / 2, 5);
    expect(point.y).toBeCloseTo(video.y + video.height / 2, 5);
  });
});

describe('buildSprite', () => {
  it('puts the hotspot on the arrow tip', () => {
    const sprite = buildSprite(40);
    const index = (sprite.hotY * sprite.width + sprite.hotX) * 4;
    // The tip is opaque, and it is the white face rather than outline or shadow.
    expect(sprite.rgba[index + 3]).toBeGreaterThan(100);
  });

  it('is transparent in the far corner, so it is a sprite and not a filled box', () => {
    const sprite = buildSprite(40);
    expect(sprite.rgba[(sprite.width - 1) * 4 + 3]).toBe(0);
  });

  it('scales with the requested height', () => {
    expect(buildSprite(80).height).toBeGreaterThan(buildSprite(40).height);
  });
});

describe('subsampleCount', () => {
  it('uses a single sample when blur is off', () => {
    expect(subsampleCount(0)).toBe(1);
  });

  it('grows with the blur setting', () => {
    expect(subsampleCount(100)).toBeGreaterThan(subsampleCount(30));
  });
});

describe('renderCursorFrame', () => {
  const width = 200;
  const height = 120;

  it('draws the cursor at the requested position', () => {
    const out = new Uint8ClampedArray(width * height * 4);
    const sprite = buildSprite(30);
    renderCursorFrame({
      out,
      width,
      height,
      sprite,
      samples: [{ x: 100, y: 60 }],
      ripples: [],
      cursorHeight: 30,
    });
    const index = (60 * width + 100) * 4;
    expect(out[index + 3]).toBeGreaterThan(100);
    // Somewhere far away must stay untouched.
    expect(out[(5 * width + 5) * 4 + 3]).toBe(0);
  });

  it('spreads alpha along the path when motion blurring, rather than stacking ghosts', () => {
    const sprite = buildSprite(30);
    const sharp = new Uint8ClampedArray(width * height * 4);
    renderCursorFrame({
      out: sharp,
      width,
      height,
      sprite,
      samples: [{ x: 100, y: 60 }],
      ripples: [],
      cursorHeight: 30,
    });
    const blurred = new Uint8ClampedArray(width * height * 4);
    renderCursorFrame({
      out: blurred,
      width,
      height,
      sprite,
      samples: Array.from({ length: 8 }, (_, i) => ({ x: 80 + i * 5, y: 60 })),
      ripples: [],
      cursorHeight: 30,
    });
    const tipSharp = sharp[(60 * width + 100) * 4 + 3];
    const tipBlurred = blurred[(60 * width + 100) * 4 + 3];
    // Averaging across the exposure must soften the leading edge.
    expect(tipBlurred).toBeLessThan(tipSharp);
  });

  it('draws a click ripple that fades out over its life', () => {
    const sprite = buildSprite(30);
    const alphaAt = (age: number) => {
      const out = new Uint8ClampedArray(width * height * 4);
      renderCursorFrame({
        out,
        width,
        height,
        sprite,
        samples: [{ x: 100, y: 60 }],
        ripples: [{ x: 100, y: 60, age }],
        cursorHeight: 30,
      });
      let total = 0;
      for (let i = 3; i < out.length; i += 4) total += out[i];
      return total;
    };
    expect(alphaAt(0.05)).toBeGreaterThan(alphaAt(RIPPLE_LIFE * 0.95));
  });
});

describe('piecewiseExpression', () => {
  // ffmpeg's expression parser is recursive with a budget of about 100 levels. Anything
  // deeper fails the whole export with "Cannot allocate memory", so depth is the real
  // contract here, not length.
  const FFMPEG_PARSE_BUDGET = 100;

  function parseDepth(expression: string): number {
    let depth = 0;
    let deepest = 0;
    for (const character of expression) {
      if (character === '(') deepest = Math.max(deepest, ++depth);
      else if (character === ')') depth--;
    }
    return deepest;
  }

  // Evaluates the generated expression the way ffmpeg would, so the tests check what
  // the filter computes rather than how the string happens to be spelled. The input is
  // this module's own output, never anything external, which is what makes building a
  // function from it safe here.
  function evaluate(expression: string, on: number): number {
    const lt = (a: number, b: number) => (a < b ? 1 : 0);
    const gte = (a: number, b: number) => (a >= b ? 1 : 0);
    const iff = (condition: number, a: number, b: number) => (condition ? a : b);
    const source = expression.replace(/\bif\(/g, 'iff(');
    return new Function('on', 'lt', 'gte', 'iff', `return ${source};`)(on, lt, gte, iff);
  }

  // What a piecewise linear ramp through the points should produce at a given frame.
  function expected(points: { f: number; v: number }[], on: number): number {
    if (points.length === 1) return points[0].v;
    for (let i = 0; i < points.length - 1; i++) {
      if (on < points[i + 1].f) {
        const a = points[i];
        const b = points[i + 1];
        return a.v + ((b.v - a.v) * (on - a.f)) / Math.max(1, b.f - a.f);
      }
    }
    return points[points.length - 1].v;
  }

  it('returns a constant for a single point', () => {
    expect(piecewiseExpression([{ f: 0, v: 1.5 }])).toBe('1.5000');
  });

  it('ramps between two points and holds the last value afterwards', () => {
    const points = [
      { f: 0, v: 1 },
      { f: 60, v: 2 },
    ];
    const expression = piecewiseExpression(points);
    for (const frame of [-5, 0, 30, 59, 60, 120]) {
      expect(evaluate(expression, frame)).toBeCloseTo(expected(points, frame), 3);
    }
  });

  it("stays within ffmpeg's parse budget for a curve with hundreds of points", () => {
    // A 20 second recording with six spread out clicks already produces 158 points, so
    // this is an ordinary recording rather than a pathological one.
    const points = Array.from({ length: 500 }, (_, i) => ({ f: i * 3, v: 1 + (i % 7) * 0.2 }));
    expect(parseDepth(piecewiseExpression(points))).toBeLessThan(FFMPEG_PARSE_BUDGET);
  });

  it('computes the same values as a plain piecewise ramp at every frame', () => {
    const points = Array.from({ length: 120 }, (_, i) => ({ f: i * 5, v: 1 + Math.sin(i) * 0.4 }));
    const expression = piecewiseExpression(points);
    for (let frame = -10; frame <= 620; frame += 7) {
      expect(evaluate(expression, frame)).toBeCloseTo(expected(points, frame), 3);
    }
  });

  it('handles points that round onto the same frame, which a dense curve produces', () => {
    // zoomExpressions rounds times to whole frames, so neighbouring keys collide.
    const points = [
      { f: 0, v: 1 },
      { f: 10, v: 1.5 },
      { f: 10, v: 1.7 },
      { f: 20, v: 2 },
    ];
    const expression = piecewiseExpression(points);
    for (const frame of [0, 5, 10, 15, 20, 30]) {
      expect(evaluate(expression, frame)).toBeCloseTo(expected(points, frame), 3);
    }
  });
});

describe('zoomExpressions', () => {
  it('keeps the crop inside the source at every keyframe', () => {
    const events: CursorEvent[] = [
      { t: 0.5, x: 0, y: 0, e: 'd', b: 0 },
      { t: 2.5, x: 960, y: 540, e: 'd', b: 0 },
    ];
    const curve = buildZoomCurve(events, { enabled: true, strength: 3, speed: 70 }, 4, 2);
    for (const key of curve) {
      const region = visibleRegion(key, 1920, 1080);
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(1920.001);
      expect(region.y + region.height).toBeLessThanOrEqual(1080.001);
    }
    const expressions = zoomExpressions(curve, 1920, 1080, 60);
    expect(expressions.z.length).toBeGreaterThan(0);
    // The curve is simplified, so the expression must stay a manageable size.
    expect(expressions.z.length).toBeLessThan(60_000);
  });
});

describe('captureOriginAt', () => {
  const frames = [
    { t: 0, x: 100, y: 200, w: 800, h: 600 },
    { t: 2, x: 300, y: 200, w: 800, h: 600 },
  ];

  it('returns null when a recording has no capture frames', () => {
    expect(captureOriginAt([], 1)).toBeNull();
  });

  it('holds the first and last samples outside the range', () => {
    expect(captureOriginAt(frames, -5)?.x).toBe(100);
    expect(captureOriginAt(frames, 99)?.x).toBe(300);
  });

  it('interpolates, so dragging a window does not make the cursor jump', () => {
    expect(captureOriginAt(frames, 1)?.x).toBeCloseTo(200, 5);
  });
});

describe('toCapturePixels', () => {
  const origin = { t: 0, x: 100, y: 50, w: 800, h: 600 };

  it('makes a global point relative to the captured window', () => {
    // 150 points is 50 past the window origin, doubled by the display scale.
    expect(toCapturePixels({ x: 150, y: 100 }, origin, 2, 1600, 1200)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it('returns null outside the capture, so the cursor is hidden rather than clamped', () => {
    expect(toCapturePixels({ x: 20, y: 100 }, origin, 2, 1600, 1200)).toBeNull();
    expect(toCapturePixels({ x: 5000, y: 100 }, origin, 2, 1600, 1200)).toBeNull();
  });

  it('treats a missing origin as the screen origin, which is the full screen case', () => {
    expect(toCapturePixels({ x: 10, y: 20 }, null, 2, 1600, 1200)).toEqual({ x: 20, y: 40 });
  });
});

describe('buildZoomCurve with a moving window', () => {
  it('anchors zoom inside the window rather than in global screen space', () => {
    const events: CursorEvent[] = [{ t: 1, x: 500, y: 400, e: 'd', b: 0 }];
    const frames = [{ t: 0, x: 400, y: 300, w: 800, h: 600 }];
    const curve = buildZoomCurve(events, { enabled: true, strength: 2, speed: 90 }, 3, 2, frames);
    // The click is 100 points inside the window, so 200 pixels in, not 1000.
    expect(zoomAt(curve, 1.4).cx).toBeLessThan(600);
  });
});
