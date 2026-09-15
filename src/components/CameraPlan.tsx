import { useCallback, useEffect, useState } from 'react';
import { Magicpen, TickCircle, Trash } from 'iconsax-reactjs';
import type { MediaAsset, Settings } from '../../shared/types';
import type { ZoomPlan } from '../../shared/zoom-plan';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';

interface Props {
  asset: MediaAsset;
  settings: Settings;
  onChange: (settings: Settings) => void;
  // The recording reloads so the new plan reaches the preview through the same path an
  // opened recording takes, rather than a second way of getting a plan into the UI.
  onPlanned: () => void;
  disabled: boolean;
}

interface PlanJob {
  id: string;
  status: 'processing' | 'ready' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
}

// The three things planning actually does, read off the only progress the job reports:
// 0.4 when the frames are cut, 0.95 when the model has answered. The middle stage is the
// long one and the only honest thing to say about it is roughly how long it takes.
export function stageOf(progress: number): { label: string; detail: string } {
  // Short enough to fit the inspector, which is about 230px wide. The longer sentence
  // belongs in the detail line, where it can wrap.
  if (progress < 0.4) {
    return { label: 'Sampling frames', detail: 'Picking the moments worth looking at.' };
  }
  if (progress < 0.95) {
    return {
      label: 'Watching your recording',
      detail: 'The long part, usually around nine minutes. You can keep editing while it runs.',
    };
  }
  return { label: 'Reading the plan', detail: 'Almost there.' };
}

export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function timeRange(start: number, end: number): string {
  const clock = (value: number) =>
    `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  return `${clock(start)} to ${clock(end)}`;
}

export function CameraPlan({ asset, settings, onChange, onPlanned, disabled }: Props) {
  const plan: ZoomPlan | undefined = asset.zoomPlan;
  const [planning, setPlanning] = useState<PlanJob | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Frames are what let the model read the screen. Off means only the cursor track
  // leaves this machine.
  const [useFrames, setUseFrames] = useState(true);
  const [available, setAvailable] = useState<boolean | null>(null);
  // Planning sits on one progress value for minutes at a time, so a number alone looks
  // frozen. A clock that keeps moving is the thing that says it is still working.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The button is hidden rather than shown broken when Antigravity is not installed,
  // which is the common case on any machine but the one this was built on.
  useEffect(() => {
    api<{ available: boolean }>('/api/zoom-plan/available')
      .then((body) => setAvailable(body.available))
      .catch(() => setAvailable(false));
  }, []);

  // Planning reads frames and waits on a model, so it runs as a job and is polled the
  // same way an export is.
  useEffect(() => {
    if (!planning || planning.status !== 'processing') return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const job = await api<PlanJob>(`/api/jobs/${planning.id}`);
        if (cancelled) return;
        setPlanning(job);
        if (job.status === 'ready') {
          // An error on a ready job means the model could not be used and the
          // mechanical plan was written instead. Worth saying, not worth failing on.
          setNote(job.error ?? null);
          onPlanned();
        }
      } catch {
        if (!cancelled) setPlanning(null);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [planning, onPlanned]);

  // Ticks only while a plan is running, so an idle panel costs nothing.
  useEffect(() => {
    if (!planning || planning.status !== 'processing') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [planning]);

  const start = useCallback(async () => {
    setNote(null);
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const job = await api<PlanJob>(
        `/api/recordings/${encodeURIComponent(asset.name)}/zoom-plan`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ useFrames }),
        },
      );
      setPlanning(job);
    } catch (cause) {
      setNote((cause as Error).message);
    }
  }, [asset.name, useFrames]);

  const discard = useCallback(async () => {
    try {
      await api(`/api/recordings/${encodeURIComponent(asset.name)}/zoom-plan`, {
        method: 'DELETE',
      });
      onChange({ ...settings, zoomSource: 'auto' });
      onPlanned();
    } catch (cause) {
      setNote((cause as Error).message);
    }
  }, [asset.name, onChange, onPlanned, settings]);

  if (available === false && !plan) return null;
  const busy = planning?.status === 'processing';
  const stage = stageOf(planning?.progress ?? 0);

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-card/45 p-3">
      <div className="flex items-center justify-between text-xs font-medium">
        <span className="flex items-center gap-2">
          <Magicpen className="size-4 text-primary" /> Camera plan
        </span>
        {plan && (
          <span className="text-[10px] font-normal text-muted-foreground">
            {plan.shots.length} shot{plan.shots.length === 1 ? '' : 's'}
            {plan.source === 'model' ? ', by AI' : ', automatic'}
          </span>
        )}
      </div>

      {plan ? (
        <>
          <div className="flex items-center justify-between text-xs">
            <Label className="font-normal text-foreground/85">Use the plan</Label>
            <Switch
              aria-label="Use the plan"
              checked={settings.zoomSource === 'plan'}
              onCheckedChange={(value) =>
                onChange({ ...settings, zoomSource: value ? 'plan' : 'auto' })
              }
            />
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {plan.shots.map((shot, index) => (
              <li
                key={`${shot.start}-${index}`}
                className="rounded-md bg-secondary/40 px-2.5 py-1.5 text-[10px] leading-tight"
              >
                <span className="flex items-center justify-between gap-2 font-medium tabular-nums">
                  <span>{timeRange(shot.start, shot.end)}</span>
                  <span className="text-muted-foreground">{shot.zoom.toFixed(1)}x</span>
                </span>
                {shot.why && <span className="block text-muted-foreground">{shot.why}</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Have the camera planned shot by shot instead of zooming on every click. Takes several
          minutes. Frames of this recording are sent to Google through your Antigravity account.
        </p>
      )}

      {available !== false && (
        <div className="flex items-center justify-between text-xs">
          <Label className="font-normal text-foreground/85">Let it see the screen</Label>
          <Switch
            aria-label="Let it see the screen"
            checked={useFrames}
            disabled={busy}
            onCheckedChange={setUseFrames}
          />
        </div>
      )}

      {busy ? (
        <div
          role="status"
          aria-live="polite"
          // Named, because the app has a dozen unnamed live regions and a screen reader
          // announcing an unattributed "waiting" is not much help.
          aria-label="Camera planning"
          className="space-y-2 rounded-md border border-border/70 bg-secondary/40 p-2.5"
        >
          <div className="flex items-center gap-2 text-[11px] font-medium">
            {/* Deliberately a moving thing rather than a number. The progress value can
                sit unchanged for the whole of the model's turn. */}
            <span
              aria-hidden
              className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary"
            />
            <span className="min-w-0 flex-1">{stage.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {elapsedLabel(now - (startedAt ?? now))}
            </span>
          </div>
          {/* The fill pulses as well as filling. Its value can be unchanged for the
              whole of the model's turn, and a bar that never moves reads as a stall.
              Reached through the slot the component sets on its indicator. */}
          <Progress
            aria-label="Planning progress"
            className="[&_[data-slot=progress-indicator]]:animate-pulse"
            // Never a hairline. At the first stage the real value is zero, and a bar with
            // no extent at all reads as a control that failed to render rather than as
            // work that has just begun.
            value={Math.max(5, Math.round((planning?.progress ?? 0) * 100))}
          />
          <p className="text-[10px] leading-relaxed text-muted-foreground">{stage.detail}</p>
        </div>
      ) : (
        <div className="flex gap-2">
          {available !== false && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 text-xs"
              disabled={disabled}
              onClick={() => void start()}
            >
              <Magicpen className="size-3.5" />
              {plan ? 'Plan again' : 'Plan the camera'}
            </Button>
          )}
          {plan && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={disabled}
              onClick={() => void discard()}
            >
              <Trash className="size-3.5" />
            </Button>
          )}
        </div>
      )}

      {note && <p className="text-[10px] leading-relaxed text-muted-foreground">{note}</p>}
      {planning?.status === 'ready' && !note && (
        <p className="flex items-center gap-1.5 text-[10px] text-primary">
          <TickCircle className="size-3.5" variant="Bold" /> Planned.
        </p>
      )}
    </div>
  );
}
