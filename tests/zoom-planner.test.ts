import { describe, expect, it, vi } from 'vitest';
import type { runAgy } from '../desktop/zoom-planner/agy';
import { createZoomPlanner, type PlanRequest } from '../desktop/zoom-planner';
import type { CursorEvent, CursorTrack } from '../shared/recording';

type AskOptions = Parameters<typeof runAgy>[0];

// Captures what the planner would have sent, which is the only way to assert on the
// prompt without a typed mock fighting the inference.
function recordingAsk(reply: string) {
  const seen: AskOptions[] = [];
  const ask = async (options: AskOptions) => {
    seen.push(options);
    return reply;
  };
  return { ask, seen };
}

const location = { script: '/fake/agy-delegate.sh', binDirectory: '/opt/homebrew/bin' };

function track(): CursorTrack {
  const events: CursorEvent[] = [];
  for (let i = 0; i < 4; i++) {
    const t = 2 + i * 5;
    events.push({ t, x: 300 + i * 20, y: 200, e: 'd', b: 0 });
    events.push({ t: t + 0.1, x: 300 + i * 20, y: 200, e: 'u', b: 0 });
  }
  return {
    meta: {
      version: 1,
      captureKind: 'display',
      captureTitle: '',
      captureFrames: [],
      displayScale: 2,
      displayPoints: { w: 960, h: 540 },
      videoStartOffset: 0.5,
      duration: 25,
      createdAt: '2026-09-14T00:00:00.000Z',
      audio: { system: false, microphone: false, device: '' },
    },
    events,
  };
}

function request(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    video: '/fake/video.mov',
    track: track(),
    settings: { enabled: true, strength: 2.5, speed: 55 },
    duration: 25,
    source: { width: 1920, height: 1080 },
    ffmpeg: '/fake/ffmpeg',
    // Off by default here so the tests never shell out to ffmpeg.
    useFrames: false,
    signal: new AbortController().signal,
    progress: () => {},
    ...overrides,
  };
}

const goodReply = `Here you go:
\`\`\`json
{"shots":[{"start":1,"end":6,"zoom":2.2,"focus":"cursor","ease":"snap","why":"the form"}]}
\`\`\``;

describe('createZoomPlanner', () => {
  it('reports unavailable when Antigravity is not installed', () => {
    expect(createZoomPlanner({ locate: () => null }).available()).toBe(false);
    expect(createZoomPlanner({ locate: () => location }).available()).toBe(true);
  });

  it('uses the model plan when the reply is good', async () => {
    const planner = createZoomPlanner({ locate: () => location, ask: async () => goodReply });
    const outcome = await planner.plan(request());
    expect(outcome.plan.source).toBe('model');
    expect(outcome.plan.shots[0].why).toBe('the form');
    expect(outcome.note).toBeUndefined();
  });

  it('falls back to the mechanical plan when Antigravity is missing, and says so', async () => {
    const planner = createZoomPlanner({ locate: () => null });
    const outcome = await planner.plan(request());
    expect(outcome.plan.source).toBe('heuristic');
    expect(outcome.plan.shots.length).toBeGreaterThan(0);
    expect(outcome.note).toMatch(/not installed/i);
  });

  it('falls back when the model returns something unusable', async () => {
    // The point of the fallback: a bad answer costs the model's contribution, never
    // the user's recording.
    for (const reply of ['I cannot do that', '{"shots":[{"start":1,', '{"shots":[]}']) {
      const planner = createZoomPlanner({ locate: () => location, ask: async () => reply });
      const outcome = await planner.plan(request());
      expect(outcome.plan.source).toBe('heuristic');
      expect(outcome.plan.shots.length).toBeGreaterThan(0);
      expect(outcome.note).toBeTruthy();
    }
  });

  it('falls back and surfaces the reason when the transport fails', async () => {
    const planner = createZoomPlanner({
      locate: () => location,
      ask: async () => {
        throw new Error('Antigravity is out of quota for now, so the automatic zoom was kept.');
      },
    });
    const outcome = await planner.plan(request());
    expect(outcome.plan.source).toBe('heuristic');
    expect(outcome.note).toMatch(/quota/i);
  });

  it('propagates a cancellation instead of quietly returning a plan', async () => {
    // A cancelled job must not look like a completed one.
    const controller = new AbortController();
    const planner = createZoomPlanner({
      locate: () => location,
      ask: async () => {
        controller.abort();
        throw new Error('Planning was cancelled.');
      },
    });
    await expect(planner.plan(request({ signal: controller.signal }))).rejects.toThrow(/cancel/i);
  });

  it('sends no frames at all when asked to plan from the track alone', async () => {
    // The privacy switch. With this off, nothing of the screen leaves the machine.
    const { ask, seen } = recordingAsk(goodReply);
    const planner = createZoomPlanner({ locate: () => location, ask });
    await planner.plan(request({ useFrames: false }));
    expect(seen[0].prompt).toContain('There are\n0 of them');
  });

  it('always reaches full progress, even when it falls back', async () => {
    const progress = vi.fn();
    const planner = createZoomPlanner({
      locate: () => location,
      ask: async () => {
        throw new Error('nope');
      },
    });
    await planner.plan(request({ progress }));
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('gives the model the mechanical plan to improve rather than a blank page', async () => {
    const { ask, seen } = recordingAsk(goodReply);
    const planner = createZoomPlanner({ locate: () => location, ask });
    await planner.plan(request());
    expect(seen[0].prompt).toContain('A STARTING POINT');
  });
});
