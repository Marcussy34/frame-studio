import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { backgroundSvg, getLayout, maskSvg } from '../shared/composition';
import {
  ARROW_UNIT_HEIGHT,
  buildSprite,
  buildZoomCurve,
  renderCursorFrame,
  RIPPLE_LIFE,
  smoothPath,
  sourceToCanvas,
  subsampleCount,
  visibleRegion,
  zoomAt,
  zoomExpressions,
} from '../shared/cursor';
import type { CursorTrack } from '../shared/recording';
import type { ExportOptions, VideoMetadata } from '../shared/types';

type Progress = (progress: number) => void;
const ffmpeg = process.env.FRAME_FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FRAME_FFPROBE_PATH || 'ffprobe';

export function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
  onOutput?: (chunk: string) => void,
  // Supplies an extra input on stdin, used to feed the generated cursor layer so the
  // export stays a single pass with no intermediate video file.
  feedStdin?: (stream: NodeJS.WritableStream) => Promise<void>,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [feedStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (feedStdin && child.stdin) {
      const stdin = child.stdin;
      // A broken pipe is normal when ffmpeg stops early, so it must not reject.
      stdin.on('error', () => {});
      void feedStdin(stdin)
        .catch(() => {})
        .finally(() => stdin.end());
    }
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      child.kill('SIGTERM');
      timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-2_000_000);
      onOutput?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-5000);
    });
    child.on('error', reject);
    // Wait for close before cleaning files, including after cancellation.
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) reject(new Error('Video processing cancelled.'));
      else if (code !== 0) reject(new Error(stderr || `${command} exited with code ${code}.`));
      else resolve(stdout);
    });
    if (signal?.aborted) cancel();
  });
}

const fraction = (value: string | undefined) => {
  const [numerator, denominator = 1] = (value ?? '0').split(/[/:]/).map(Number);
  return denominator ? numerator / denominator : 0;
};

export async function probeVideo(path: string, signal?: AbortSignal): Promise<VideoMetadata> {
  const output = await runProcess(
    ffprobe,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      path,
    ],
    AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  );
  const data = JSON.parse(output) as {
    streams: {
      codec_type: string;
      width?: number;
      height?: number;
      duration?: string;
      start_time?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      sample_aspect_ratio?: string;
      side_data_list?: { rotation?: number }[];
    }[];
    format?: { duration?: string; start_time?: string };
  };
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  const numberOr = (value: string | undefined, fallback: number) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const containerStart = numberOr(data.format?.start_time, 0);
  const videoStart = numberOr(video?.start_time, containerStart);
  const audioStart = numberOr(audio?.start_time, videoStart);
  // One origin preserves the relative delay between the selected video and audio tracks.
  const timelineOrigin = Math.min(videoStart, audio ? audioStart : videoStart);
  const ends = [
    videoStart + Number(video?.duration),
    ...(audio ? [audioStart + Number(audio.duration)] : []),
    containerStart + Number(data.format?.duration),
  ].filter(Number.isFinite);
  const duration = Math.max(...ends) - timelineOrigin;
  if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('This file does not contain a readable video.');
  }
  const sar = fraction(video.sample_aspect_ratio) || 1;
  const rotation = video.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0;
  const rotated = Math.abs(rotation) % 180 === 90;
  // Match FFmpeg autorotation and account for non-square source pixels.
  const width = Math.round(rotated ? video.height : video.width * sar);
  const height = Math.round(rotated ? video.width * sar : video.height);
  if (width > 16_384 || height > 16_384 || duration > 86_400 || width < 2 || height < 2) {
    throw new Error('Choose a video below 16K resolution and 24 hours.');
  }
  return {
    width,
    height,
    duration,
    fps: Math.min(
      60,
      Math.max(1, fraction(video.avg_frame_rate) || fraction(video.r_frame_rate) || 30),
    ),
    hasAudio: !!audio,
    timelineOrigin,
    videoOffset: videoStart - timelineOrigin,
  };
}

function reportProgress(duration: number, progress: Progress) {
  let pending = '';
  return (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('out_time_us=')) {
        const seconds = Number(line.slice(12)) / 1_000_000;
        if (Number.isFinite(seconds)) progress(Math.max(0, Math.min(0.99, seconds / duration)));
      }
    }
  };
}

const baseArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
const inputArgs = (source: string) => ['-protocol_whitelist', 'file,pipe', '-i', source];
const encodeArgs = (meta: VideoMetadata) => [
  '-c:v',
  'libx264',
  '-preset',
  'fast',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-r',
  String(meta.fps),
  '-movflags',
  '+faststart',
  '-t',
  String(meta.duration),
  '-progress',
  'pipe:1',
  '-nostats',
];

// Hold the first/last frame through gaps while keeping the source's frame changes on time.
const videoTimeline = (meta: VideoMetadata) =>
  `setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration=${meta.videoOffset}:stop_mode=clone:stop=-1`;
const audioTimeline = (meta: VideoMetadata) =>
  `asetpts=PTS-(${meta.timelineOrigin})/TB,aresample=async=1:first_pts=0`;

export async function preparePreview(
  source: string,
  output: string,
  meta: VideoMetadata,
  signal: AbortSignal,
  progress: Progress,
): Promise<void> {
  signal.throwIfAborted();
  const factor = Math.min(1, 1280 / meta.width, 720 / meta.height);
  const width = Math.max(2, Math.round((meta.width * factor) / 2) * 2);
  const height = Math.max(2, Math.round((meta.height * factor) / 2) * 2);
  const audio = meta.hasAudio
    ? ['-map', '0:a:0', '-af', audioTimeline(meta), '-c:a', 'aac', '-b:a', '160k']
    : ['-an'];
  await runProcess(
    ffmpeg,
    [
      ...baseArgs,
      '-copyts',
      ...inputArgs(source),
      '-vf',
      `scale=${width}:${height},setsar=1,${videoTimeline(meta)}`,
      '-map',
      '0:v:0',
      ...audio,
      ...encodeArgs(meta),
      output,
    ],
    signal,
    reportProgress(meta.duration, progress),
  );
  progress(1);
}

// Streams the cursor overlay to ffmpeg as raw RGBA, one frame at a time. The layer is
// mostly transparent, so only the rectangle the cursor touched is ever written.
async function writeCursorLayer(
  stream: NodeJS.WritableStream,
  options: {
    track: CursorTrack;
    settings: ExportOptions['settings'];
    layout: ReturnType<typeof getLayout>;
    duration: number;
    fps: number;
    sourceWidth: number;
    sourceHeight: number;
    signal: AbortSignal;
  },
): Promise<void> {
  const { track, settings, layout, duration, fps, sourceWidth, sourceHeight, signal } = options;
  const frames = Math.max(1, Math.round(duration * fps));
  const scale = track.meta.displayScale;
  // The true on-screen cursor, expressed in canvas pixels, then enlarged by the setting.
  const baseHeight = ARROW_UNIT_HEIGHT * scale * (layout.video.width / sourceWidth);
  const sprite = buildSprite(baseHeight * settings.cursorSize);
  const path = smoothPath(track.events, { smoothing: settings.cursorSmoothing }, duration);
  const curve = buildZoomCurve(
    track.events,
    { enabled: settings.zoomEnabled, strength: settings.zoomStrength, speed: settings.zoomSpeed },
    duration,
    scale,
  );
  const samplesPerFrame = subsampleCount(settings.cursorBlur);
  const clicks = settings.cursorClicks ? track.events.filter((event) => event.e === 'd') : [];
  const frame = new Uint8ClampedArray(layout.width * layout.height * 4);
  const offset = track.meta.videoStartOffset;

  for (let index = 0; index < frames; index++) {
    signal.throwIfAborted();
    frame.fill(0);
    const positions = [];
    for (let sub = 0; sub < samplesPerFrame; sub++) {
      const t = (index + (sub + 0.5) / samplesPerFrame) / fps + offset;
      const region = visibleRegion(zoomAt(curve, t), sourceWidth, sourceHeight);
      positions.push(sourceToCanvas(path.at(t), region, layout.video, scale));
    }
    const midpoint = (index + 0.5) / fps + offset;
    const region = visibleRegion(zoomAt(curve, midpoint), sourceWidth, sourceHeight);
    const ripples = clicks
      .filter((click) => midpoint - click.t >= 0 && midpoint - click.t <= RIPPLE_LIFE)
      .map((click) => {
        const point = sourceToCanvas(click, region, layout.video, scale);
        return { x: point.x, y: point.y, age: midpoint - click.t };
      });
    renderCursorFrame({
      out: frame,
      width: layout.width,
      height: layout.height,
      sprite,
      samples: positions,
      ripples,
      cursorHeight: baseHeight * settings.cursorSize,
    });
    if (!stream.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength))) {
      await new Promise((resolve) => stream.once('drain', resolve));
    }
  }
}

export async function renderVideo(
  source: string,
  output: string,
  meta: VideoMetadata,
  options: ExportOptions,
  signal: AbortSignal,
  progress: Progress,
  // Present only for assets that came from a Frame Studio recording.
  track?: CursorTrack,
): Promise<void> {
  signal.throwIfAborted();
  const layout = getLayout(options.settings, meta, options.resolution);
  const temporary = await mkdtemp(join(dirname(output), 'render-'));
  const background = join(temporary, 'background.png');
  const mask = join(temporary, 'mask.png');
  try {
    await Promise.all([
      sharp(Buffer.from(backgroundSvg(options.settings, layout)))
        .png()
        .toFile(background),
      sharp(Buffer.from(maskSvg(layout)))
        .removeAlpha()
        .greyscale()
        .png()
        .toFile(mask),
    ]);
    signal.throwIfAborted();
    const video = layout.video;
    const cursor = track && (options.settings.cursorEnabled || options.settings.zoomEnabled);
    // zoompan crops from the input scaled by `zoom`, so running it at source resolution
    // and scaling down afterwards keeps full detail at every zoom level.
    const zoom =
      track && options.settings.zoomEnabled
        ? (() => {
            const curve = buildZoomCurve(
              track.events,
              {
                enabled: true,
                strength: options.settings.zoomStrength,
                speed: options.settings.zoomSpeed,
              },
              meta.duration,
              track.meta.displayScale,
            );
            const expressions = zoomExpressions(curve, meta.width, meta.height, meta.fps);
            return `zoompan=z='${expressions.z}':x='${expressions.x}':y='${expressions.y}':d=1:s=${meta.width}x${meta.height}:fps=${meta.fps},`;
          })()
        : '';
    const base = `[0:v:0]${zoom}scale=${video.width}:${video.height}:flags=lanczos,setsar=1,format=rgba,${videoTimeline(meta)}[video];[video][2:v]alphamerge=shortest=1[rounded];[1:v][rounded]overlay=${video.x}:${video.y}:shortest=1:format=auto`;
    const filters = cursor
      ? `${base}[base];[base][3:v]overlay=0:0:shortest=1:format=auto,format=yuv420p[out]`
      : `${base},format=yuv420p[out]`;
    const audio =
      options.includeAudio && meta.hasAudio
        ? ['-map', '0:a:0', '-af', audioTimeline(meta), '-c:a', 'aac', '-b:a', '192k']
        : ['-an'];
    const cursorInput = cursor
      ? [
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          '-s',
          `${layout.width}x${layout.height}`,
          '-framerate',
          String(meta.fps),
          '-i',
          'pipe:0',
        ]
      : [];
    await runProcess(
      ffmpeg,
      [
        ...baseArgs,
        '-copyts',
        ...inputArgs(source),
        '-loop',
        '1',
        '-framerate',
        String(meta.fps),
        '-i',
        background,
        '-loop',
        '1',
        '-framerate',
        String(meta.fps),
        '-i',
        mask,
        ...cursorInput,
        '-filter_complex_threads',
        '2',
        '-filter_complex',
        filters,
        '-map',
        '[out]',
        ...audio,
        ...encodeArgs(meta),
        output,
      ],
      signal,
      reportProgress(meta.duration, progress),
      cursor && track
        ? (stream) =>
            writeCursorLayer(stream, {
              track,
              settings: options.settings,
              layout,
              duration: meta.duration,
              fps: meta.fps,
              sourceWidth: meta.width,
              sourceHeight: meta.height,
              signal,
            })
        : undefined,
    );
    progress(1);
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
