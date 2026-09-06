import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DocumentUpload,
  DocumentDownload,
  PictureFrame,
  ShieldTick,
  VideoPlay,
  CloseCircle,
} from 'iconsax-reactjs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Inspector } from '@/components/Inspector';
import { VideoPreview } from '@/components/VideoPreview';
import { ExportDialog } from '@/components/ExportDialog';
import { useStudio } from '@/hooks/useStudio';
import { formatSize, formatTime } from '@/lib/api';

export default function App() {
  const studio = useStudio();
  const input = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState<boolean | null>(null);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const choose = useCallback(() => input.current?.click(), []);
  const showError = useCallback((message: string) => studio.setError(message), [studio.setError]);
  const blocked = studio.busy || studio.connecting || backgroundLoading;
  // A recovered export stays reachable until the user explicitly closes its dialog.
  const showExport = exportOpen ?? studio.job?.kind === 'export';

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (!blocked && !showExport) choose();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [blocked, showExport, choose]);

  return (
    <div
      className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          dragDepth.current++;
          if (!blocked && !showExport) setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current--;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file && !blocked && !showExport) void studio.importVideo(file);
      }}
    >
      <Input
        data-testid="video-input"
        aria-label="Import video file"
        ref={input}
        type="file"
        accept="video/*,.mov,.mp4,.m4v,.mkv,.webm,.avi"
        className="hidden"
        disabled={blocked}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void studio.importVideo(file);
          event.target.value = '';
        }}
      />
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card/60 px-4 sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
            <PictureFrame className="size-5 text-primary" />
          </div>
          <div>
            <p className="font-heading text-base font-semibold tracking-tight">
              frame<span className="ml-1 font-normal text-muted-foreground">studio</span>
            </p>
            <p className="mt-0.5 text-[9px] tracking-[0.1em] text-muted-foreground uppercase">
              A home for your videos
            </p>
          </div>
          <span className="mx-4 hidden h-6 w-px bg-border md:block" />
          <div className="hidden min-w-0 md:block">
            <p className="max-w-[320px] truncate text-xs text-foreground/85">
              {studio.asset?.name ?? 'Untitled canvas'}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {studio.asset
                ? 'Ready for a new perspective'
                : 'Start with a recording you already love'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            className="h-9 px-3 text-xs"
            onClick={choose}
            disabled={blocked}
            aria-label="Import video"
          >
            <DocumentUpload />
            <span className="hidden sm:inline">Import video</span>
          </Button>
          <Button
            aria-label="Export video"
            className="h-9 px-3 text-xs sm:px-4"
            disabled={!studio.asset || blocked}
            onClick={() => {
              studio.clearFinishedJob();
              studio.setError(null);
              setExportOpen(true);
            }}
          >
            <DocumentDownload /> Export<span className="hidden sm:inline"> video</span>
          </Button>
        </div>
      </header>
      {studio.error && !showExport && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/10 px-6 py-3 text-xs text-destructive"
        >
          <span>{studio.error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss error"
            onClick={() => studio.setError(null)}
          >
            <CloseCircle />
          </Button>
        </div>
      )}
      <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_310px]">
        <section
          aria-label="Video workspace"
          className="flex min-h-[510px] min-w-0 flex-col lg:min-h-0"
        >
          <div className="min-h-[410px] flex-1 lg:min-h-0">
            <VideoPreview
              key={studio.asset?.id ?? 'empty'}
              asset={studio.asset}
              settings={studio.settings}
              busy={blocked}
              uploading={studio.uploading}
              job={studio.job}
              onChoose={choose}
              onCancel={() => {
                void studio.cancel();
              }}
              onError={showError}
            />
          </div>
          <div className="mx-5 mb-6 flex min-h-[66px] items-center gap-3 rounded-xl border border-border/70 bg-card/45 px-4 sm:mx-10">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary/50">
              <VideoPlay className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">
                {studio.asset?.name ?? 'Your recording goes here'}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {studio.asset
                  ? `${studio.asset.width} × ${studio.asset.height} · ${formatTime(studio.asset.duration)} · ${formatSize(studio.asset.size)}`
                  : 'MOV, MP4, and more · Drag a video anywhere to import'}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 text-[11px] text-muted-foreground"
              onClick={choose}
              disabled={blocked}
            >
              {studio.asset ? 'Replace' : 'Browse'}
            </Button>
          </div>
        </section>
        <Inspector
          settings={studio.settings}
          onChange={studio.setSettings}
          disabled={blocked}
          onBackgroundBusyChange={setBackgroundLoading}
        />
      </main>
      <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-card/30 px-5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <ShieldTick className="size-3 text-[#91b5a1]" /> Everything stays on your Mac
        </span>
        <span className="hidden sm:inline">Made for the finishing touches.</span>
        <span className="hidden items-center gap-1.5 lg:flex">
          <kbd className="rounded border border-border px-1 py-0.5 text-[9px]">Space</kbd> Play /
          pause
        </span>
      </footer>
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/90 backdrop-blur-sm">
          <div className="text-center">
            <DocumentUpload className="mx-auto mb-4 size-12 text-primary" />
            <p className="font-heading text-2xl font-semibold">Drop it into frame.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Your video is about to look right at home.
            </p>
          </div>
        </div>
      )}
      <ExportDialog
        open={showExport}
        onOpenChange={setExportOpen}
        asset={studio.asset}
        settings={studio.settings}
        job={studio.job}
        error={studio.error}
        onExport={studio.exportVideo}
        onCancel={studio.cancel}
      />
    </div>
  );
}
