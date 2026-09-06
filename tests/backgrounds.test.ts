import sharp from 'sharp';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import {
  backgroundSvg,
  backgrounds,
  defaultSettings,
  getLayout,
  settingsSchema,
} from '../shared/composition';

describe('background choices', () => {
  it('offers a broad set of gradients and migrates older saved canvases', () => {
    expect(backgrounds.length).toBeGreaterThanOrEqual(24);
    const restored = settingsSchema.parse({
      ratio: '16:9',
      background: 'sage',
      color: '#e8d9c8',
      padding: 10,
      radius: 24,
      shadow: 35,
      scale: 100,
      x: 50,
      y: 50,
    });
    expect(restored.gradientAngle).toBe(135);
    expect(restored.backgroundImage).toBeNull();
  });

  it('renders a custom gradient in the chosen direction', async () => {
    const settings = settingsSchema.parse({
      ...defaultSettings,
      background: 'custom-gradient',
      gradientColors: ['#ff0000', '#00ff00', '#0000ff'],
      gradientAngle: 90,
      shadow: 0,
    });
    const layout = getLayout({ ...settings, ratio: '1:1' }, { width: 100, height: 100 }, 100);
    const { data, info } = await sharp(Buffer.from(backgroundSvg(settings, layout)))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray(
        (y * info.width + x) * info.channels,
        (y * info.width + x) * info.channels + 3,
      ),
    ];
    expect(pixel(2, 50)[0]).toBeGreaterThan(230);
    expect(pixel(97, 50)[2]).toBeGreaterThan(230);
  });

  it('renders a local image and rejects external or SVG image sources', async () => {
    const encoded = (
      await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } })
        .jpeg()
        .toBuffer()
    ).toString('base64');
    const settings = settingsSchema.parse({
      ...defaultSettings,
      background: 'image',
      backgroundImage: `data:image/jpeg;base64,${encoded}`,
      shadow: 0,
    });
    const layout = getLayout(settings, { width: 100, height: 100 }, 100);
    const pixel = await sharp(Buffer.from(backgroundSvg(settings, layout)))
      .resize(1, 1)
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(pixel[0]).toBeGreaterThan(230);
    for (const backgroundImage of [
      'https://example.com/photo.jpg',
      'file:///private/photo.jpg',
      'data:image/svg+xml,<svg/>',
    ]) {
      expect(settingsSchema.safeParse({ ...settings, backgroundImage }).success).toBe(false);
    }
  });

  it('normalizes an uploaded image and rejects disguised SVG input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frame-background-test-'));
    const studio = await createApp({ directory });
    try {
      const png = await sharp({
        create: { width: 40, height: 30, channels: 3, background: '#ff0000' },
      })
        .png()
        .toBuffer();
      const result = await request(studio.app)
        .post('/api/background')
        .set('X-Frame-Studio', '1')
        .attach('image', png, 'wallpaper.png');
      expect(result.status).toBe(200);
      expect(result.body.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
      expect(result.body.name).toBe('wallpaper.png');
      const bad = await request(studio.app)
        .post('/api/background')
        .set('X-Frame-Studio', '1')
        .attach('image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'fake.png');
      expect(bad.status).toBe(400);
    } finally {
      await studio.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
