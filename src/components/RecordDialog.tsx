import { useCallback, useEffect, useState } from 'react';
import { Crop, InfoCircle, Maximize4, Monitor, Record, TickCircle } from 'iconsax-reactjs';
import type {
  CaptureRegion,
  DisplayInfo,
  PermissionReport,
  WindowInfo,
} from '../../shared/recording';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { RecordingsList } from '@/components/RecordingsList';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: () => void;
  onOpenRecording: (id: string) => void;
}

const COUNTDOWN_SECONDS = 3;

type Target = 'display' | 'window' | 'region';

export function RecordDialog({ open, onOpenChange, onStarted, onOpenRecording }: Props) {
  const [target, setTarget] = useState<Target>('display');
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [region, setRegion] = useState<CaptureRegion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionReport | null>(null);

  // Checked when the dialog opens rather than discovered after a countdown. Without
  // Accessibility a recording refuses to start, and finding that out three seconds in,
  // with the window already hidden, is a miserable way to learn it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const report = await api<PermissionReport>('/api/recording/permissions');
        if (cancelled) return;
        setPermissions(report);
        // Granting happens over in System Settings, so the notice watches for it
        // rather than leaving stale advice on screen.
        if (!report.accessibility) timer = setTimeout(() => void check(), 2000);
      } catch {
        if (!cancelled) setPermissions(null);
      }
    };
    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open]);

  // Windows are refetched every time the picker opens, since the list goes stale as
  // soon as anyone opens or closes something.
  useEffect(() => {
    if (!open) {
      setCountdown(null);
      return;
    }
    setError(null);
    if (target === 'region') return;
    const path = target === 'display' ? '/api/displays' : '/api/windows';
    api<{ displays?: DisplayInfo[]; windows?: WindowInfo[] }>(path)
      .then((body) => {
        if (target === 'display') {
          const found = body.displays ?? [];
          setDisplays(found);
          setSelected(found[0]?.id ?? null);
        } else {
          const found = body.windows ?? [];
          setWindows(found);
          setSelected(found[0]?.id ?? null);
        }
      })
      .catch((cause: Error) => setError(cause.message));
  }, [open, target]);

  // Both kinds render through one list, which keeps the markup from forking.
  const options =
    target === 'display'
      ? displays.map((display) => ({
          id: display.id,
          label: display.name,
          detail: `${display.width} × ${display.height}`,
        }))
      : windows.map((item) => ({
          id: item.id,
          label: item.title || item.app,
          detail: `${item.app} · ${item.width} × ${item.height}`,
        }));

  const begin = useCallback(async () => {
    if (target === 'region' ? !region : selected === null) return;
    try {
      await api('/api/recording/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          target === 'region'
            ? { region }
            : target === 'display'
              ? { displayID: selected }
              : { windowID: selected },
        ),
      });
      onStarted();
    } catch (cause) {
      setCountdown(null);
      setError((cause as Error).message);
    }
  }, [selected, target, region, onStarted]);

  // Counts down visibly before starting, because the window hides on start and the
  // user needs a moment to get the screen ready.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      void begin();
      return;
    }
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, begin]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record your screen</DialogTitle>
          <DialogDescription>
            Frame Studio hides itself while recording. Use the stop button, or press Command Shift
            slash, to finish.
          </DialogDescription>
        </DialogHeader>

        {countdown === null ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary/40 p-1">
              {(
                [
                  ['display', 'Full screen', <Monitor key="d" />],
                  ['window', 'Window', <Maximize4 key="w" />],
                  ['region', 'Area', <Crop key="r" />],
                ] as const
              ).map(([option, label, icon]) => (
                <Button
                  key={option}
                  size="sm"
                  variant={target === option ? 'secondary' : 'ghost'}
                  aria-pressed={target === option}
                  className="h-8 px-1 text-xs"
                  onClick={() => {
                    setSelected(null);
                    setTarget(option);
                  }}
                >
                  {icon}
                  {label}
                </Button>
              ))}
            </div>
            {target === 'region' ? (
              <div className="space-y-2">
                <Label>Area</Label>
                <Button
                  variant="outline"
                  className="h-auto w-full flex-col items-start gap-1 py-3 text-left"
                  onClick={async () => {
                    setError(null);
                    try {
                      const body = await api<{ region: CaptureRegion | null }>(
                        '/api/recording/region',
                        { method: 'POST' },
                      );
                      if (body.region) setRegion(body.region);
                    } catch (cause) {
                      setError((cause as Error).message);
                    }
                  }}
                >
                  <span className="flex items-center gap-2 text-xs font-medium">
                    <Crop className="size-4" />
                    {region ? 'Choose a different area' : 'Drag to choose an area'}
                  </span>
                  <span className="text-[10px] font-normal text-muted-foreground">
                    {region
                      ? `${region.width} × ${region.height} selected`
                      : 'Draw a box anywhere on screen, like Command Shift 4'}
                  </span>
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>{target === 'display' ? 'Display' : 'Window'}</Label>
                {/* A visible list rather than a dropdown: there are rarely many options, and
                  hiding them behind a click made choosing one feel like nothing happened. */}
                <div
                  role="radiogroup"
                  aria-label={target === 'display' ? 'Display' : 'Window'}
                  className="max-h-48 space-y-1 overflow-y-auto"
                >
                  {options.length === 0 && (
                    <p className="rounded-lg border border-border/70 bg-card/45 px-3 py-4 text-center text-xs text-muted-foreground">
                      {error ? 'Nothing to show.' : 'Looking for something to record…'}
                    </p>
                  )}
                  {options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected === option.id}
                      onClick={() => setSelected(option.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border border-border/70 bg-card/45 px-3 py-2.5 text-left transition-colors hover:bg-card/80',
                        selected === option.id && 'border-primary/70 bg-primary/8',
                      )}
                    >
                      {target === 'display' ? (
                        <Monitor className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <Maximize4 className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{option.label}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {option.detail}
                        </span>
                      </span>
                      {selected === option.id && (
                        <TickCircle className="size-4 shrink-0 text-primary" variant="Bold" />
                      )}
                    </button>
                  ))}
                </div>
                {target === 'window' && (
                  <p className="text-[10px] text-muted-foreground">
                    The cursor is hidden while it is outside the window. Moving the window is fine;
                    resizing it mid recording is not supported yet.
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="py-8 text-center text-5xl font-semibold tabular-nums">{countdown}</p>
        )}

        {permissions && !permissions.accessibility && countdown === null && (
          <div className="space-y-2 rounded-lg border border-primary/70 bg-primary/8 p-3">
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <InfoCircle className="mt-px size-4 shrink-0 text-primary" />
              <span>
                Frame Studio cannot see your cursor yet, so recording will not start. Allow
                Accessibility to capture where your pointer moves and clicks.
              </span>
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-full text-xs"
              onClick={async () => {
                // macOS shows its own dialog here, which carries the only reliable link
                // into the right System Settings pane.
                setError(null);
                try {
                  setPermissions(
                    await api<PermissionReport>('/api/recording/access', {
                      method: 'POST',
                    }),
                  );
                } catch (cause) {
                  setError((cause as Error).message);
                }
              }}
            >
              Allow cursor recording
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <Button
          onClick={() => {
            setError(null);
            setCountdown(COUNTDOWN_SECONDS);
          }}
          disabled={(target === 'region' ? !region : selected === null) || countdown !== null}
        >
          <Record /> Start recording
        </Button>

        <div className="border-t border-border/70 pt-3">
          <RecordingsList
            refreshKey={open ? 1 : 0}
            onOpen={(id) => {
              onOpenChange(false);
              onOpenRecording(id);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
