import { useEffect, useRef, useState } from 'react';
import {
  canvasStorageKey as storageKey,
  defaultSettings,
  settingsSchema,
} from '../../shared/composition';
import type { ExportOptions, Job, MediaAsset, Settings } from '../../shared/types';
import { api } from '@/lib/api';

function savedSettings(): Settings {
  try {
    const saved = settingsSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) || 'null'));
    return saved.success ? saved.data : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export function useStudio() {
  const [settings, setSettings] = useState(savedSettings);
  const [asset, setAsset] = useState<MediaAsset | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [uploading, setUploading] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [desktopPreferences, setDesktopPreferences] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const preferencesWrite = useRef(Promise.resolve());
  const busy = uploading || job?.status === 'processing';

  useEffect(() => {
    delete document.documentElement.dataset.desktopPreferencesReady;
    const controller = new AbortController();
    api<{ asset: MediaAsset | null; job: Job | null; preferences?: Settings }>('/api/session', {
      signal: controller.signal,
    })
      .then((session) => {
        setAsset(session.asset);
        setJob(session.job);
        const restored = settingsSchema.safeParse(session.preferences);
        if (restored.success) {
          setSettings(restored.data);
          setDesktopPreferences(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('The local app is not responding. Reopen Frame Studio and try again.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setConnecting(false);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(settings));
      if (desktopPreferences) document.documentElement.dataset.desktopPreferencesReady = 'true';
    } catch {
      delete document.documentElement.dataset.desktopPreferencesReady;
      /* Editing still works when browser storage is unavailable. */
    }
    if (desktopPreferences) {
      // Preserve edit order even when one local request is slower than the next.
      preferencesWrite.current = preferencesWrite.current
        .then(async () => {
          await api('/api/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
          });
        })
        .catch(() =>
          setError('Canvas preferences could not be saved. Your video can still be exported.'),
        );
    }
  }, [settings, desktopPreferences]);

  const jobId = job?.id;
  const processing = job?.status === 'processing';
  useEffect(() => {
    if (!jobId || !processing) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Job>(`/api/jobs/${jobId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setJob(next);
        if (next.asset && next.status === 'ready') setAsset(next.asset);
        if (next.status === 'failed') setError(next.error ?? 'This video could not be processed.');
        if (next.status === 'processing') timer = setTimeout(poll, 500);
      } catch {
        if (!controller.signal.aborted) {
          setError('The local app stopped responding. Reopen Frame Studio to continue.');
          setJob(null);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobId, processing]);

  async function importVideo(file: File) {
    if (busy || request.current) return;
    if (file.size > 4 * 1024 ** 3) {
      setError('Choose a video smaller than 4 GB.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setUploading(true);
    setError(null);
    setJob(null);
    try {
      const form = new FormData();
      form.append('video', file);
      const next = await api<Job>('/api/import', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      setJob(next);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'This video could not be imported.');
    } finally {
      if (request.current === controller) request.current = null;
      setUploading(false);
    }
  }

  async function exportVideo(options: ExportOptions) {
    if (!asset || busy || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    try {
      setJob(
        await api<Job>('/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...options, assetId: asset.id }),
          signal: controller.signal,
        }),
      );
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'This video could not be exported.');
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  async function cancel() {
    request.current?.abort();
    if (job?.status === 'processing') {
      try {
        setJob(await api<Job>(`/api/jobs/${job.id}`, { method: 'DELETE' }));
      } catch {
        setError('Could not cancel the job. Check that the local app is running.');
      }
    }
  }

  return {
    settings,
    setSettings,
    asset,
    job,
    uploading,
    connecting,
    busy,
    error,
    setError,
    importVideo,
    exportVideo,
    cancel,
    clearFinishedJob: () => {
      if (job?.status !== 'processing') setJob(null);
    },
  };
}
