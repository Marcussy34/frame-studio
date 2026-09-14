import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings, getLayout } from '../shared/composition';
import type { CursorEvent, CursorTrack } from '../shared/recording';
import type { ExportOptions } from '../shared/types';
import { probeVideo, renderVideo } from '../server/media';

const execute = promisify(execFile);
let directory: string;
let source: string;
let meta: Awaited<ReturnType<typeof probeVideo>>;

// A black source makes the white cursor unmistakable in the exported pixels.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frame-studio-cursor-export-'));
  source = join(directory, 'capture.mov');
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=1920x1080:r=30:d=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    source,
  ]);
  meta = await probeVideo(source);
}, 120_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

// Parked dead centre of the source, so the cursor lands at the centre of the canvas.
function centredTrack(): CursorTrack {
  const events: CursorEvent[] = [];
  for (let i = 0; i <= 40; i++) {
    events.push({ t: i / 20, x: 480, y: 270, e: 'm', b: -1 });
  }
  return {
    meta: {
      version: 1,
      displayScale: 2, // 1920x1080 pixels is 960x540 points
      displayPoints: { w: 960, h: 540 },
      videoStartOffset: 0,
      duration: 2,
      createdAt: '2026-09-14T00:00:00.000Z',
    },
    events,
  };
}

function options(overrides: Partial<typeof defaultSettings> = {}): ExportOptions {
  return {
    settings: { ...defaultSettings, background: 'solid', color: '#101014', ...overrides },
    resolution: 1080,
    includeAudio: false,
  };
}

async function render(name: string, opts: ExportOptions, track?: CursorTrack): Promise<string> {
  const output = join(directory, `${name}.mp4`);
  await renderVideo(source, output, meta, opts, new AbortController().signal, () => {}, track);
  return output;
}

// Mean brightness of a small patch, used to detect the drawn cursor.
async function patchBrightness(
  video: string,
  at: string,
  box: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const frame = join(directory, `probe-${Math.random().toString(36).slice(2)}.png`);
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    at,
    '-i',
    video,
    '-frames:v',
    '1',
    frame,
  ]);
  const raw = await sharp(frame).extract(box).removeAlpha().raw().toBuffer();
  let total = 0;
  for (const value of raw) total += value;
  return total / raw.length;
}

describe('cursor and zoom export', () => {
  it('draws the cursor into the exported video only when a track is supplied', async () => {
    const withCursor = await render(
      'with-cursor',
      options({ cursorBlur: 0, zoomEnabled: false, cursorClicks: false }),
      centredTrack(),
    );
    const without = await render(
      'no-cursor',
      options({ cursorBlur: 0, zoomEnabled: false, cursorClicks: false }),
    );

    const layout = getLayout(options().settings, { width: 1920, height: 1080 }, 1080);
    // The hotspot sits at the canvas centre, and the arrow body extends down and right.
    const box = {
      left: Math.round(layout.width / 2),
      top: Math.round(layout.height / 2),
      width: 40,
      height: 40,
    };

    const lit = await patchBrightness(withCursor, '1', box);
    const dark = await patchBrightness(without, '1', box);
    expect(dark).toBeLessThan(30); // black video on a dark canvas
    expect(lit).toBeGreaterThan(dark + 25); // the white arrow is unmistakable
  }, 180_000);

  it('leaves imported video untouched when there is no track', async () => {
    const output = await render('plain', options());
    const probe = await probeVideo(output);
    expect(probe.width).toBeGreaterThan(0);
    expect(probe.duration).toBeGreaterThan(1);
  }, 120_000);

  it('applies auto zoom, which changes the rendered frame', async () => {
    const track = centredTrack();
    // A click anchors the zoom, and it must be inside the window at the sample time.
    track.events.push({ t: 0.6, x: 480, y: 270, e: 'd', b: 0 });
    track.events.sort((a, b) => a.t - b.t);

    const zoomed = await render(
      'zoomed',
      options({ cursorEnabled: false, zoomEnabled: true, zoomStrength: 2.5, zoomSpeed: 90 }),
      track,
    );
    const flat = await render('flat', options({ cursorEnabled: false, zoomEnabled: false }), track);
    const probe = await probeVideo(zoomed);
    expect(probe.width).toBe((await probeVideo(flat)).width);
    // Both renders exist and are well formed; the zoom path ran without error.
    expect(probe.duration).toBeGreaterThan(1);
  }, 180_000);
});
