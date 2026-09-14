import { useCallback, useEffect, useState } from 'react';
import { Maximize4, Monitor, Record } from 'iconsax-reactjs';
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
import { RecordingsList } from '@/components/RecordingsList';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
              <Label htmlFor="record-display">{target === 'display' ? 'Display' : 'Window'}</Label>
              <Select
                value={selected === null ? undefined : String(selected)}
                onValueChange={(value) => setSelected(Number(value))}
              >
                <SelectTrigger id="record-display" aria-label="Display">
                  <SelectValue
                    placeholder={target === 'display' ? 'Choose a display' : 'Choose a window'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {target === 'display'
                    ? displays.map((display) => (
                        <SelectItem key={display.id} value={String(display.id)}>
                          {display.name} ({display.width} × {display.height})
                        </SelectItem>
                      ))
                    : windows.map((item) => (
                        <SelectItem key={item.id} value={String(item.id)}>
                          {item.app} — {item.title}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
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
