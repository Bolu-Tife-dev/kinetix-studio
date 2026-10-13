import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Express } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createApiServer, ApiContext } from '../src/main/server/api';
import { ProjectStore } from '../src/main/services/projectStore';
import { SettingsService } from '../src/main/services/settings';
import { FfmpegService } from '../src/main/services/ffmpeg';
import { BeatAnalyzer } from '../src/main/services/analyzer';
import { RenderService } from '../src/main/services/renderService';
import { SequenceBuilder } from '../src/main/services/sequenceBuilder';
import { resolveAppPaths } from '../src/main/paths';

const API_KEY = 'kx_test_key_1234567890abcdef';
let app: Express;
let tmpDir: string;
let fixtureVideo: string;
let fixtureVideo2: string;
let ctx: ApiContext;

function findFfmpegOnPath(): string | null {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  if (res.status === 0) {
    const line = res.stdout.split(/\r?\n/).find((l) => l.trim());
    return line?.trim() ?? null;
  }
  return null;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetix-api-test-'));
  const paths = await resolveAppPaths(tmpDir);
  const ffmpegBin = paths.ffmpeg ?? findFfmpegOnPath();
  if (!ffmpegBin) throw new Error('No ffmpeg available for tests');

  const ffmpeg = new FfmpegService({ ffmpeg: ffmpegBin, ffprobe: paths.ffprobe });
  const settings = new SettingsService(tmpDir);
  await settings.load();
  await settings.update({ apiKey: API_KEY, apiEnabled: true });

  const store = new ProjectStore(tmpDir);
  await store.load();
  const analyzer = new BeatAnalyzer(ffmpeg, 'python', paths.pythonScript);
  const renderDir = path.join(tmpDir, 'renders');
  fs.mkdirSync(renderDir, { recursive: true });
  const render = new RenderService(ffmpeg, renderDir);
  const builder = new SequenceBuilder(store, ffmpeg);
  ctx = { store, settings, ffmpeg, analyzer, render, builder };
  app = createApiServer(ctx);

  // Synthesize two short fixture videos with a rhythmic 120 BPM click track.
  fixtureVideo = path.join(tmpDir, 'fixture-a.mp4');
  fixtureVideo2 = path.join(tmpDir, 'fixture-b.mp4');
  const makeClip = (out: string, freq: number) => {
    const res = spawnSync(
      ffmpegBin,
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=30',
        '-f', 'lavfi', '-i', `aevalsrc=0.9*sin(2*PI*${freq}*t)*(gt(mod(t\\,0.5)\\,0.42)):s=22050:d=4`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k',
        '-shortest', out,
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    if (res.status !== 0) {
      throw new Error(`fixture generation failed: ${res.stderr?.slice(-800)}`);
    }
  };
  makeClip(fixtureVideo, 1800);
  makeClip(fixtureVideo2, 2400);
}, 180_000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Kinetix local REST API', () => {
  it('GET /api/v1/health responds without auth', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.app).toBe('kinetix-studio');
  });

  it('rejects timeline access without an API key', async () => {
    const res = await request(app).get('/api/v1/timeline');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('rejects an invalid API key', async () => {
    const res = await request(app).get('/api/v1/timeline').set('X-API-Key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/timeline returns the project state', async () => {
    const res = await request(app).get('/api/v1/timeline').set('X-API-Key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveProperty('clips');
    expect(res.body.data).toHaveProperty('aspectRatio', '16:9');
    expect(res.body.data).toHaveProperty('fps', 30);
  });

  it('accepts Authorization: Bearer auth too', async () => {
    const res = await request(app).get('/api/v1/timeline').set('Authorization', `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
  });

  it('PUT /api/v1/timeline replaces the timeline', async () => {
    const res = await request(app)
      .put('/api/v1/timeline')
      .set('X-API-Key', API_KEY)
      .send({
        aspectRatio: '9:16',
        clips: [
          {
            track: 'video',
            start: 0,
            duration: 2,
            sourceIn: 0,
            src: fixtureVideo,
            name: 'agent-clip',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.aspectRatio).toBe('9:16');
    expect(res.body.data.width).toBe(1080);
    expect(res.body.data.clips).toHaveLength(1);
    // restore
    await request(app).put('/api/v1/timeline').set('X-API-Key', API_KEY).send({ aspectRatio: '16:9', clips: [] });
  });

  it('POST /api/v1/assets/import probes and registers media', async () => {
    const res = await request(app)
      .post('/api/v1/assets/import')
      .set('X-API-Key', API_KEY)
      .send({ path: fixtureVideo });
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('video');
    expect(res.body.data.durationSec).toBeGreaterThan(3.5);
    expect(res.body.data.hasAudio).toBe(true);
  });

  it('POST /api/v1/audio/extract-and-analyze returns millisecond beat timestamps', async () => {
    const res = await request(app)
      .post('/api/v1/audio/extract-and-analyze')
      .set('X-API-Key', API_KEY)
      .send({ path: fixtureVideo });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(Array.isArray(data.beatsMs)).toBe(true);
    expect(data.beatsMs.length).toBeGreaterThanOrEqual(3);
    for (const b of data.beatsMs) {
      expect(typeof b).toBe('number');
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(5000);
    }
    expect(data.tempoBpm).toBeGreaterThan(0);
    expect(data.durationSec).toBeGreaterThan(3.5);
    expect(['librosa', 'fallback-energy']).toContain(data.engine);
  }, 120_000);

  it('POST /api/v1/timeline/build-sequence arranges beat-synced cuts with transitions and overlays', async () => {
    // Grab a beat grid from analysis first.
    const analysis = await request(app)
      .post('/api/v1/audio/extract-and-analyze')
      .set('X-API-Key', API_KEY)
      .send({ path: fixtureVideo });
    const beats: number[] = analysis.body.data.beatsMs;
    expect(beats.length).toBeGreaterThanOrEqual(2);

    const res = await request(app)
      .post('/api/v1/timeline/build-sequence')
      .set('X-API-Key', API_KEY)
      .send({
        clips: [
          { path: fixtureVideo, name: 'A' },
          { path: fixtureVideo2, name: 'B' },
        ],
        beats,
        transition: 'glitch',
        grouping: 'beat',
        textEveryNBeats: 4,
        textTemplate: 'BEAT {n}',
        aspectRatio: '9:16',
      });
    expect(res.status).toBe(200);
    const project = res.body.data;
    expect(project.aspectRatio).toBe('9:16');
    const videoClips = project.clips.filter((c: { track: string }) => c.track === 'video');
    const textClips = project.clips.filter((c: { track: string }) => c.track === 'text');
    expect(videoClips.length).toBeGreaterThanOrEqual(2);
    // Every cut after the first carries the requested transition.
    for (const c of videoClips.slice(1)) {
      expect(c.transitionIn).toBe('glitch');
    }
    expect(textClips.length).toBeGreaterThanOrEqual(1);
    expect(textClips[0].text).toContain('BEAT');
    // Clips are placed on the beat grid (starts are ms-derived seconds).
    for (const c of videoClips) {
      const nearest = beats.reduce((m, b) => Math.min(m, Math.abs(b / 1000 - c.start)), Infinity);
      expect(nearest).toBeLessThan(0.001);
    }
    // Timeline state visible via GET.
    const get = await request(app).get('/api/v1/timeline').set('X-API-Key', API_KEY);
    expect(get.body.data.clips.length).toBe(project.clips.length);
  }, 120_000);

  it('POST /api/v1/render renders a full-res MP4 and reports live progress', async () => {
    // Ensure the timeline from the previous test is present; if not, rebuild quickly.
    const current = await request(app).get('/api/v1/timeline').set('X-API-Key', API_KEY);
    if (!current.body.data.clips.some((c: { track: string }) => c.track === 'video')) {
      await request(app)
        .put('/api/v1/timeline')
        .set('X-API-Key', API_KEY)
        .send({
          clips: [
            { track: 'video', start: 0, duration: 2, sourceIn: 0, src: fixtureVideo, name: 'r1' },
            { track: 'video', start: 2, duration: 2, sourceIn: 0, src: fixtureVideo2, name: 'r2', transitionIn: 'flash' },
            { track: 'text', start: 0.5, duration: 1.5, sourceIn: 0, name: 'hi', text: 'HELLO', textStyle: {
              fontFamily: 'Arial', fontSize: 48, fontWeight: 800, color: '#ffffff', align: 'center', x: 0.5, y: 0.8, background: '#7c5cff', letterSpacing: 1, uppercase: true,
            } },
          ],
        });
    }

    const res = await request(app)
      .post('/api/v1/render')
      .set('X-API-Key', API_KEY)
      .send({ forceSoftware: true, crf: 30 });
    expect(res.status).toBe(200);
    const jobId: string = res.body.data.jobId;
    expect(jobId).toBeTruthy();

    // Poll status until done.
    let final: { state: string; progress: number; outPath?: string; error?: string } | null = null;
    const deadline = Date.now() + 150_000;
    let sawRunning = false;
    while (Date.now() < deadline) {
      const st = await request(app).get(`/api/v1/render/status?jobId=${jobId}`).set('X-API-Key', API_KEY);
      expect(st.status).toBe(200);
      final = st.body.data;
      if (final!.state === 'running' && final!.progress > 0) sawRunning = true;
      if (final!.state === 'done' || final!.state === 'error') break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(final).toBeTruthy();
    expect(final!.state).toBe('done');
    expect(final!.progress).toBe(1);
    expect(final!.outPath).toBeTruthy();
    expect(fs.existsSync(final!.outPath!)).toBe(true);
    const stat = fs.statSync(final!.outPath!);
    expect(stat.size).toBeGreaterThan(1000);
    // sanity: file is an MP4 by probing it; dimensions must match the project aspect
    const probe = await ctx.ffmpeg.probe(final!.outPath!);
    expect(probe.hasVideo).toBe(true);
    const proj = ctx.store.get();
    expect(probe.width).toBe(proj.width);
    expect(probe.height).toBe(proj.height);
  }, 180_000);

  it('GET /api/v1/render/status (aggregate) reports active/queued counters', async () => {
    const res = await request(app).get('/api/v1/render/status').set('X-API-Key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('queued');
    expect(res.body.data).toHaveProperty('active');
  });

  it('404s unknown API routes as JSON', async () => {
    const res = await request(app).get('/api/v1/nope').set('X-API-Key', API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
