import { describe, expect, it } from 'vitest';
import type { CursorEvent } from '../shared/recording';
import { planZoomHeuristically, type HeuristicInput } from '../shared/zoom-heuristic';

const source = { width: 1920, height: 1080 };

function input(events: CursorEvent[], overrides: Partial<HeuristicInput> = {}): HeuristicInput {
  return {
    events,
    settings: { enabled: true, strength: 2.5, speed: 55 },
    duration: 30,
    // 1920x1080 pixels is 960x540 points, matching the rest of the suite.
    displayScale: 2,
    frames: [],
    source,
    ...overrides,
  };
}

function click(t: number, x: number, y: number): CursorEvent {
  return { t, x, y, e: 'd', b: 0 };
}

describe('planZoomHeuristically', () => {
  it('plans nothing when there is nothing to look at', () => {
    expect(planZoomHeuristically(input([])).shots).toEqual([]);
    const movesOnly: CursorEvent[] = [{ t: 1, x: 100, y: 100, e: 'm', b: -1 }];
    expect(planZoomHeuristically(input(movesOnly)).shots).toEqual([]);
  });

  it('treats clicks close in time as one shot', () => {
    const plan = planZoomHeuristically(
      input([click(2, 300, 200), click(2.6, 310, 205), click(3.1, 305, 210)]),
    );
    expect(plan.shots).toHaveLength(1);
    expect(plan.shots[0].why).toContain('3 clicks');
  });

  it('splits clicks separated by a long pause into separate shots', () => {
    const plan = planZoomHeuristically(input([click(2, 300, 200), click(12, 300, 200)]));
    expect(plan.shots).toHaveLength(2);
  });

  it('goes in further on a tight cluster than on a scattered one', () => {
    const tight = planZoomHeuristically(input([click(2, 300, 200), click(2.5, 306, 204)])).shots[0];
    const scattered = planZoomHeuristically(input([click(2, 60, 40), click(2.5, 900, 500)]))
      .shots[0];
    expect(tight.zoom).toBeGreaterThan(scattered.zoom);
  });

  it('holds a fixed point for a tight cluster and follows the pointer for a spread one', () => {
    const tight = planZoomHeuristically(input([click(2, 300, 200), click(2.5, 306, 204)])).shots[0];
    expect(tight.focus).not.toBe('cursor');
    // Normalised into the frame the model would have been shown.
    expect(tight.focus).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });

    const scattered = planZoomHeuristically(input([click(2, 60, 40), click(2.5, 900, 500)]))
      .shots[0];
    expect(scattered.focus).toBe('cursor');
  });

  it('leads and tails each shot on the same rhythm as the automatic zoom', () => {
    const plan = planZoomHeuristically(input([click(5, 300, 200)]));
    expect(plan.shots[0].start).toBeCloseTo(5 - 0.45, 3);
    expect(plan.shots[0].end).toBeCloseTo(5 + 1.4, 3);
  });

  it('keeps every shot inside the clip', () => {
    const plan = planZoomHeuristically(input([click(0.1, 300, 200), click(29.8, 300, 200)]));
    expect(plan.shots[0].start).toBeGreaterThanOrEqual(0);
    expect(plan.shots[plan.shots.length - 1].end).toBeLessThanOrEqual(30);
  });

  it('never proposes more zoom than the strength slider allows', () => {
    const plan = planZoomHeuristically(
      input([click(2, 300, 200)], { settings: { enabled: true, strength: 1.4, speed: 55 } }),
    );
    expect(plan.shots[0].zoom).toBeLessThanOrEqual(1.4);
  });

  it('snaps onto a lone click and eases onto a burst', () => {
    expect(planZoomHeuristically(input([click(2, 300, 200)])).shots[0].ease).toBe('snap');
    const burst = planZoomHeuristically(
      input([click(2, 300, 200), click(2.4, 302, 201), click(2.9, 304, 203)]),
    );
    expect(burst.shots[0].ease).toBe('normal');
  });

  it('anchors inside a moving window rather than in global screen space', () => {
    // A window recording reports where the capture rect sits over time. Without that,
    // a click at global (500, 400) inside a window at (400, 300) would be planned as if
    // it were near the middle of the frame instead of near its top left.
    const frames = [{ t: 0, x: 400, y: 300, w: 960, h: 540 }];
    const plan = planZoomHeuristically(
      input([click(2, 500, 400), click(2.4, 505, 404)], { frames }),
    );
    const focus = plan.shots[0].focus;
    expect(focus).not.toBe('cursor');
    if (focus === 'cursor') throw new Error('expected a fixed focus');
    // (500 - 400) * 2 = 200 pixels into a 1920 wide frame.
    expect(focus.x).toBeCloseTo(202 / 1920, 2);
    expect(focus.y).toBeCloseTo(204 / 1080, 2);
  });

  it('produces a plan that passes its own schema', () => {
    const plan = planZoomHeuristically(
      input([click(2, 300, 200), click(9, 700, 400), click(9.4, 705, 402)]),
    );
    expect(plan.source).toBe('heuristic');
    expect(plan.version).toBe(1);
    expect(() => new Date(plan.createdAt).toISOString()).not.toThrow();
  });
});
