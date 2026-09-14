import { type RefObject, useEffect, useMemo } from 'react';
import type { Layout } from '../../shared/composition';
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
} from '../../shared/cursor';
import type { MediaAsset, Settings } from '../../shared/types';

interface Options {
  asset: MediaAsset | null;
  settings: Settings;
  layout: Layout;
  scale: number;
  video: RefObject<HTMLVideoElement | null>;
  canvas: RefObject<HTMLCanvasElement | null>;
}

// Drives the live preview of the enhanced cursor and the auto zoom.
//
// Everything here comes from shared/cursor.ts, the same module the FFmpeg export path
// uses, so what you see while tuning is what you get when you export.
export function useCursorLayer({ asset, settings, layout, scale, video, canvas }: Options) {
  const track = asset?.cursorTrack;

  // Rendering happens at the displayed size rather than full canvas resolution, since
  // the preview only ever shows the scaled composition.
  const width = Math.max(1, Math.round(layout.width * scale));
  const height = Math.max(1, Math.round(layout.height * scale));

  const model = useMemo(() => {
    if (!track || !asset) return null;
    const displayScale = track.meta.displayScale;
    const videoRect = {
      x: layout.video.x * scale,
      y: layout.video.y * scale,
      width: layout.video.width * scale,
      height: layout.video.height * scale,
    };
    const baseHeight = ARROW_UNIT_HEIGHT * displayScale * (videoRect.width / asset.width);
    const cursorHeight = baseHeight * settings.cursorSize;
    return {
      displayScale,
      videoRect,
      cursorHeight,
      sprite: buildSprite(cursorHeight),
      path: smoothPath(track.events, { smoothing: settings.cursorSmoothing }, asset.duration),
      curve: buildZoomCurve(
        track.events,
        {
          enabled: settings.zoomEnabled,
          strength: settings.zoomStrength,
          speed: settings.zoomSpeed,
        },
        asset.duration,
        displayScale,
      ),
      clicks: settings.cursorClicks ? track.events.filter((event) => event.e === 'd') : [],
      samplesPerFrame: subsampleCount(settings.cursorBlur),
    };
  }, [track, asset, settings, layout, scale]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context) return;

    // With no track there is nothing to draw and no zoom to apply.
    if (!model || !asset || !track) {
      context.clearRect(0, 0, element.width, element.height);
      if (video.current) video.current.style.transform = '';
      return;
    }

    const buffer = new Uint8ClampedArray(width * height * 4);
    let frame = 0;
    let stopped = false;

    const draw = () => {
      if (stopped) return;
      frame = requestAnimationFrame(draw);
      const media = video.current;
      if (!media) return;
      // Track time and video time differ by the measured capture offset.
      const t = media.currentTime + track.meta.videoStartOffset;

      const key = zoomAt(model.curve, t);
      const region = visibleRegion(key, asset.width, asset.height);
      if (settings.zoomEnabled) {
        // Zoom is a transform on the existing video element, which the GPU handles.
        media.style.transformOrigin = '0 0';
        media.style.transform = `scale(${asset.width / region.width}) translate(${(-region.x / asset.width) * 100}%, ${(-region.y / asset.height) * 100}%)`;
      } else {
        media.style.transform = '';
      }

      if (!settings.cursorEnabled) {
        context.clearRect(0, 0, element.width, element.height);
        return;
      }

      buffer.fill(0);
      const fps = 60;
      const samples = [];
      for (let sub = 0; sub < model.samplesPerFrame; sub++) {
        const sampleTime = t + ((sub + 0.5) / model.samplesPerFrame - 0.5) / fps;
        const sampleRegion = visibleRegion(
          zoomAt(model.curve, sampleTime),
          asset.width,
          asset.height,
        );
        samples.push(
          sourceToCanvas(
            model.path.at(sampleTime),
            sampleRegion,
            model.videoRect,
            model.displayScale,
          ),
        );
      }
      const ripples = model.clicks
        .filter((click) => t - click.t >= 0 && t - click.t <= RIPPLE_LIFE)
        .map((click) => {
          const point = sourceToCanvas(click, region, model.videoRect, model.displayScale);
          return { x: point.x, y: point.y, age: t - click.t };
        });

      renderCursorFrame({
        out: buffer,
        width,
        height,
        sprite: model.sprite,
        samples,
        ripples,
        cursorHeight: model.cursorHeight,
      });
      context.putImageData(new ImageData(buffer, width, height), 0, 0);
    };

    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      if (video.current) video.current.style.transform = '';
    };
  }, [model, asset, track, settings, width, height, video, canvas]);

  return { width, height, hasTrack: !!track };
}
