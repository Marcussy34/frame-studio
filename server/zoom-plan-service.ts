// The seam between the local API and whatever actually plans a camera.
//
// Declared here rather than in desktop/ so server/app.ts does not reach into the
// Electron half of the app, matching how RecordingService is arranged.

import type { ZoomPlan } from '../shared/zoom-plan';

export interface ZoomPlanRequest {
  // The bundle directory, which holds the video, the track, the meta and the plan.
  directory: string;
  // Off means the model is given the cursor track alone and never sees the screen.
  useFrames: boolean;
  signal: AbortSignal;
  progress(fraction: number): void;
}

export interface ZoomPlanResult {
  plan: ZoomPlan;
  // Set when the model could not be used and the mechanical plan was written instead.
  // The job still succeeded, so this is something to mention rather than to fail on.
  note?: string;
}

export interface ZoomPlanService {
  plan(request: ZoomPlanRequest): Promise<ZoomPlanResult>;
}
