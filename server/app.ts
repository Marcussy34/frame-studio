import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import express from 'express';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { exportSchema, settingsSchema } from '../shared/composition';
import {
  bundlePaths,
  captureRegionSchema,
  isBundleId,
  parseCursorTrack,
  parseRecordingMeta,
  type RecordingService,
} from '../shared/recording';
import type { Job, MediaAsset, PreferencesStore } from '../shared/types';
import { zoomPlanSchema } from '../shared/zoom-plan';
import type { ZoomPlanService } from './zoom-plan-service';
import { deleteRecording, listRecordings } from './recordings';
import { preparePreview, probeVideo, renderVideo } from './media';

interface JobRecord {
  job: Job;
  controller: AbortController;
  task?: Promise<void>;
  output?: string;
  assetId?: string;
}
interface StoredAsset {
  asset: MediaAsset;
  source: string;
  preview: string;
}

export async function createApp({
  directory,
  preferences,
  recording,
  recordingsRoot,
  planner,
}: {
  directory: string;
  preferences?: PreferencesStore;
  // Supplied by the desktop process. Absent in the browser-only dev server, where
  // screen capture is not available at all.
  recording?: RecordingService;
  recordingsRoot?: string;
  // Plans a recording's camera. Absent when Antigravity is not installed, in which
  // case the UI never offers the button.
  planner?: ZoomPlanService;
}) {
  const app = express();
  app.disable('x-powered-by');
  const uploads = join(directory, 'uploads');
  await mkdir(uploads, { recursive: true });
  const jobs = new Map<string, JobRecord>();
  let current: StoredAsset | null = null;
  let active: JobRecord | undefined;
  let closing = false;

  // A loopback bind plus host/origin checks keeps other websites out of the local API.
  app.use('/api', (req, res, next) => {
    const host = req.get('host') ?? '';
    const origin = req.get('origin');
    if (
      !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ||
      (origin && origin !== `http://${host}`)
    ) {
      res.status(403).json({ error: 'Open Frame Studio from its local address.' });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Frame-Studio') !== '1') {
      res.status(403).json({ error: 'This request must come from Frame Studio.' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '3mb' }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploads,
      filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: 4 * 1024 ** 3, files: 1, fields: 0 },
  });
  const backgroundUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 ** 2, files: 1, fields: 0 },
  });
  app.post('/api/background', backgroundUpload.single('image'), async (req, res) => {
    const bytes = req.file?.buffer;
    const supported =
      bytes &&
      (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'));
    if (!bytes || !supported) {
      res.status(400).json({ error: 'Choose a JPG, PNG, or WebP image.' });
      return;
    }
    try {
      const image = await sharp(bytes, { limitInputPixels: 40_000_000 })
        .autoOrient()
        .resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .toColourspace('srgb')
        .jpeg({ quality: 82 })
        .toBuffer();
      const dataUrl = 'data:image/jpeg;base64,' + image.toString('base64');
      if (dataUrl.length > 2_000_000) {
        res.status(400).json({ error: 'Choose a smaller background image.' });
        return;
      }
      res.json({ dataUrl, name: basename(req.file!.originalname).slice(0, 180) });
    } catch {
      res
        .status(400)
        .json({ error: 'This image could not be opened. Try a smaller JPG, PNG, or WebP.' });
    }
  });

  const idle: RequestHandler = (_req, res, next) => {
    if (closing || active)
      res.status(409).json({ error: 'Finish or cancel the current video job first.' });
    else next();
  };

  function newJob(kind: Job['kind']): JobRecord {
    const record: JobRecord = {
      job: { id: randomUUID(), kind, status: 'processing', progress: 0 },
      controller: new AbortController(),
    };
    jobs.set(record.job.id, record);
    active = record;
    return record;
  }

  function run(record: JobRecord, work: () => Promise<void>) {
    record.task = (async () => {
      try {
        await work();
        record.job.status = 'ready';
        record.job.progress = 1;
      } catch {
        record.job.status = record.controller.signal.aborted ? 'cancelled' : 'failed';
        if (record.job.status === 'failed') {
          record.job.error =
            record.job.kind === 'import'
              ? 'We could not read this video. Try a MOV or MP4 exported from QuickTime.'
              : 'The export could not finish. Check free disk space, or try a lower resolution.';
        }
      } finally {
        if (active === record) active = undefined;
        // Retain a bounded download history for the current local session.
        const completed = [...jobs.values()].filter((item) => item.job.status !== 'processing');
        for (const old of completed.slice(0, -12)) {
          jobs.delete(old.job.id);
          if (old.output) await rm(old.output, { force: true }).catch(() => {});
        }
      }
    })();
  }

  app.get('/api/session', (_req, res) => {
    // Recover the latest finished download as well as an in-progress export after reload.
    const latestExport = [...jobs.values()]
      .reverse()
      .find(
        (record) =>
          record.assetId === current?.asset.id &&
          record.job.kind === 'export' &&
          record.job.status === 'ready',
      );
    res.json({
      asset: current?.asset ?? null,
      job: active?.job ?? latestExport?.job ?? null,
      preferences: preferences?.read(),
    });
  });

  app.put('/api/preferences', async (req, res) => {
    if (closing) {
      res.status(409).json({ error: 'Frame Studio is closing.' });
      return;
    }
    if (!preferences) {
      res.status(404).json({ error: 'Desktop preferences are unavailable.' });
      return;
    }
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Choose valid canvas settings.' });
      return;
    }
    try {
      await preferences.write(parsed.data);
      res.json({ settings: preferences.read() });
    } catch {
      res
        .status(500)
        .json({ error: 'Canvas preferences could not be saved. Check free disk space.' });
    }
  });

  app.post('/api/import', idle, upload.single('video'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Choose a video to import.' });
      return;
    }
    // Recheck after streaming because another upload may have completed first.
    if (active || closing) {
      await rm(req.file.path, { force: true });
      res.status(409).json({ error: 'Finish or cancel the current video job first.' });
      return;
    }
    const file = req.file;
    const record = newJob('import');
    const id = randomUUID();
    const preview = join(directory, `${id}-preview.mp4`);
    run(record, async () => {
      let committed = false;
      try {
        const meta = await probeVideo(file.path, record.controller.signal);
        await preparePreview(file.path, preview, meta, record.controller.signal, (value) => {
          record.job.progress = value;
        });
        record.controller.signal.throwIfAborted();
        const asset: MediaAsset = {
          ...meta,
          id,
          name: basename(file.originalname),
          size: file.size,
          previewUrl: `/api/media/${id}`,
        };
        const previous = current;
        current = { asset, source: file.path, preview };
        record.job.asset = asset;
        committed = true;
        if (previous)
          await Promise.all(
            [previous.source, previous.preview].map((path) =>
              rm(path, { force: true }).catch(() => {}),
            ),
          );
      } finally {
        if (!committed)
          await Promise.all(
            [file.path, preview].map((path) => rm(path, { force: true }).catch(() => {})),
          );
      }
    });
    res.status(202).json(record.job);
  });

  // Opens a recording bundle produced by the capture helper. The bundle's video is
  // copied into the session so clearing the session never touches a saved recording.
  app.post('/api/recordings/:id/open', idle, async (req, res) => {
    if (!recordingsRoot) {
      res.status(503).json({ error: 'Recordings are only available in the desktop app.' });
      return;
    }
    // Express 5 types route params as string | string[], so narrow it explicitly.
    const bundleId = String(req.params.id);
    if (!isBundleId(bundleId)) {
      res.status(400).json({ error: 'That recording could not be opened.' });
      return;
    }
    const paths = bundlePaths(join(recordingsRoot, bundleId));
    let meta;
    let events;
    let bytes;
    try {
      meta = parseRecordingMeta(JSON.parse(await readFile(paths.meta, 'utf8')));
      events = parseCursorTrack(await readFile(paths.track, 'utf8'));
      bytes = (await stat(paths.video)).size;
    } catch {
      res.status(404).json({ error: 'That recording could not be opened.' });
      return;
    }
    // Optional, and a damaged one must never cost someone their recording, so a plan
    // that will not parse is simply treated as absent.
    let zoomPlan;
    try {
      zoomPlan = zoomPlanSchema.parse(JSON.parse(await readFile(paths.plan, 'utf8')));
    } catch {
      zoomPlan = undefined;
    }
    if (active || closing) {
      res.status(409).json({ error: 'Finish or cancel the current video job first.' });
      return;
    }
    const record = newJob('import');
    const assetId = randomUUID();
    const source = join(directory, `${assetId}-source.mov`);
    const preview = join(directory, `${assetId}-preview.mp4`);
    run(record, async () => {
      let committed = false;
      try {
        await copyFile(paths.video, source);
        const probe = await probeVideo(source, record.controller.signal);
        await preparePreview(source, preview, probe, record.controller.signal, (value) => {
          record.job.progress = value;
        });
        record.controller.signal.throwIfAborted();
        const asset: MediaAsset = {
          ...probe,
          id: assetId,
          name: bundleId,
          size: bytes,
          previewUrl: `/api/media/${assetId}`,
          cursorTrack: { meta, events },
          zoomPlan,
        };
        const previous = current;
        current = { asset, source, preview };
        record.job.asset = asset;
        committed = true;
        if (previous)
          await Promise.all(
            [previous.source, previous.preview].map((path) =>
              rm(path, { force: true }).catch(() => {}),
            ),
          );
      } finally {
        if (!committed)
          await Promise.all(
            [source, preview].map((path) => rm(path, { force: true }).catch(() => {})),
          );
      }
    });
    res.status(202).json(record.job);
  });

  app.get('/api/jobs/:id', (req, res) => {
    const record = jobs.get(req.params.id);
    if (record) res.json(record.job);
    else res.status(404).json({ error: 'This video job is no longer available.' });
  });

  app.delete('/api/jobs/:id', async (req, res) => {
    const record = jobs.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'This video job is no longer available.' });
      return;
    }
    if (record.job.status === 'processing') record.controller.abort();
    await record.task;
    res.json(record.job);
  });

  app.post('/api/export', idle, (req, res) => {
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Choose valid canvas settings and an export resolution.' });
      return;
    }
    const source = current;
    if (!source || req.body.assetId !== source.asset.id) {
      res.status(404).json({ error: 'Import a video before exporting.' });
      return;
    }
    const record = newJob('export');
    record.assetId = source.asset.id;
    record.output = join(directory, `${record.job.id}.mp4`);
    const stem =
      basename(source.asset.name, extname(source.asset.name))
        .replace(/[\x00-\x1f\x7f/\\]/g, '')
        .slice(0, 120) || 'video';
    run(record, async () => {
      await renderVideo(
        source.source,
        record.output!,
        source.asset,
        parsed.data,
        record.controller.signal,
        (value) => {
          record.job.progress = value;
        },
        // Only recordings carry a cursor track; imported video renders as before.
        source.asset.cursorTrack,
        source.asset.zoomPlan,
      );
      record.job.downloadUrl = `/api/download/${record.job.id}`;
      record.job.filename = `${stem}-framed.mp4`;
    });
    res.status(202).json(record.job);
  });

  app.get('/api/media/:id', (req, res) => {
    if (current?.asset.id !== req.params.id)
      res.status(404).json({ error: 'Import this video again to preview it.' });
    else res.sendFile(current.preview);
  });

  app.get('/api/download/:id', (req, res) => {
    const record = jobs.get(req.params.id);
    if (!record?.output || record.job.status !== 'ready')
      res.status(404).json({ error: 'Export a video before downloading.' });
    else res.download(record.output, record.job.filename ?? 'framed-video.mp4');
  });

  // Recording is desktop only. Without an injected service every route reports that
  // plainly rather than failing in some other way.
  const requireRecording = (res: Response): RecordingService | null => {
    if (recording) return recording;
    res.status(503).json({ error: 'Screen recording is only available in the desktop app.' });
    return null;
  };

  app.get('/api/displays', async (_req, res) => {
    const service = requireRecording(res);
    if (!service) return;
    try {
      res.json({ displays: await service.listDisplays() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/recording/permissions', async (_req, res) => {
    const service = requireRecording(res);
    if (!service) return;
    try {
      res.json(await service.permissions());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Separate from the read-only check above because this one deliberately puts a
  // system dialog on screen, which must never happen just from opening a dialog.
  app.post('/api/recording/access', async (_req, res) => {
    const service = requireRecording(res);
    if (!service) return;
    try {
      res.json(await service.requestCursorAccess());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/windows', async (_req, res) => {
    const service = requireRecording(res);
    if (!service) return;
    try {
      res.json({ windows: await service.listWindows() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Opens the drag-to-select overlay. Returns null when the user cancels.
  app.post('/api/recording/region', async (_req, res) => {
    const service = requireRecording(res);
    if (!service) return;
    try {
      res.json({ region: await service.selectRegion() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post('/api/recording/start', async (req, res) => {
    const service = requireRecording(res);
    if (!service) return;
    const body = req.body as
      { displayID?: unknown; windowID?: unknown; region?: unknown } | undefined;
    const displayID = Number(body?.displayID);
    const windowID = Number(body?.windowID);
    const parsedRegion = captureRegionSchema.safeParse(body?.region);
    // Exactly one target, so an ambiguous request is rejected rather than guessed at.
    // A region narrows the display it was drawn on.
    const target = parsedRegion.success
      ? { displayID: parsedRegion.data.displayID, region: parsedRegion.data }
      : Number.isFinite(windowID)
        ? { windowID }
        : Number.isFinite(displayID)
          ? { displayID }
          : null;
    if (!target) {
      res.status(400).json({ error: 'Choose a display or a window before recording.' });
      return;
    }
    try {
      res.json(await service.start(target));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post('/api/recording/stop', async (_req, res) => {
    const service = requireRecording(res);
    if (!service) return;
    try {
      res.json({ outcome: await service.stop() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // The hotkey and the floating stop button finish a recording without the renderer
  // asking, so the renderer polls this to notice.
  app.get('/api/recording/status', (_req, res) => {
    const service = requireRecording(res);
    if (!service) return;
    res.json(service.status());
  });

  // Lets the UI hide the planning controls entirely rather than offering a button that
  // can only ever fail on a machine without the Antigravity CLI.
  app.get('/api/zoom-plan/available', (_req, res) => {
    res.json({ available: !!planner && !!recordingsRoot });
  });

  // Planning is slow enough to need a job, so it follows the export pattern: start it,
  // then poll /api/jobs/:id. The result is written into the bundle rather than returned,
  // because a plan outlives the request that made it.
  app.post('/api/recordings/:id/zoom-plan', idle, async (req, res) => {
    if (!recordingsRoot || !planner) {
      res.status(404).json({ error: 'Planning is not available in this build.' });
      return;
    }
    const bundleId = String(req.params.id);
    if (!isBundleId(bundleId)) {
      res.status(400).json({ error: 'That recording could not be planned.' });
      return;
    }
    const useFrames = (req.body as { useFrames?: unknown } | undefined)?.useFrames !== false;
    const record = newJob('plan');
    run(record, async () => {
      const outcome = await planner.plan({
        directory: join(recordingsRoot, bundleId),
        useFrames,
        signal: record.controller.signal,
        progress: (value: number) => {
          record.job.progress = value;
        },
      });
      // A note means the model could not be used and the mechanical plan was kept. The
      // job still succeeded, because a usable plan was still produced.
      if (outcome.note) record.job.error = outcome.note;
    });
    res.status(202).json(record.job);
  });

  app.get('/api/recordings/:id/zoom-plan', async (req, res) => {
    if (!recordingsRoot) {
      res.status(404).json({ error: 'Recording is not available in this build.' });
      return;
    }
    const bundleId = String(req.params.id);
    if (!isBundleId(bundleId)) {
      res.status(400).json({ error: 'That recording could not be read.' });
      return;
    }
    try {
      const raw = await readFile(bundlePaths(join(recordingsRoot, bundleId)).plan, 'utf8');
      res.json(zoomPlanSchema.parse(JSON.parse(raw)));
    } catch {
      res.status(404).json({ error: 'That recording has no plan.' });
    }
  });

  app.delete('/api/recordings/:id/zoom-plan', async (req, res) => {
    if (!recordingsRoot) {
      res.status(404).json({ error: 'Recording is not available in this build.' });
      return;
    }
    const bundleId = String(req.params.id);
    if (!isBundleId(bundleId)) {
      res.status(400).json({ error: 'That recording could not be read.' });
      return;
    }
    // Removing a plan reverts to the automatic zoom. The raw track is untouched, so
    // nothing is actually lost.
    await rm(bundlePaths(join(recordingsRoot, bundleId)).plan, { force: true });
    res.json({ removed: true });
  });

  app.get('/api/recordings', async (_req, res) => {
    if (!recordingsRoot) {
      res.json({ recordings: [] });
      return;
    }
    res.json({ recordings: await listRecordings(recordingsRoot) });
  });

  app.delete('/api/recordings/:id', async (req, res) => {
    if (!recordingsRoot) {
      res.status(503).json({ error: 'Recordings are only available in the desktop app.' });
      return;
    }
    try {
      await deleteRecording(recordingsRoot, String(req.params.id));
      res.status(204).end();
    } catch {
      res.status(400).json({ error: 'That recording could not be deleted.' });
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'This action is not available.' }));
  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? req.path === '/api/background'
          ? 'Choose an image smaller than 20 MB.'
          : 'Choose a video smaller than 4 GB.'
        : 'The file could not be imported. Choose one video and try again.',
    });
  };
  app.use(errors);

  return {
    app,
    async close() {
      closing = true;
      for (const record of jobs.values()) record.controller.abort();
      await Promise.allSettled([...jobs.values()].map((record) => record.task));
    },
  };
}
