import { useState } from 'react';
import { DocumentDownload, TickCircle, VideoPlay } from 'iconsax-reactjs';
import { getLayout } from '../../shared/composition';
import type { ExportOptions, Job, MediaAsset, Settings } from '../../shared/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: MediaAsset | null;
  settings: Settings;
  job: Job | null;
  error: string | null;
  onExport: (options: ExportOptions) => Promise<void>;
  onCancel: () => Promise<void>;
}

export function ExportDialog({
  open,
  onOpenChange,
  asset,
  settings,
  job,
  error,
  onExport,
  onCancel,
}: Props) {
  const [resolution, setResolution] = useState<720 | 1080 | 2160>(1080);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const exporting = job?.kind === 'export' && job.status === 'processing';
  const complete = job?.kind === 'export' && job.status === 'ready';
  const busy = exporting || submitting;
  const layout = getLayout(settings, asset ?? { width: 1920, height: 1080 }, resolution);
  const exportNow = async () => {
    setSubmitting(true);
    try {
      await onExport({ settings, resolution, includeAudio });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="gap-6 p-6 sm:max-w-[430px]" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-semibold">
            {complete ? 'Your video is ready' : 'Export video'}
          </DialogTitle>
          <DialogDescription>
            {complete
              ? 'A fresh frame. Ready to share.'
              : 'Save your finished canvas as a high-quality MP4.'}
          </DialogDescription>
        </DialogHeader>
        {complete ? (
          <div className="space-y-5 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-emerald-400/10">
              <TickCircle variant="Bold" className="size-9 text-emerald-300" />
            </div>
            <p className="truncate text-xs text-muted-foreground">{job.filename}</p>
            <Button
              className="h-10 w-full"
              role="link"
              nativeButton={false}
              render={<a href={job.downloadUrl} download={job.filename} />}
            >
              <DocumentDownload /> Download MP4
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => onOpenChange(false)}>
              Back to editor
            </Button>
          </div>
        ) : busy ? (
          <div className="space-y-5 py-2">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10">
                <VideoPlay className="size-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">Rendering your canvas</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  You can keep this window open while we finish.
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Progress
                aria-label="Export progress"
                value={Math.round((job?.progress ?? 0) * 100)}
              />
              <p className="text-right text-xs text-muted-foreground tabular-nums">
                {Math.round((job?.progress ?? 0) * 100)}%
              </p>
            </div>
            <Button
              variant="outline"
              className="w-full"
              disabled={submitting}
              onClick={() => {
                void onCancel();
              }}
            >
              Cancel export
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-4">
              <div className="flex size-11 items-center justify-center rounded-lg bg-secondary">
                <VideoPlay className="size-6 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{asset?.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {layout.width} × {layout.height} · MP4
                </p>
              </div>
            </div>
            <div className="space-y-2.5">
              <Label htmlFor="resolution">Resolution</Label>
              <Select
                value={resolution}
                onValueChange={(value) => {
                  if (value === 720 || value === 1080 || value === 2160) setResolution(value);
                }}
              >
                <SelectTrigger id="resolution" aria-label="Resolution" className="h-10 w-full">
                  <SelectValue>
                    {resolution === 2160
                      ? '4K · Maximum detail'
                      : resolution === 1080
                        ? '1080p · Recommended'
                        : '720p · Smaller file'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={720}>720p · Smaller file</SelectItem>
                  <SelectItem value={1080}>1080p · Recommended</SelectItem>
                  <SelectItem value={2160}>4K · Maximum detail</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="include-audio">Include original audio</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {asset?.hasAudio
                    ? 'Keep the sound from your recording.'
                    : 'This video has no audio track.'}
                </p>
              </div>
              <Switch
                id="include-audio"
                checked={includeAudio && !!asset?.hasAudio}
                onCheckedChange={setIncludeAudio}
                disabled={!asset?.hasAudio}
              />
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                {error}
              </p>
            )}
            {job?.status === 'cancelled' && (
              <p role="status" className="text-xs text-muted-foreground">
                Export cancelled. Your video is unchanged.
              </p>
            )}
            <Button
              className="h-10 w-full"
              onClick={() => {
                void exportNow();
              }}
              disabled={!asset}
            >
              <DocumentDownload /> Export MP4
            </Button>
            <p className="-mt-3 text-center text-[10px] text-muted-foreground">
              Processed on your Mac. Your original stays untouched.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
