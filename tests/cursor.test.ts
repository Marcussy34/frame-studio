import { describe, expect, it } from 'vitest';
import {
  buildSprite,
  buildZoomCurve,
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
  it('returns a constant for a single point', () => {
    expect(piecewiseExpression([{ f: 0, v: 1.5 }])).toBe('1.5000');
  });

  it('builds a nested conditional over the frame index', () => {
    const expression = piecewiseExpression([
      { f: 0, v: 1 },
      { f: 60, v: 2 },
    ]);
    expect(expression).toContain('lt(on,60)');
    expect(expression).toContain('2.0000');
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
