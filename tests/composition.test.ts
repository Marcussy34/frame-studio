import { describe, expect, it } from 'vitest';
import { defaultSettings, getLayout, settingsSchema } from '../shared/composition';

describe('video composition', () => {
  it('fits a widescreen video into a square without cropping or stretching', () => {
    const layout = getLayout(
      { ...defaultSettings, ratio: '1:1', padding: 10 },
      { width: 1920, height: 1080 },
      1000,
    );
    expect(layout.width).toBe(1000);
    expect(layout.height).toBe(1000);
    expect(layout.video).toMatchObject({ width: 800, height: 450, x: 100, y: 275 });
  });

  it('keeps a portrait recording inside the canvas at the farthest position', () => {
    const layout = getLayout(
      { ...defaultSettings, ratio: '16:9', padding: 10, scale: 50, x: 100, y: 100 },
      { width: 1080, height: 1920 },
      1080,
    );
    expect(layout.width).toBe(1920);
    expect(layout.video.width).toBe(242);
    expect(layout.video.height).toBe(432);
    expect(layout.video.x + layout.video.width).toBe(1812);
    expect(layout.video.y + layout.video.height).toBe(972);
  });

  it('rejects unsafe colors, non-finite values, and out-of-range geometry', () => {
    for (const patch of [
      { color: 'url(https://example.com)' },
      { padding: -1 },
      { scale: 0 },
      { x: 101 },
      { radius: NaN },
      { ratio: '2:0' },
    ]) {
      expect(settingsSchema.safeParse({ ...defaultSettings, ...patch }).success).toBe(false);
    }
  });

  it('rejects unusable source dimensions before producing a render', () => {
    expect(() => getLayout(defaultSettings, { width: 0, height: 1080 })).toThrow();
    expect(() => getLayout(defaultSettings, { width: Infinity, height: 1080 })).toThrow();
  });
});
