import { describe, expect, it } from 'vitest';
import { elapsedLabel, stageOf } from '../src/components/CameraPlan';

describe('stageOf', () => {
  // The job reports 0.4 when the frames are cut and 0.95 when the model has answered,
  // so those two numbers are the only real stage boundaries there are.
  it('names the stage the reported progress actually means', () => {
    expect(stageOf(0).label).toMatch(/sampling frames/i);
    expect(stageOf(0.39).label).toMatch(/sampling frames/i);
    expect(stageOf(0.4).label).toMatch(/watching your recording/i);
    expect(stageOf(0.94).label).toMatch(/watching your recording/i);
    expect(stageOf(0.95).label).toMatch(/reading the plan/i);
    expect(stageOf(1).label).toMatch(/reading the plan/i);
  });

  it('keeps every label short enough for the inspector column', () => {
    // Measured against the real panel: anything longer was truncated mid word.
    for (const progress of [0, 0.5, 1]) {
      expect(stageOf(progress).label.length).toBeLessThanOrEqual(24);
    }
  });

  it('sets the expectation on the long stage rather than leaving it silent', () => {
    // Measured: a round trip through agy is about nine minutes and never under four.
    // Saying so is the difference between waiting and assuming it has hung.
    expect(stageOf(0.5).detail).toMatch(/nine minutes/i);
  });
});

describe('elapsedLabel', () => {
  it('counts in minutes and seconds', () => {
    expect(elapsedLabel(0)).toBe('0:00');
    expect(elapsedLabel(9_000)).toBe('0:09');
    expect(elapsedLabel(65_000)).toBe('1:05');
    expect(elapsedLabel(600_000)).toBe('10:00');
  });

  it('never shows a negative clock, whatever the machine does to its own time', () => {
    expect(elapsedLabel(-5_000)).toBe('0:00');
  });
});
