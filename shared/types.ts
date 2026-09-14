import type { z } from 'zod';
import type { CursorTrack } from './recording';
import type { ZoomPlan } from './zoom-plan';
import type { exportSchema, settingsSchema } from './composition';

export type Settings = z.infer<typeof settingsSchema>;
export type ExportOptions = z.infer<typeof exportSchema>;

export interface PreferencesStore {
  read(): Settings;
  write(settings: Settings): Promise<void>;
  flush(): Promise<void>;
}

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  timelineOrigin: number;
  videoOffset: number;
}

export interface MediaAsset extends VideoMetadata {
  id: string;
  name: string;
  size: number;
  previewUrl: string;
  // Present only for assets opened from a Frame Studio recording. Imported video has
  // no cursor data and never will, so consumers must handle its absence.
  cursorTrack?: CursorTrack;
  // Present only once a recording has been planned. Absent means the automatic zoom.
  zoomPlan?: ZoomPlan;
}

export interface Job {
  id: string;
  kind: 'import' | 'export' | 'plan';
  status: 'processing' | 'ready' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
  asset?: MediaAsset;
  downloadUrl?: string;
  filename?: string;
}
