import { useCallback, useEffect, useState } from 'react';
import { Magicpen, TickCircle, Trash } from 'iconsax-reactjs';
import type { MediaAsset, Settings } from '../../shared/types';
import type { ZoomPlan } from '../../shared/zoom-plan';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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

  const start = useCallback(async () => {
    setNote(null);
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
        <p className="text-[10px] text-muted-foreground">
          Planning, {Math.round((planning?.progress ?? 0) * 100)}%. This takes several minutes, and
          you can keep editing while it runs.
        </p>
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
