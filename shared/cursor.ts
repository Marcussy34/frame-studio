// Cursor and zoom rendering, derived from a raw capture track.
//
// Pure and dependency free on purpose: the browser preview and the FFmpeg export path
// both import this module, so there is one implementation and no way for them to drift.
//
// Nothing here is stored. Everything is derived from the raw ~500Hz event track plus
// the user's settings, so any parameter can be retuned without re-recording.

import type { CaptureFrame, CursorEvent } from './recording';

export interface CursorSettings {
  enabled: boolean;
  size: number; // multiplier on the true on-screen cursor height
  smoothing: number; // 0 none, 100 heaviest
  blur: number; // 0 none, 100 heaviest motion blur
  clicks: boolean; // click ripples
}

export interface ZoomSettings {
  enabled: boolean;
  strength: number; // maximum zoom factor, 1 disables
  speed: number; // 0 slow and gentle, 100 fast and snappy
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------- spring smoothing ----------

export interface Sampler {
  at(t: number): Point;
}

const SPRING_HZ = 600; // fixed integration rate keeps output frame-rate independent

// Heavier smoothing means a softer spring, which trails further behind the true
// position. That trailing is the effect people recognise as "smooth cursor".
function springFor(smoothing: number) {
  const amount = Math.max(0, Math.min(100, smoothing)) / 100;
  const tension = 900 - 700 * amount;
  return { tension, friction: 2 * Math.sqrt(tension), mass: 1 };
}

function nearestAt(events: CursorEvent[], time: number): CursorEvent {
  if (time <= events[0].t) return events[0];
  const last = events[events.length - 1];
  if (time >= last.t) return last;
  let low = 0;
  let high = events.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (events[mid].t <= time) low = mid;
    else high = mid;
  }
  return events[low];
}

export function smoothPath(
  events: CursorEvent[],
  settings: Pick<CursorSettings, 'smoothing'>,
  duration: number,
): Sampler {
  if (!events.length) {
    const origin = { x: 0, y: 0 };
    return { at: () => origin };
  }
  if (settings.smoothing <= 0) {
    return { at: (t) => ({ x: nearestAt(events, t).x, y: nearestAt(events, t).y }) };
  }

  const { tension, friction, mass } = springFor(settings.smoothing);
  const dt = 1 / SPRING_HZ;
  const steps = Math.max(2, Math.ceil((duration + 0.5) / dt));
  const data = new Float64Array(steps * 2);
  let px = events[0].x;
  let py = events[0].y;
  let vx = 0;
  let vy = 0;

  for (let i = 0; i < steps; i++) {
    const target = nearestAt(events, i * dt);
    // A click must land where the user actually clicked, so snap hard toward the
    // target on mousedown instead of letting the spring trail behind it.
    if (target.e === 'd') {
      px += (target.x - px) * 0.5;
      py += (target.y - py) * 0.5;
      vx *= 0.4;
      vy *= 0.4;
    }
    vx += ((-tension * (px - target.x) - friction * vx) / mass) * dt;
    vy += ((-tension * (py - target.y) - friction * vy) / mass) * dt;
    px += vx * dt;
    py += vy * dt;
    data[i * 2] = px;
    data[i * 2 + 1] = py;
  }

  return {
    at(t: number): Point {
      const f = t / dt;
      const i = Math.max(0, Math.min(steps - 2, Math.floor(f)));
      const a = f - i;
      return {
        x: data[i * 2] * (1 - a) + data[(i + 1) * 2] * a,
        y: data[i * 2 + 1] * (1 - a) + data[(i + 1) * 2 + 1] * a,
      };
    },
  };
}

// ---------- zoom curve ----------

export interface ZoomKey {
  t: number;
  z: number;
  cx: number;
  cy: number;
}

const ZOOM_LEAD = 0.45; // start moving in before the click lands
const ZOOM_TAIL = 1.4; // stay in afterwards so the result is readable

// Zoom follows attention, and clicks are the clearest signal of where attention is.
// Between clicks the frame eases back out rather than drifting with the pointer, which
// is far less nauseating to watch.
export function buildZoomCurve(
  events: CursorEvent[],
  settings: ZoomSettings,
  duration: number,
  // Events are global capture points; the visible region is in source pixels. Convert
  // at this boundary so every zoom coordinate downstream is in pixels.
  displayScale: number,
  // Capture origin series, so a window recording anchors zoom inside the window.
  frames: CaptureFrame[] = [],
): ZoomKey[] {
  const flat: ZoomKey[] = [{ t: 0, z: 1, cx: 0, cy: 0 }];
  if (!settings.enabled || settings.strength <= 1 || !events.length) return flat;

  const clicks = events.filter((event) => event.e === 'd');
  if (!clicks.length) return flat;

  const dt = 1 / 60;
  const steps = Math.max(2, Math.ceil(duration / dt));
  // A faster speed setting means a stiffer spring, so the frame settles sooner.
  const tension = 20 + (Math.max(0, Math.min(100, settings.speed)) / 100) * 45;
  const friction = 2 * Math.sqrt(tension);

  let z = 1;
  let vz = 0;
  const originFor = (t: number) => captureOriginAt(frames, t);
  const firstOrigin = originFor(clicks[0].t);
  let cx = (clicks[0].x - (firstOrigin?.x ?? 0)) * displayScale;
  let cy = (clicks[0].y - (firstOrigin?.y ?? 0)) * displayScale;
  let vcx = 0;
  let vcy = 0;
  const raw: ZoomKey[] = [];

  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    // Every click still in its window pulls the frame toward itself.
    let weight = 0;
    let tx = 0;
    let ty = 0;
    for (const click of clicks) {
      if (t < click.t - ZOOM_LEAD || t > click.t + ZOOM_TAIL) continue;
      const w = 1;
      const clickOrigin = originFor(click.t);
      weight += w;
      tx += (click.x - (clickOrigin?.x ?? 0)) * displayScale * w;
      ty += (click.y - (clickOrigin?.y ?? 0)) * displayScale * w;
    }
    const targetZ = weight > 0 ? settings.strength : 1;
    const targetX = weight > 0 ? tx / weight : cx;
    const targetY = weight > 0 ? ty / weight : cy;

    vz += ((-tension * (z - targetZ) - friction * vz) / 1) * dt;
    z += vz * dt;
    vcx += ((-tension * (cx - targetX) - friction * vcx) / 1) * dt;
    cx += vcx * dt;
    vcy += ((-tension * (cy - targetY) - friction * vcy) / 1) * dt;
    cy += vcy * dt;

    raw.push({ t, z: Math.max(1, z), cx, cy });
  }
  return simplifyCurve(raw);
}

// Keeps the expression handed to FFmpeg small. The curve is mostly flat between
// clicks, so dropping points that linear interpolation already predicts compresses it
// heavily without a visible difference.
export function simplifyCurve(points: ZoomKey[], tolerance = 0.004): ZoomKey[] {
  if (points.length < 3) return points.slice();
  const kept: ZoomKey[] = [points[0]];
  let anchor = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const next = points[i + 1];
    const span = next.t - anchor.t || 1;
    const a = (points[i].t - anchor.t) / span;
    const predictedZ = anchor.z + (next.z - anchor.z) * a;
    const predictedX = anchor.cx + (next.cx - anchor.cx) * a;
    const predictedY = anchor.cy + (next.cy - anchor.cy) * a;
    const drift =
      Math.abs(points[i].z - predictedZ) / 0.5 +
      Math.abs(points[i].cx - predictedX) / 600 +
      Math.abs(points[i].cy - predictedY) / 600;
    if (drift > tolerance) {
      kept.push(points[i]);
      anchor = points[i];
    }
  }
  kept.push(points[points.length - 1]);
  return kept;
}

export function zoomAt(curve: ZoomKey[], t: number): ZoomKey {
  if (!curve.length) return { t, z: 1, cx: 0, cy: 0 };
  if (t <= curve[0].t) return curve[0];
  const last = curve[curve.length - 1];
  if (t >= last.t) return last;
  let low = 0;
  let high = curve.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (curve[mid].t <= t) low = mid;
    else high = mid;
  }
  const a = curve[low];
  const b = curve[low + 1];
  const f = (t - a.t) / (b.t - a.t || 1);
  return {
    t,
    z: a.z + (b.z - a.z) * f,
    cx: a.cx + (b.cx - a.cx) * f,
    cy: a.cy + (b.cy - a.cy) * f,
  };
}

// ---------- coordinate mapping ----------

// The part of the source frame that is visible at a given zoom, clamped so the crop
// never runs past the edge and shows black.
export function visibleRegion(
  key: Pick<ZoomKey, 'z' | 'cx' | 'cy'>,
  sourceWidth: number,
  sourceHeight: number,
): Rect {
  const z = Math.max(1, key.z);
  const width = sourceWidth / z;
  const height = sourceHeight / z;
  return {
    width,
    height,
    x: Math.max(0, Math.min(sourceWidth - width, key.cx - width / 2)),
    y: Math.max(0, Math.min(sourceHeight - height, key.cy - height / 2)),
  };
}

// Where the capture sat in global screen space at a given moment. A window can be
// dragged mid-recording, so this is a series rather than a constant.
export function captureOriginAt(frames: CaptureFrame[], t: number): CaptureFrame | null {
  if (!frames.length) return null;
  if (t <= frames[0].t) return frames[0];
  const last = frames[frames.length - 1];
  if (t >= last.t) return last;
  let low = 0;
  let high = frames.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (frames[mid].t <= t) low = mid;
    else high = mid;
  }
  const a = frames[low];
  const b = frames[low + 1];
  const f = (t - a.t) / (b.t - a.t || 1);
  // Interpolated so a dragged window does not make the cursor jump between samples.
  return {
    t,
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    w: a.w + (b.w - a.w) * f,
    h: a.h + (b.h - a.h) * f,
  };
}

// Global cursor point to a pixel inside the captured frame. Returns null when the
// pointer was outside the capture, which happens constantly when recording a single
// window: drawing it clamped to the edge would show a cursor that was never there.
export function toCapturePixels(
  point: Point,
  origin: CaptureFrame | null,
  displayScale: number,
  sourceWidth: number,
  sourceHeight: number,
): Point | null {
  const x = (point.x - (origin?.x ?? 0)) * displayScale;
  const y = (point.y - (origin?.y ?? 0)) * displayScale;
  // A small margin keeps a cursor hugging the edge from flickering out.
  const margin = 2;
  if (x < -margin || y < -margin || x > sourceWidth + margin || y > sourceHeight + margin) {
    return null;
  }
  return { x, y };
}

// Source point, in capture points, to a pixel in the composed canvas.
export function sourceToCanvas(
  point: Point,
  region: Rect,
  video: Rect,
  displayScale: number,
  origin?: CaptureFrame | null,
): Point {
  const px = (point.x - (origin?.x ?? 0)) * displayScale;
  const py = (point.y - (origin?.y ?? 0)) * displayScale;
  return {
    x: video.x + ((px - region.x) / region.width) * video.width,
    y: video.y + ((py - region.y) / region.height) * video.height,
  };
}

// ---------- cursor sprite ----------

export interface Sprite {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  rgba: Uint8ClampedArray; // straight alpha
}

const ARROW: [number, number][] = [
  [0, 0],
  [0, 16.55],
  [4.02, 12.86],
  [6.62, 18.55],
  [8.98, 17.45],
  [6.46, 11.86],
  [11.22, 11.68],
];
export const ARROW_UNIT_HEIGHT = 18.55;

function signedDistance(px: number, py: number): number {
  let best = Infinity;
  let sign = 1;
  for (let i = 0, j = ARROW.length - 1; i < ARROW.length; j = i, i++) {
    const ex = ARROW[j][0] - ARROW[i][0];
    const ey = ARROW[j][1] - ARROW[i][1];
    const wx = px - ARROW[i][0];
    const wy = py - ARROW[i][1];
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * t;
    const by = wy - ey * t;
    best = Math.min(best, bx * bx + by * by);
    const c1 = py >= ARROW[i][1];
    const c2 = py < ARROW[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
  }
  return sign * Math.sqrt(best);
}

function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++)
        acc += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * kernel[i + radius];
      tmp[y * w + x] = acc;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++)
        acc += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * kernel[i + radius];
      out[y * w + x] = acc;
    }
  return out;
}

// White face, black outline, soft drop shadow. The shadow is what makes the pointer
// sit above the content instead of looking pasted on, and it keeps the cursor visible
// over white backgrounds.
export function buildSprite(targetHeight: number): Sprite {
  const round = 0.42;
  const stroke = 0.95;
  const scale = Math.max(4, targetHeight) / ARROW_UNIT_HEIGHT;
  const shadowSigma = Math.max(0.5, 0.032 * targetHeight);
  const shadowDx = 0.022 * targetHeight;
  const shadowDy = 0.04 * targetHeight;
  const pad = Math.ceil((stroke + round) * scale + shadowSigma * 3 + shadowDy) + 2;
  const width = Math.ceil(11.22 * scale) + pad * 2;
  const height = Math.ceil(ARROW_UNIT_HEIGHT * scale) + pad * 2;

  const face = new Float32Array(width * height);
  const silhouette = new Float32Array(width * height);
  const samples = 4;
  const inv = 1 / (samples * samples);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let f = 0;
      let s = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const ux = (x + (sx + 0.5) / samples - pad) / scale;
          const uy = (y + (sy + 0.5) / samples - pad) / scale;
          // Subtracting a constant from a signed distance rounds the convex corners.
          const d = signedDistance(ux, uy) - round;
          if (d < 0) f++;
          if (d - stroke < 0) s++;
        }
      }
      face[y * width + x] = f * inv;
      silhouette[y * width + x] = s * inv;
    }
  }

  const shadow = blur(silhouette, width, height, shadowSigma);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const sx = x - shadowDx;
      const sy = y - shadowDy;
      let cast = 0;
      if (sx >= 0 && sy >= 0 && sx < width - 1 && sy < height - 1) {
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const ax = sx - x0;
        const ay = sy - y0;
        cast =
          (shadow[y0 * width + x0] * (1 - ax) + shadow[y0 * width + x0 + 1] * ax) * (1 - ay) +
          (shadow[(y0 + 1) * width + x0] * (1 - ax) + shadow[(y0 + 1) * width + x0 + 1] * ax) * ay;
      }
      const shadowAlpha = Math.min(1, cast * 0.6);
      const alpha = face[i] + silhouette[i] * (1 - face[i]);
      const total = alpha + shadowAlpha * (1 - alpha);
      if (total <= 0.002) continue;
      // Outline and shadow are black, so the only colour comes from the white face.
      const value = Math.round((face[i] / total) * 255);
      const o = i * 4;
      rgba[o] = value;
      rgba[o + 1] = value;
      rgba[o + 2] = value;
      rgba[o + 3] = Math.round(total * 255);
    }
  }
  return { width, height, hotX: pad, hotY: pad, rgba };
}

// ---------- layer compositing ----------

export interface Ripple {
  x: number;
  y: number;
  age: number;
}

export interface LayerFrame {
  out: Uint8ClampedArray;
  width: number;
  height: number;
  sprite: Sprite;
  samples: Point[]; // sub-frame positions, averaged to produce motion blur
  ripples: Ripple[];
  cursorHeight: number;
}

export const RIPPLE_LIFE = 0.45;

export function subsampleCount(blurAmount: number): number {
  const amount = Math.max(0, Math.min(100, blurAmount)) / 100;
  return amount <= 0 ? 1 : Math.max(2, Math.round(2 + amount * 14));
}

// Accumulates sub-samples in premultiplied space, which is what makes the average a
// correct temporal blur rather than a stack of ghosts. Returns nothing, the caller owns
// clearing, because clearing only the touched rectangle is what keeps this fast.
export function renderCursorFrame(frame: LayerFrame): void {
  const { out, width, height, sprite, samples, ripples, cursorHeight } = frame;
  if (!samples.length) return;
  const weight = 1 / samples.length;

  // Accumulate into a scratch buffer sized to the touched region only.
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  const boxes: number[][] = [];
  for (const point of samples) {
    const x0 = Math.round(point.x) - sprite.hotX;
    const y0 = Math.round(point.y) - sprite.hotY;
    boxes.push([x0, y0, x0 + sprite.width, y0 + sprite.height]);
  }
  for (const ripple of ripples) {
    const radius = cursorHeight * (0.18 + (ripple.age / RIPPLE_LIFE) * 1.0) + cursorHeight * 0.12;
    boxes.push([
      Math.floor(ripple.x - radius),
      Math.floor(ripple.y - radius),
      Math.ceil(ripple.x + radius),
      Math.ceil(ripple.y + radius),
    ]);
  }
  for (const [x0, y0, x1, y1] of boxes) {
    minX = Math.min(minX, Math.max(0, x0));
    minY = Math.min(minY, Math.max(0, y0));
    maxX = Math.max(maxX, Math.min(width, x1));
    maxY = Math.max(maxY, Math.min(height, y1));
  }
  if (maxX <= minX || maxY <= minY) return;

  const boxW = maxX - minX;
  const boxH = maxY - minY;
  const acc = new Float32Array(boxW * boxH * 4);

  for (const point of samples) {
    const x0 = Math.round(point.x) - sprite.hotX;
    const y0 = Math.round(point.y) - sprite.hotY;
    for (let sy = 0; sy < sprite.height; sy++) {
      const dy = y0 + sy - minY;
      if (dy < 0 || dy >= boxH) continue;
      for (let sx = 0; sx < sprite.width; sx++) {
        const dx = x0 + sx - minX;
        if (dx < 0 || dx >= boxW) continue;
        const si = (sy * sprite.width + sx) * 4;
        const alpha = sprite.rgba[si + 3] / 255;
        if (alpha <= 0) continue;
        const wa = alpha * weight;
        const di = (dy * boxW + dx) * 4;
        acc[di] += (sprite.rgba[si] / 255) * wa;
        acc[di + 1] += (sprite.rgba[si + 1] / 255) * wa;
        acc[di + 2] += (sprite.rgba[si + 2] / 255) * wa;
        acc[di + 3] += wa;
      }
    }
  }

  for (const ripple of ripples) {
    if (ripple.age < 0 || ripple.age > RIPPLE_LIFE) continue;
    const progress = ripple.age / RIPPLE_LIFE;
    const radius = cursorHeight * (0.18 + progress * 1.0);
    const thickness = cursorHeight * 0.1 * (1 - progress) + 1;
    const alpha = (1 - progress) * (1 - progress) * 0.85;
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const d = Math.abs(Math.hypot(x + 0.5 - ripple.x, y + 0.5 - ripple.y) - radius);
        const coverage = Math.max(0, Math.min(1, (thickness - d) / 1.4));
        if (coverage <= 0) continue;
        const a = coverage * alpha;
        const di = ((y - minY) * boxW + (x - minX)) * 4;
        acc[di] += a;
        acc[di + 1] += a;
        acc[di + 2] += a;
        acc[di + 3] += a;
      }
    }
  }

  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      const ai = (y * boxW + x) * 4;
      const alpha = acc[ai + 3];
      if (alpha <= 0.002) continue;
      const oi = ((y + minY) * width + (x + minX)) * 4;
      const inv = 1 / alpha;
      out[oi] = Math.min(255, Math.round(acc[ai] * inv * 255));
      out[oi + 1] = Math.min(255, Math.round(acc[ai + 1] * inv * 255));
      out[oi + 2] = Math.min(255, Math.round(acc[ai + 2] * inv * 255));
      out[oi + 3] = Math.min(255, Math.round(alpha * 255));
    }
  }
}

// ---------- FFmpeg expression ----------

// zoompan has no runtime command support, so the whole curve has to travel inside the
// filter expression. Piecewise linear over the output frame index.
export function piecewiseExpression(points: { f: number; v: number }[], variable = 'on'): string {
  if (!points.length) return '0';
  let expression = points[points.length - 1].v.toFixed(4);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i];
    const b = points[i + 1];
    const span = Math.max(1, b.f - a.f);
    const segment = `(${a.v.toFixed(4)}+(${(b.v - a.v).toFixed(4)})*(${variable}-${a.f})/${span})`;
    expression = `if(lt(${variable},${b.f}),${segment},${expression})`;
  }
  return expression;
}

export interface ZoomExpressions {
  z: string;
  x: string;
  y: string;
}

// zoompan crops from the input scaled by `zoom`, so keeping the filter at source
// resolution and scaling down afterwards preserves full detail at every zoom level.
export function zoomExpressions(
  curve: ZoomKey[],
  sourceWidth: number,
  sourceHeight: number,
  fps: number,
): ZoomExpressions {
  const zs: { f: number; v: number }[] = [];
  const xs: { f: number; v: number }[] = [];
  const ys: { f: number; v: number }[] = [];
  for (const key of curve) {
    const region = visibleRegion(key, sourceWidth, sourceHeight);
    const frame = Math.round(key.t * fps);
    zs.push({ f: frame, v: Math.max(1, key.z) });
    xs.push({ f: frame, v: region.x * Math.max(1, key.z) });
    ys.push({ f: frame, v: region.y * Math.max(1, key.z) });
  }
  return {
    z: piecewiseExpression(zs),
    x: piecewiseExpression(xs),
    y: piecewiseExpression(ys),
  };
}
