import express, { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { ProjectStore } from '../services/projectStore';
import { SettingsService } from '../services/settings';
import { FfmpegService } from '../services/ffmpeg';
import { BeatAnalyzer } from '../services/analyzer';
import { RenderService } from '../services/renderService';
import { SequenceBuilder } from '../services/sequenceBuilder';
import { BuildSequenceRequest } from '../../shared/types';

export interface ApiContext {
  store: ProjectStore;
  settings: SettingsService;
  ffmpeg: FfmpegService;
  analyzer: BeatAnalyzer;
  render: RenderService;
  builder: SequenceBuilder;
  /** Optional static dir of the built renderer to serve in production. */
  rendererDist?: string | null;
}

export function createApiServer(ctx: ApiContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '50mb' }));

  // ---- auth -------------------------------------------------------------
  function extractKey(req: Request): string | null {
    const header = req.header('x-api-key') ?? req.header('X-API-Key');
    if (header) return header.trim();
    const auth = req.header('authorization');
    if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    if (typeof req.query.api_key === 'string') return req.query.api_key;
    return null;
  }

  function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    if (!ctx.settings.get().apiEnabled) {
      res.status(403).json({ ok: false, error: 'API access is disabled in Kinetix settings.' });
      return;
    }
    const key = extractKey(req);
    if (!ctx.settings.verifyKey(key)) {
      res.status(401).json({
        ok: false,
        error: 'Missing or invalid API key. Pass it via the X-API-Key header or Authorization: Bearer <key>.',
      });
      return;
    }
    next();
  }

  const v1 = express.Router();

  v1.get('/health', (_req, res) => {
    res.json({ ok: true, data: { status: 'up', app: 'kinetix-studio', version: '1.0.0' } });
  });

  // ---- GET /api/v1/timeline --------------------------------------------
  v1.get('/timeline', requireApiKey, (_req, res) => {
    res.json({ ok: true, data: ctx.store.get() });
  });

  // ---- PUT /api/v1/timeline (full replace, handy for agents) ------------
  const timelinePutSchema = z.object({
    name: z.string().optional(),
    aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:5']).optional(),
    fps: z.number().int().min(1).max(120).optional(),
    clips: z
      .array(
        z.object({
          id: z.string().optional(),
          track: z.enum(['video', 'audio', 'text']),
          start: z.number().min(0),
          duration: z.number().gt(0),
          sourceIn: z.number().min(0).default(0),
          sourceOut: z.number().optional(),
          assetId: z.string().optional(),
          src: z.string().optional(),
          name: z.string().default('clip'),
          transitionIn: z.enum(['cut', 'flash', 'glitch', 'fade', 'zoom-punch']).optional(),
          opacity: z.number().min(0).max(1).optional(),
          scale: z.number().optional(),
          text: z.string().optional(),
          textStyle: z.any().optional(),
          beatIndex: z.number().optional(),
        })
      )
      .optional(),
    assets: z
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string(),
          path: z.string(),
          kind: z.enum(['video', 'audio', 'image']),
          durationSec: z.number().default(0),
          width: z.number().optional(),
          height: z.number().optional(),
          fps: z.number().optional(),
          hasAudio: z.boolean().optional(),
        })
      )
      .optional(),
  });

  v1.put('/timeline', requireApiKey, (req, res) => {
    const parsed = timelinePutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    if (body.name) ctx.store.setName(body.name);
    if (body.aspectRatio) ctx.store.setAspectRatio(body.aspectRatio);
    if (body.clips) {
      ctx.store.replaceTimeline(
        body.clips.map((c) => ({
          ...c,
          sourceIn: c.sourceIn ?? 0,
          name: c.name ?? 'clip',
        }))
      );
    }
    res.json({ ok: true, data: ctx.store.get() });
  });

  // ---- POST /api/v1/timeline/build-sequence -----------------------------
  const buildSchema = z.object({
    clips: z
      .array(
        z.object({
          path: z.string().optional(),
          assetId: z.string().optional(),
          name: z.string().optional(),
          inSec: z.number().min(0).optional(),
          outSec: z.number().min(0).optional(),
        })
      )
      .min(1),
    beats: z.array(z.number().min(0)).min(1),
    tempoBpm: z.number().positive().optional(),
    aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:5']).optional(),
    transition: z.enum(['cut', 'flash', 'glitch', 'fade', 'zoom-punch']).optional(),
    textEveryNBeats: z.number().int().min(0).optional(),
    textTemplate: z.string().optional(),
    grouping: z.enum(['beat', 'bar', 'half-bar']).optional(),
    replaceTimeline: z.boolean().optional(),
  });

  v1.post('/timeline/build-sequence', requireApiKey, async (req, res) => {
    const parsed = buildSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }
    try {
      const project = await ctx.builder.build(parsed.data as BuildSequenceRequest);
      res.json({ ok: true, data: project });
    } catch (err) {
      res.status(422).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- POST /api/v1/audio/extract-and-analyze ---------------------------
  const analyzeSchema = z.object({
    path: z.string().min(1).optional(),
    assetId: z.string().optional(),
    /** Inline base64 WAV (data URI or raw base64) for remote agents. */
    wavBase64: z.string().optional(),
  });

  v1.post('/audio/extract-and-analyze', requireApiKey, async (req, res) => {
    const parsed = analyzeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }
    const { path: inPath, assetId, wavBase64 } = parsed.data;
    let mediaPath = inPath;
    if (!mediaPath && assetId) {
      mediaPath = ctx.store.get().assets.find((a) => a.id === assetId)?.path;
      if (!mediaPath) {
        res.status(404).json({ ok: false, error: `No asset found for id ${assetId}` });
        return;
      }
    }
    try {
      let analysis;
      let wavPath: string | undefined;
      if (wavBase64) {
        const base64 = wavBase64.replace(/^data:audio\/wav;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        wavPath = path.join(os.tmpdir(), `kinetix-upload-${Date.now()}.wav`);
        fs.writeFileSync(wavPath, buf);
        analysis = await ctx.analyzer.analyzeWav(wavPath);
      } else {
        if (!mediaPath) {
          res.status(400).json({ ok: false, error: 'Provide "path", "assetId", or "wavBase64".' });
          return;
        }
        if (!fs.existsSync(mediaPath)) {
          res.status(404).json({ ok: false, error: `File not found: ${mediaPath}` });
          return;
        }
        const result = await ctx.analyzer.extractAndAnalyze(mediaPath);
        analysis = result;
        wavPath = result.wavPath;
      }
      res.json({
        ok: true,
        data: {
          ...analysis,
          wavPath,
        },
      });
    } catch (err) {
      res.status(422).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- POST /api/v1/render ---------------------------------------------
  const renderSchema = z.object({
    outPath: z.string().optional(),
    forceSoftware: z.boolean().optional(),
    crf: z.number().int().min(0).max(51).optional(),
  });

  v1.post('/render', requireApiKey, (req, res) => {
    const parsed = renderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }
    try {
      const project = ctx.store.get();
      if (!project.clips.some((c) => c.track === 'video' && c.src)) {
        res.status(422).json({ ok: false, error: 'Timeline has no video clips to render.' });
        return;
      }
      const jobId = ctx.render.enqueueRender(project, parsed.data);
      res.json({ ok: true, data: { jobId, statusUrl: `/api/v1/render/status?jobId=${jobId}` } });
    } catch (err) {
      res.status(422).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- GET /api/v1/render/status ---------------------------------------
  v1.get('/render/status', requireApiKey, (req, res) => {
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    try {
      const status = ctx.render.getStatus(jobId);
      res.json({ ok: true, data: status });
    } catch (err) {
      res.status(404).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- POST /api/v1/assets/import --------------------------------------
  const importSchema = z.object({ path: z.string().min(1) });
  v1.post('/assets/import', requireApiKey, async (req, res) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }
    const p = parsed.data.path;
    if (!fs.existsSync(p)) {
      res.status(404).json({ ok: false, error: `File not found: ${p}` });
      return;
    }
    try {
      const probe = await ctx.ffmpeg.probe(p);
      const asset = ctx.store.addAsset({
        name: path.basename(p),
        path: p,
        kind: probe.hasAudio && !probe.hasVideo ? 'audio' : probe.hasVideo ? 'video' : 'image',
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        hasAudio: probe.hasAudio,
      });
      res.json({ ok: true, data: asset });
    } catch (err) {
      res.status(422).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.use('/api/v1', v1);

  // Serve the built renderer so the app (and any browser on loopback) can
  // load the editor from the same origin as the API in production.
  if (ctx.rendererDist && fs.existsSync(ctx.rendererDist)) {
    app.use(express.static(ctx.rendererDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(ctx.rendererDist!, 'index.html'));
    });
  }

  // JSON 404 for unknown API routes (before static catch-all interferes).
  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, error: 'Unknown API route' });
  });

  return app;
}
