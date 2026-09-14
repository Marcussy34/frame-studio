import { useCallback, useEffect, useState } from 'react';
import { Monitor, Record } from 'iconsax-reactjs';
import type { DisplayInfo } from '../../shared/recording';
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

export function RecordDialog({ open, onOpenChange, onStarted, onOpenRecording }: Props) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setCountdown(null);
      return;
    }
    setError(null);
    api<{ displays: DisplayInfo[] }>('/api/displays')
      .then((body) => {
        setDisplays(body.displays);
        setSelected((current) => current ?? body.displays[0]?.id ?? null);
      })
      .catch((cause: Error) => setError(cause.message));
  }, [open]);

  const begin = useCallback(async () => {
    if (selected === null) return;
    try {
      await api('/api/recording/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayID: selected }),
      });
      onStarted();
    } catch (cause) {
      setCountdown(null);
      setError((cause as Error).message);
    }
  }, [selected, onStarted]);

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
          <div className="space-y-2">
            <Label htmlFor="record-display">Display</Label>
            <Select
              value={selected === null ? undefined : String(selected)}
              onValueChange={(value) => setSelected(Number(value))}
            >
              <SelectTrigger id="record-display" aria-label="Display">
                <SelectValue placeholder="Choose a display" />
              </SelectTrigger>
              <SelectContent>
                {displays.map((display) => (
                  <SelectItem key={display.id} value={String(display.id)}>
                    <Monitor className="mr-2 inline size-4" />
                    {display.name} ({display.width} × {display.height})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
