import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings } from '../shared/composition';
import { preparePreview, probeVideo, renderVideo } from '../server/media';

const execute = promisify(execFile);
let directory: string;
let source: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frame-studio-media-test-'));
  source = join(directory, 'source.mov');
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x180:r=24:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    source,
  ]);
  const base = join(directory, 'colors.mov');
  const audio = join(directory, 'long-audio.m4a');
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x180:r=24:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x180:r=24:d=2',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v',
    'libx264',
    base,
  ]);
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:a',
    'aac',
    audio,
  ]);
  await execute('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-itsoffset',
    '1',
    '-i',
    base,
    '-i',
    audio,
    '-c',
    'copy',
    join(directory, 'delayed.mov'),
  ]);
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('real video processing', () => {
  it('reads a MOV and creates a playable preview with its audio', async () => {
    const meta = await probeVideo(source);
    expect(meta).toMatchObject({ width: 320, height: 180, hasAudio: true, fps: 24 });
    const preview = join(directory, 'preview.mp4');
    await preparePreview(source, preview, meta, new AbortController().signal, () => {});
    expect(await probeVideo(preview)).toMatchObject({ width: 320, height: 180, hasAudio: true });
  });

  it('exports the chosen canvas, rounded video, original duration, and audio', async () => {
    const output = join(directory, 'styled.mp4');
    const meta = await probeVideo(source);
    const progress: number[] = [];
    await renderVideo(
      source,
      output,
      meta,
      {
        settings: {
          ...defaultSettings,
          ratio: '1:1',
          background: 'solid',
          color: '#0000ff',
          padding: 10,
          radius: 40,
          shadow: 0,
        },
        resolution: 720,
        includeAudio: true,
      },
      new AbortController().signal,
      (value) => progress.push(value),
    );
    const exported = await probeVideo(output);
    expect(exported).toMatchObject({ width: 720, height: 720, hasAudio: true, fps: 24 });
    expect(exported.duration).toBeCloseTo(meta.duration, 1);
    const screenshot = join(directory, 'export.png');
    await execute('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      output,
      '-frames:v',
      '1',
      screenshot,
    ]);
    const { data, info } = await sharp(await readFile(screenshot))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray(
        (y * info.width + x) * info.channels,
        (y * info.width + x) * info.channels + 3,
      ),
    ];
    expect(pixel(20, 20)[2]).toBeGreaterThan(220);
    expect(pixel(360, 360)[0]).toBeGreaterThan(220);
    // The top-left of the video rectangle must show the background through its rounded corner.
    expect(pixel(73, 199)[2]).toBeGreaterThan(200);
    expect(progress.at(-1)).toBe(1);
  });

  it('exports a silent source and honors the remove-audio option', async () => {
    const silent = join(directory, 'silent.mp4');
    await execute('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      source,
      '-an',
      '-c:v',
      'copy',
      silent,
    ]);
    for (const [index, input] of [silent, source].entries()) {
      const output = join(directory, `muted-${index}.mp4`);
      await renderVideo(
        input,
        output,
        await probeVideo(input),
        { settings: defaultSettings, resolution: 720, includeAudio: false },
        new AbortController().signal,
        () => {},
      );
      expect((await probeVideo(output)).hasAudio).toBe(false);
    }
  });

  it('does not start an export that has already been cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderVideo(
        source,
        join(directory, 'cancelled.mp4'),
        await probeVideo(source),
        { settings: defaultSettings, resolution: 720, includeAudio: true },
        controller.signal,
        () => {},
      ),
    ).rejects.toThrow(/cancel|abort/i);
  });

  it('preserves the full presentation duration when video starts after audio', async () => {
    const delayed = join(directory, 'delayed.mov');
    expect((await probeVideo(delayed)).duration).toBeCloseTo(4, 1);
  });

  it('keeps delayed video frames synchronized in both preview and export', async () => {
    const delayed = join(directory, 'delayed.mov');
    const meta = await probeVideo(delayed);
    const preview = join(directory, 'delayed-preview.mp4');
    const output = join(directory, 'delayed-output.mp4');
    await preparePreview(delayed, preview, meta, new AbortController().signal, () => {});
    await renderVideo(
      delayed,
      output,
      meta,
      {
        settings: { ...defaultSettings, padding: 0, radius: 0, shadow: 0 },
        resolution: 720,
        includeAudio: true,
      },
      new AbortController().signal,
      () => {},
    );
    for (const [index, file] of [preview, output].entries()) {
      for (const [second, channel] of [
        [1.5, 0],
        [2.5, 2],
        [3.5, 2],
      ]) {
        const frame = join(directory, `timing-${index}-${second}.png`);
        await execute('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          String(second),
          '-i',
          file,
          '-frames:v',
          '1',
          frame,
        ]);
        const pixel = await sharp(frame).resize(1, 1).removeAlpha().raw().toBuffer();
        expect(pixel[channel], `${file} at ${second}s has the expected color`).toBeGreaterThan(200);
      }
      expect((await probeVideo(file)).duration).toBeCloseTo(4, 1);
    }
  });

  it('cancels an active render and removes the partial export', async () => {
    const controller = new AbortController();
    const output = join(directory, 'interrupted.mp4');
    await expect(
      renderVideo(
        source,
        output,
        await probeVideo(source),
        { settings: defaultSettings, resolution: 2160, includeAudio: true },
        controller.signal,
        (progress) => {
          if (progress < 1) controller.abort();
        },
      ),
    ).rejects.toThrow(/cancel|abort/i);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('normalizes a rotated HEVC MOV with non-square pixels for browser playback', async () => {
    const hevc = join(directory, 'hevc.mov');
    const rotated = join(directory, 'rotated-hevc.mov');
    await execute('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=teal:s=320x180:r=24:d=1',
      '-vf',
      'setsar=2',
      '-c:v',
      'libx265',
      '-x265-params',
      'log-level=error',
      '-tag:v',
      'hvc1',
      hevc,
    ]);
    // Use a display matrix. FFmpeg 8 does not apply the legacy rotate tag to this HEVC fixture.
    await execute('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-display_rotation:v:0',
      '90',
      '-i',
      hevc,
      '-c',
      'copy',
      rotated,
    ]);
    const meta = await probeVideo(rotated);
    expect(meta).toMatchObject({ width: 180, height: 640 });
    const preview = join(directory, 'hevc-preview.mp4');
    await preparePreview(rotated, preview, meta, new AbortController().signal, () => {});
    expect(await probeVideo(preview)).toMatchObject({ width: 180, height: 640, hasAudio: false });
  });
});
