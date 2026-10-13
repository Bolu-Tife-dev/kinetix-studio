import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { RenderProgress, ProjectState, TimelineClip, TextStyle } from '../../shared/types';
import { FfmpegService } from './ffmpeg';

export interface RenderJobRequest {
  outPath?: string;
  forceSoftware?: boolean;
  crf?: number;
}

interface JobRecord extends RenderProgress {
  args?: string[];
}

/**
 * Manages asynchronous render jobs. A single render runs at a time (queue of
 * length > 1 is serialized); progress is queryable via GET /api/v1/render/status
 * and broadcast to the renderer over IPC.
 */
export class RenderService {
  private jobs = new Map<string, JobRecord>();
  private queue: string[] = [];
  private activeJobId: string | null = null;
  private listeners = new Set<(p: RenderProgress) => void>();

  constructor(
    private ffmpeg: FfmpegService,
    private rendersDir: string
  ) {}

  onProgress(fn: (p: RenderProgress) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(job: JobRecord): void {
    this.jobs.set(job.jobId, job);
    const snapshot: RenderProgress = { ...job };
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        /* ignore */
      }
    }
  }

  getStatus(jobId?: string): RenderProgress | { active: RenderProgress | null; queued: number } {
    if (jobId) {
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`Unknown render job: ${jobId}`);
      const { args, ...rest } = job;
      return rest;
    }
    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
    const { args, ...activeRest } = active ?? ({} as JobRecord);
    return {
      active: active ? activeRest : null,
      queued: this.queue.length,
    };
  }

  /** Build ffmpeg args for a project render (exposed for diagnostics/tests). */
  buildRenderPlan(project: ProjectState, outPath: string): {
    inputs: Array<{ path: string; durationSec?: number; audioOnly?: boolean; videoOnly?: boolean }>;
    filterComplex: string;
    width: number;
    height: number;
    fps: number;
    outPath: string;
  } {
    const videoClips = project.clips
      .filter((c) => c.track === 'video' && c.src)
      .sort((a, b) => a.start - b.start);
    const audioClips = project.clips
      .filter((c) => c.track === 'audio' && c.src)
      .sort((a, b) => a.start - b.start);
    const textClips = project.clips.filter((c) => c.track === 'text');

    if (videoClips.length === 0) {
      throw new Error('Nothing to render: the timeline has no video clips.');
    }

    const inputs: Array<{ path: string; durationSec?: number; audioOnly?: boolean; videoOnly?: boolean }> = [];
    const chains: string[] = [];
    const videoLabels: string[] = [];

    videoClips.forEach((clip, i) => {
      inputs.push({ path: clip.src!, durationSec: clip.duration, videoOnly: true });
      const trim =
        clip.sourceIn > 0 || clip.sourceOut !== undefined
          ? `[${i}:v]trim=start=${clip.sourceIn}:end=${clip.sourceOut ?? ''},setpts=PTS-STARTPTS,`
          : `[${i}:v]`;
      chains.push(
        `${trim}scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
          `pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${project.fps},format=yuv420p[v${i}]`
      );
      videoLabels.push(`[v${i}]`);
    });

    // Insert transition gaps handled by simple hard cuts; flash/glitch are
    // expressed as 1-frame white/black flashes between segments.
    const segments: string[] = [];
    videoClips.forEach((clip, i) => {
      if (i > 0 && (clip.transitionIn === 'flash' || clip.transitionIn === 'glitch')) {
        chains.push(
          `color=c=${clip.transitionIn === 'flash' ? 'white' : 'black'}:s=${project.width}x${project.height}:d=0.0667:r=${project.fps},format=yuv420p[tx${i}]`
        );
        segments.push(`[tx${i}]`);
      }
      segments.push(videoLabels[i]);
    });

    if (segments.length === 1) {
      chains.push(`${segments[0]}null[vcat]`);
    } else {
      chains.push(`${segments.join('')}concat=n=${segments.length}:v=1:a=0[vcat]`);
    }

    // Audio: prefer dedicated audio-track clips; else pull audio from the
    // first video clip that has one (gapless-ish via anullsrc padding).
    if (audioClips.length > 0) {
      const audioLabels: string[] = [];
      audioClips.forEach((clip, idx) => {
        const inputIndex = inputs.length;
        inputs.push({ path: clip.src!, durationSec: clip.duration, audioOnly: true });
        const trimA =
          clip.sourceIn > 0
            ? `[${inputIndex}:a]atrim=start=${clip.sourceIn},asetpts=PTS-STARTPTS,`
            : `[${inputIndex}:a]`;
        chains.push(`${trimA}aresample=48000[a${idx}]`);
        audioLabels.push(`[a${idx}]`);
      });
      if (audioLabels.length === 1) {
        chains.push(`${audioLabels[0]}anull[aout]`);
      } else {
        chains.push(`${audioLabels.join('')}concat=n=${audioLabels.length}:v=0:a=1[aout]`);
      }
    } else {
      const firstWithAudio = videoClips.findIndex((c) => c.src);
      if (firstWithAudio >= 0) {
        chains.push(`[${firstWithAudio}:a]aresample=48000,anull[aout]`);
      }
    }

    // Text overlays via drawtext.
    const fontFile = resolveFontFile();
    if (fontFile && textClips.length > 0) {
      let current = 'vcat';
      textClips.forEach((clip, i) => {
        const text = escapeDrawText(clip.text ?? '');
        if (!text) return;
        const style: TextStyle = clip.textStyle ?? {
          fontFamily: 'Inter',
          fontSize: 64,
          fontWeight: 800,
          color: '#ffffff',
          align: 'center',
          x: 0.5,
          y: 0.5,
          background: null,
          letterSpacing: 0,
          uppercase: false,
        };
        const fontSize = Math.round((style.fontSize ?? 64) * (project.height / 1080));
        const xExpr = alignX(style.align ?? 'center', project.width, fontSize, text.length);
        const y = Math.round((style.y ?? 0.5) * project.height);
        const color = drawTextColor(style.color ?? '#ffffff');
        const enable = `between(t,${clip.start.toFixed(3)},${(clip.start + clip.duration).toFixed(3)})`;
        const bg = style.background
          ? `:box=1:boxcolor=${drawTextColor(style.background)}@0.55:boxborderw=${Math.round(fontSize / 4)}`
          : '';
        chains.push(
          `[${current}]drawtext=fontfile='${escapeFilterPath(fontFile)}':text='${text}':fontsize=${fontSize}:fontcolor=${color}` +
            `:x=${xExpr}:y=${y - fontSize}${bg}:enable='${enable}'[dt${i}]`
        );
        current = `dt${i}`;
      });
      if (current !== 'vcat') {
        chains.push(`[${current}]null[vout]`);
      } else {
        chains.push('[vcat]null[vout]');
      }
    } else {
      chains.push('[vcat]null[vout]');
    }

    const filterComplex = chains.join(';');
    return {
      inputs,
      filterComplex,
      width: project.width,
      height: project.height,
      fps: project.fps,
      outPath,
    };
  }

  /** Queue a render of the given project. Returns the job id immediately. */
  enqueueRender(project: ProjectState, req: RenderJobRequest = {}): string {
    const jobId = randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = req.outPath ?? path.join(this.rendersDir, `kinetix-${stamp}.mp4`);
    const job: JobRecord = {
      jobId,
      state: 'queued',
      progress: 0,
      startedAt: Date.now(),
      outPath,
    };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    this.emit({ ...job });
    void this.drain(project);
    return jobId;
  }

  private async drain(project: ProjectState): Promise<void> {
    if (this.activeJobId) return;
    const nextId = this.queue.shift();
    if (!nextId) return;
    const job = this.jobs.get(nextId)!;
    this.activeJobId = nextId;
    job.state = 'running';
    this.emit({ ...job });
    try {
      const plan = this.buildRenderPlan(project, job.outPath!);
      job.args = [plan.filterComplex];
      await this.ffmpeg.render(
        {
          inputs: plan.inputs,
          outPath: plan.outPath,
          width: plan.width,
          height: plan.height,
          fps: plan.fps,
          filterComplex: plan.filterComplex,
          videoLabel: 'vout',
          forceSoftware: false,
        },
        (p) => {
          job.progress = p.progress;
          job.frames = p.frames;
          job.fps = p.fps;
          job.speed = p.speed;
          this.emit({ ...job });
        }
      );
      job.state = 'done';
      job.progress = 1;
      job.finishedAt = Date.now();
    } catch (err) {
      job.state = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
    } finally {
      this.emit({ ...job });
      this.activeJobId = null;
      void this.drain(project);
    }
  }
}

function resolveFontFile(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Windows\\Fonts\\segoeui.ttf', 'C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf']
      : process.platform === 'darwin'
        ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf']
        : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'];
  const fsMod = fs;
  for (const c of candidates) {
    try {
      fsMod.accessSync(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Escape a filesystem path for use inside an ffmpeg filtergraph value. */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function drawTextColor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 'white';
  return `0x${m[1]}`;
}

function alignX(align: 'left' | 'center' | 'right', width: number, fontSize: number, len: number): string {
  const approxChar = fontSize * 0.55;
  const textW = Math.min(width, Math.round(approxChar * Math.max(1, len)));
  if (align === 'left') return String(Math.round(width * 0.08));
  if (align === 'right') return String(Math.max(0, width - textW - Math.round(width * 0.08)));
  return `(${width}-${textW})/2`;
}
