import type { z } from 'zod';
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
}

export interface Job {
  id: string;
  kind: 'import' | 'export';
  status: 'processing' | 'ready' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
  asset?: MediaAsset;
  downloadUrl?: string;
  filename?: string;
}
