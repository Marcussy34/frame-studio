import { useCallback, useEffect, useState } from 'react';
import { Maximize4, Monitor, Record, TickCircle } from 'iconsax-reactjs';
import type { DisplayInfo, WindowInfo } from '../../shared/recording';
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

type Target = 'display' | 'window';

export function RecordDialog({ open, onOpenChange, onStarted, onOpenRecording }: Props) {
  const [target, setTarget] = useState<Target>('display');
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Windows are refetched every time the picker opens, since the list goes stale as
  // soon as anyone opens or closes something.
  useEffect(() => {
    if (!open) {
      setCountdown(null);
      return;
    }
    setError(null);
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
    if (selected === null) return;
    try {
      await api('/api/recording/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          target === 'display' ? { displayID: selected } : { windowID: selected },
        ),
      });
      onStarted();
    } catch (cause) {
      setCountdown(null);
      setError((cause as Error).message);
    }
  }, [selected, target, onStarted]);

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
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/40 p-1">
              {(['display', 'window'] as const).map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={target === option ? 'secondary' : 'ghost'}
                  aria-pressed={target === option}
                  className="h-8 text-xs capitalize"
                  onClick={() => {
                    setSelected(null);
                    setTarget(option);
                  }}
                >
                  {option === 'display' ? <Monitor /> : <Maximize4 />}
                  {option === 'display' ? 'Full screen' : 'Window'}
                </Button>
              ))}
            </div>
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
          </div>
        ) : (
          <p className="py-8 text-center text-5xl font-semibold tabular-nums">{countdown}</p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <Button
          onClick={() => {
            setError(null);
            setCountdown(COUNTDOWN_SECONDS);
          }}
          disabled={selected === null || countdown !== null}
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
