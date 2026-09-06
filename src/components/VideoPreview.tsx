import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DocumentUpload,
  Play,
  Pause,
  VolumeHigh,
  VolumeSlash,
  VideoHorizontal,
  ArrowRotateLeft,
} from 'iconsax-reactjs';
import { backgroundSvg, getLayout } from '../../shared/composition';
import type { Job, MediaAsset, Settings } from '../../shared/types';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { formatTime } from '@/lib/api';

interface Props {
  asset: MediaAsset | null;
  settings: Settings;
  busy: boolean;
  uploading: boolean;
  job: Job | null;
  onChoose: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

export function VideoPreview({
  asset,
  settings,
  busy,
  uploading,
  job,
  onChoose,
  onCancel,
  onError,
}: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [box, setBox] = useState({ width: 640, height: 400 });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);
  const layout = useMemo(
    () => getLayout(settings, asset ?? { width: 1920, height: 1080 }),
    [settings, asset],
  );
  const background = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(backgroundSvg(settings, layout))}`,
    [settings, layout],
  );
  const scale = Math.min(box.width / layout.width, box.height / layout.height);
  const duration = asset?.duration ?? 0;
  const canPlay = !!asset && ready && !busy;
  const importing = uploading || (job?.kind === 'import' && job.status === 'processing');
  const frameHeight = layout.video.height * scale;

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setBox({
        width: Math.max(1, entry.contentRect.width),
        height: Math.max(1, entry.contentRect.height),
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const toggle = useCallback(() => {
    if (!video.current || !canPlay) return;
    if (video.current.paused)
      void video.current
        .play()
        .catch(() => onError('The preview could not play. Try importing the video again.'));
    else video.current.pause();
  }, [canPlay, onError]);

  useEffect(() => {
    if (busy) video.current?.pause();
  }, [busy]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.code !== 'Space' ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            'input, textarea, button, [role="slider"], [role="combobox"], [role="dialog"]',
          ))
      )
        return;
      if (canPlay) {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [canPlay, toggle]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-6 py-5 sm:px-10">
        <div>
          <p className="text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
            Your canvas
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            A little framing makes a big difference.
          </p>
        </div>
        <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground tabular-nums">
          {settings.ratio}
        </span>
      </div>
      <div className="relative min-h-[250px] flex-1 px-5 pb-5 sm:px-10">
        <div ref={stage} className="flex h-full min-h-[250px] w-full items-center justify-center">
          <div
            data-testid="composition"
            className="relative shrink-0 overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/5"
            style={{ width: layout.width * scale, height: layout.height * scale }}
          >
            <img src={background} alt="" draggable={false} className="absolute inset-0 size-full" />
            <div
              className="absolute overflow-hidden bg-[#f8f5f1]"
              style={{
                left: layout.video.x * scale,
                top: layout.video.y * scale,
                width: layout.video.width * scale,
                height: layout.video.height * scale,
                borderRadius: layout.video.radius * scale,
              }}
            >
              {asset ? (
                <video
                  ref={video}
                  src={asset.previewUrl}
                  className="size-full object-fill"
                  preload="auto"
                  playsInline
                  muted={muted}
                  onCanPlay={() => setReady(true)}
                  onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onError={() => {
                    setReady(false);
                    onError('This preview is unavailable. Import the video again to continue.');
                  }}
                />
              ) : (
                <div className="flex h-full flex-col text-[#49423d]">
                  <div className="flex h-[12%] min-h-4 shrink-0 items-center gap-1.5 border-b border-black/7 px-[4%]">
                    <span className="size-1.5 rounded-full bg-[#dfb2a3]" />
                    <span className="size-1.5 rounded-full bg-[#ddc8a2]" />
                    <span className="size-1.5 rounded-full bg-[#b8c6b0]" />
                    <span className="ml-auto text-[8px] tracking-wider text-[#9a9189] uppercase">
                      A fresh perspective
                    </span>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
                    {frameHeight > 260 && (
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#d8c9be] bg-white/60">
                        <VideoHorizontal className="size-5 text-[#aa7765]" />
                      </div>
                    )}
                    {layout.video.width * scale > 270 && frameHeight > 170 && (
                      <>
                        <h1 className="font-heading text-xl leading-snug font-semibold tracking-tight sm:text-2xl">
                          Your video.
                          <br />
                          <span className="text-[#ad7865]">Beautifully framed.</span>
                        </h1>
                        <p className="text-[11px] text-[#8b827a]">
                          Drop a recording here to get started.
                        </p>
                      </>
                    )}
                    {frameHeight > 72 && (
                      <Button
                        onClick={onChoose}
                        disabled={busy}
                        size="sm"
                        className="h-8 shrink-0 border border-[#d9cec5] bg-white/80 px-3 text-[11px] text-[#5f5046] hover:bg-white"
                      >
                        <DocumentUpload className="size-3.5" /> Choose a video
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {importing && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/75 px-8 backdrop-blur-sm">
            <div className="w-full max-w-xs space-y-4 rounded-2xl border border-border bg-card p-6 text-center shadow-2xl">
              <DocumentUpload className="mx-auto size-7 text-primary" />
              <p className="text-sm font-medium">
                {uploading ? 'Importing your video' : 'Preparing your preview'}
              </p>
              <p className="text-xs text-muted-foreground">
                {uploading
                  ? 'Copying the file into your local workspace.'
                  : 'Getting your recording ready for the canvas.'}
              </p>
              <Progress
                aria-label="Import progress"
                value={uploading ? null : Math.round((job?.progress ?? 0) * 100)}
              />
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel import
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="mx-5 mb-5 flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 sm:mx-10 sm:gap-4 sm:px-4">
        <Button
          aria-label={playing ? 'Pause' : 'Play'}
          variant="secondary"
          size="icon"
          disabled={!canPlay}
          onClick={toggle}
        >
          {playing ? <Pause variant="Bold" /> : <Play variant="Bold" />}
        </Button>
        <span className="w-9 text-[11px] text-foreground/90 tabular-nums">{formatTime(time)}</span>
        <Slider
          aria-label="Playback position"
          min={0}
          max={Math.max(duration, 1)}
          step={0.01}
          value={[time]}
          disabled={!canPlay}
          onValueChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (video.current) {
              video.current.currentTime = next;
              setTime(next);
            }
          }}
          className="min-w-0 flex-1"
        />
        <span className="w-9 text-[11px] text-muted-foreground tabular-nums">
          {formatTime(duration)}
        </span>
        <Button
          aria-label={muted ? 'Unmute preview' : 'Mute preview'}
          variant="ghost"
          size="icon-sm"
          disabled={!asset?.hasAudio}
          onClick={() => setMuted((value) => !value)}
        >
          {muted || !asset?.hasAudio ? <VolumeSlash /> : <VolumeHigh />}
        </Button>
        <Button
          aria-label="Restart playback"
          variant="ghost"
          size="icon-sm"
          className="hidden sm:inline-flex"
          disabled={!canPlay}
          onClick={() => {
            if (video.current) {
              video.current.currentTime = 0;
              setTime(0);
            }
          }}
        >
          <ArrowRotateLeft />
        </Button>
      </div>
    </div>
  );
}
