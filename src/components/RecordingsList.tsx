import { useCallback, useEffect, useState } from 'react';
import { Trash, VideoPlay } from 'iconsax-reactjs';
import { api, formatSize, formatTime } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface RecordingSummary {
  id: string;
  createdAt: string;
  duration: number;
  bytes: number;
}

interface Props {
  onOpen: (id: string) => void;
  // Changing this refetches, so a finished recording shows up straight away.
  refreshKey: number;
}

export function RecordingsList({ onOpen, refreshKey }: Props) {
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ recordings: RecordingSummary[] }>('/api/recordings')
      .then((body) => setRecordings(body.recordings))
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(load, [load, refreshKey]);

  const remove = async (id: string) => {
    setPending(id);
    try {
      await fetch(`/api/recordings/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'X-Frame-Studio': '1' },
      });
      load();
    } catch {
      setError('That recording could not be deleted.');
    } finally {
      setPending(null);
    }
  };

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!recordings.length)
    return <p className="text-xs text-muted-foreground">No recordings saved yet.</p>;

  const total = recordings.reduce((sum, item) => sum + item.bytes, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium">Saved recordings</p>
        {/* Capture runs at roughly 3MB per second at 4K, so the running total matters. */}
        <p className="text-[10px] text-muted-foreground">{formatSize(total)} on disk</p>
      </div>
      <ul className="max-h-44 space-y-1 overflow-y-auto">
        {recordings.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/45 px-2.5 py-2"
          >
            <VideoPlay className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px]">{new Date(item.createdAt).toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground">
                {formatTime(item.duration)} · {formatSize(item.bytes)}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 text-[11px]"
              onClick={() => onOpen(item.id)}
            >
              Open
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete recording from ${new Date(item.createdAt).toLocaleString()}`}
              disabled={pending === item.id}
              onClick={() => void remove(item.id)}
            >
              <Trash />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
