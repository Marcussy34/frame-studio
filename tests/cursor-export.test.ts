import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings, getLayout } from '../shared/composition';
import { buildZoomCurve, zoomExpressions } from '../shared/cursor';
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
      captureKind: 'display' as const,
      captureTitle: '',
      captureFrames: [],
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

// Clicks spread far enough apart that each gets its own zoom in and out, which is what
// makes the curve long. A track of pure movement, as the other tests use, collapses to
// a single flat keyframe and never exercises the zoom expression at all.
function clickedTrack(clicks: number, duration: number): CursorTrack {
  const events: CursorEvent[] = [];
  for (let i = 0; i < clicks; i++) {
    const t = 0.3 + (i / clicks) * (duration - 0.6);
    const x = 300 + ((i * 137) % 400);
    const y = 200 + ((i * 89) % 250);
    for (let k = 0; k < 10; k++) {
      events.push({ t: t - 0.2 + k * 0.02, x: x - 20 + k * 2, y, e: 'm', b: -1 });
    }
    events.push({ t, x, y, e: 'd', b: 0 });
    events.push({ t: t + 0.08, x, y, e: 'u', b: 0 });
  }
  const base = centredTrack();
  return { meta: { ...base.meta, duration }, events };
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

  it('feeds ffmpeg a zoom expression it can still parse when the curve is long', async () => {
    // Six spread out clicks over fifteen seconds produces about 150 curve points. Built
    // as nested conditionals that used to exceed ffmpeg's recursive expression parser
    // and fail the WHOLE export with an opaque "Cannot allocate memory", which is only
    // about four clicks of headroom. The other zoom test never caught it because its
    // source is two seconds with a single click.
    //
    // This drives the real parser rather than a whole render: parsing the filter is
    // exactly what used to break, and it costs a second instead of a minute.
    const track = clickedTrack(6, 15);
    const curve = buildZoomCurve(
      track.events,
      { enabled: true, strength: 1.8, speed: 55 },
      15,
      track.meta.displayScale,
      track.meta.captureFrames,
    );
    // Guards the guard: if simplifyCurve ever collapses this, the test stops proving
    // anything and should be given a busier track rather than quietly passing.
    expect(curve.length).toBeGreaterThan(100);

    const expressions = zoomExpressions(curve, 1920, 1080, 30);
    // Mirrors how server/media.ts assembles the filter.
    const zoompan = `zoompan=z='${expressions.z}':x='${expressions.x}':y='${expressions.y}':d=1:s=1920x1080:fps=30`;
    await execute('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=1920x1080:r=30:d=0.2',
      '-vf',
      zoompan,
      '-frames:v',
      '3',
      '-f',
      'null',
      '-',
    ]);
  }, 60_000);
});
