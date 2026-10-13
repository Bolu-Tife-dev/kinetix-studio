import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import ffmpegFluent from 'fluent-ffmpeg';
import { RenderProgress } from '../../shared/types';

export interface FfmpegBinaries {
  ffmpeg: string | null;
  ffprobe: string | null;
}

export interface ProbeResult {
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  codecName?: string;
  raw?: unknown;
}

export interface RenderOptions {
  inputs: Array<{ path: string; startSec?: number; durationSec?: number; audioOnly?: boolean; videoOnly?: boolean }>;
  outPath: string;
  width: number;
  height: number;
  fps: number;
  /** Optional filter_complex graph replacing the default scale/pad. */
  filterComplex?: string;
  /** Final video output label when using custom filterComplex (default "vout"). */
  videoLabel?: string;
  audioLabel?: string;
  /** Force software encoder even if a hardware one is available. */
  forceSoftware?: boolean;
  crf?: number;
  extraInputArgs?: string[];
  extraOutputArgs?: string[];
}

export class FfmpegService {
  private bins: FfmpegBinaries;
  private hwEncoderCache: string | null | undefined;

  constructor(bins: FfmpegBinaries) {
    this.bins = bins;
  }

  setBinaries(bins: FfmpegBinaries): void {
    this.bins = bins;
  }

  get binaries(): FfmpegBinaries {
    return this.bins;
  }

  requireFfmpeg(): string {
    if (!this.bins.ffmpeg) {
      throw new Error('FFmpeg binary not found. Install FFmpeg or re-install Kinetix Studio (binaries are bundled).');
    }
    return this.bins.ffmpeg;
  }

  /** Run ffmpeg and resolve when finished. */
  run(args: string[], opts: { onStderrLine?: (line: string) => void; timeoutMs?: number } = {}): Promise<{ code: number; stderrTail: string }> {
    const bin = this.requireFfmpeg();
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true });
      let stderrTail = '';
      let timer: NodeJS.Timeout | undefined;
      const stderrBuf: string[] = [];

      const kill = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      };

      if (opts.timeoutMs) {
        timer = setTimeout(kill, opts.timeoutMs);
      }

      child.stderr.setEncoding('utf8');
      let carry = '';
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4096);
        carry += chunk;
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() ?? '';
        for (const line of lines) {
          stderrBuf.push(line);
          opts.onStderrLine?.(line);
        }
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (stderrBuf.length > 40) stderrBuf.splice(0, stderrBuf.length - 40);
        resolve({ code: code ?? -1, stderrTail });
      });
    });
  }

  /** Probe a media file. Prefers fluent-ffmpeg; falls back to raw ffprobe spawn. */
  async probe(filePath: string): Promise<ProbeResult> {
    if (this.bins.ffprobe) {
      try {
        return await this.fluentProbe(filePath);
      } catch {
        /* fall through to raw spawn */
      }
    } else {
      return this.ffmpegProbeFallback(filePath);
    }
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(this.bins.ffprobe!, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    if (result.code !== 0) {
      throw new Error(`ffprobe failed for ${filePath}: ${result.stderr.slice(-500)}`);
    }
    const json = JSON.parse(result.stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        duration?: string;
        avg_frame_rate?: string;
        r_frame_rate?: string;
      }>;
    };
    const streams = json.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const durationSec =
      Number(json.format?.duration ?? NaN) ||
      Number(video?.duration ?? NaN) ||
      Number(audio?.duration ?? NaN) ||
      0;
    return {
      durationSec,
      width: video?.width,
      height: video?.height,
      fps: parseFps(video?.avg_frame_rate ?? video?.r_frame_rate),
      hasAudio: Boolean(audio),
      hasVideo: Boolean(video),
      codecName: video?.codec_name,
      raw: json,
    };
  }

  /** fluent-ffmpeg based probe (requires a resolvable ffprobe binary). */
  private fluentProbe(filePath: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      ffmpegFluent.setFfprobePath(this.bins.ffprobe!);
      ffmpegFluent(filePath).ffprobe((err, data) => {
        if (err) return reject(err);
        const streams = data.streams ?? [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');
        const durationSec =
          Number(data.format?.duration ?? NaN) || Number(video?.duration ?? NaN) || 0;
        resolve({
          durationSec,
          width: video?.width,
          height: video?.height,
          fps: parseFps(video?.avg_frame_rate ?? video?.r_frame_rate),
          hasAudio: Boolean(audio),
          hasVideo: Boolean(video),
          codecName: video?.codec_name,
          raw: data,
        });
      });
    });
  }

  /** Last-resort probe using `ffmpeg -i` banner parsing when ffprobe is absent. */
  private async ffmpegProbeFallback(filePath: string): Promise<ProbeResult> {
    const bin = this.requireFfmpeg();
    const res = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn(bin, ['-hide_banner', '-i', filePath], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    });
    const durMatch = res.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    const durationSec = durMatch
      ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
      : 0;
    const resMatch = res.stderr.match(/(\d{2,5})x(\d{2,5})/);
    const hasAudio = /Audio:/.test(res.stderr);
    const hasVideo = /Video:/.test(res.stderr);
    return {
      durationSec,
      width: resMatch ? Number(resMatch[1]) : undefined,
      height: resMatch ? Number(resMatch[2]) : undefined,
      hasAudio,
      hasVideo,
    };
  }

  /**
   * Extract the audio track of a media file to a 16-bit PCM WAV at 22050 Hz mono,
   * which is the canonical input for the beat-analysis sidecar.
   */
  async extractAudioWav(inputPath: string, outPath?: string): Promise<string> {
    const target = outPath ?? path.join(os.tmpdir(), `kinetix-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '22050',
      '-c:a', 'pcm_s16le',
      target,
    ];
    const { code, stderrTail } = await this.run(args, { timeoutMs: 10 * 60 * 1000 });
    if (code !== 0 || !fs.existsSync(target)) {
      throw new Error(`Audio extraction failed: ${stderrTail.slice(-600)}`);
    }
    return target;
  }

  /** Detect best available hardware H.264 encoder for this host. */
  async detectHwEncoder(): Promise<string | null> {
    if (this.hwEncoderCache !== undefined) return this.hwEncoderCache;
    let detected: string | null = null;
    try {
      const bin = this.requireFfmpeg();
      const res = await new Promise<string>((resolve, reject) => {
        const child = spawn(bin, ['-hide_banner', '-encoders'], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (out += d.toString()));
        child.on('error', reject);
        child.on('close', () => resolve(out));
      });
      const candidates: Array<[string, NodeJS.Platform[]]> = [
        ['h264_nvenc', ['win32', 'linux']],
        ['h264_qsv', ['win32', 'linux']],
        ['h264_amf', ['win32']],
        ['h264_videotoolbox', ['darwin']],
        ['h264_vaapi', ['linux']],
      ];
      for (const [enc, platforms] of candidates) {
        if (platforms.includes(process.platform) && new RegExp(`\\b${enc}\\b`).test(res)) {
          detected = enc;
          break;
        }
      }
    } catch {
      detected = null;
    }
    this.hwEncoderCache = detected;
    return detected;
  }

  /**
   * Render the final full-resolution MP4. Progress is emitted through the
   * callback and parsed from `ffmpeg -progress pipe:1`. If a hardware encoder
   * fails to initialize, the render automatically retries with libx264.
   */
  async render(opts: RenderOptions, onProgress?: (p: RenderProgress) => void): Promise<{ outPath: string }> {
    const hw = opts.forceSoftware ? null : await this.detectHwEncoder();
    try {
      return await this.renderInternal(opts, hw, onProgress);
    } catch (err) {
      if (hw && !opts.forceSoftware && /encoder|nvenc|qsv|amf|videotoolbox|vaapi|Operation not permitted/i.test(String(err))) {
        // Distrust the detected encoder — fall back to software x264.
        this.hwEncoderCache = null;
        return this.renderInternal(opts, null, onProgress);
      }
      throw err;
    }
  }

  private async renderInternal(
    opts: RenderOptions,
    hw: string | null,
    onProgress?: (p: RenderProgress) => void
  ): Promise<{ outPath: string }> {
    const outDir = path.dirname(opts.outPath);
    await fsp.mkdir(outDir, { recursive: true });

    const args: string[] = ['-hide_banner', '-y'];
    for (const input of opts.inputs) {
      args.push(...(opts.extraInputArgs ?? []));
      args.push('-i', input.path);
    }

    let filter = opts.filterComplex;
    if (!filter) {
      const chains: string[] = [];
      const labels: string[] = [];
      opts.inputs.forEach((input, i) => {
        if (input.audioOnly) return;
        // Smart auto-centering crop matrix: fit the source into the target
        // aspect box, letter/pillar-boxing as needed, then normalize SAR.
        chains.push(
          `[${i}:v]scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
            `pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${opts.fps},format=yuv420p[v${i}]`
        );
        labels.push(`[v${i}]`);
      });
      if (labels.length === 0) {
        throw new Error('Render aborted: no video inputs supplied');
      }
      if (labels.length > 1) {
        chains.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[vout]`);
      } else {
        chains.push(`${labels[0]}null[vout]`);
      }
      // Mix audio from inputs that carry audio.
      const audioIdx = opts.inputs.map((inp, i) => (inp.videoOnly ? -1 : i)).filter((i) => i >= 0);
      if (audioIdx.length > 0) {
        if (audioIdx.length === 1) {
          chains.push(`[${audioIdx[0]}:a]anull[aout]`);
        } else {
          chains.push(
            `${audioIdx.map((i) => `[${i}:a]`).join('')}concat=n=${audioIdx.length}:v=0:a=1[aout]`
          );
        }
      }
      filter = chains.join(';');
    }

    args.push('-filter_complex', filter);
    args.push('-map', `[${opts.videoLabel ?? 'vout'}]`);
    if (/\[aout\]/.test(filter)) {
      args.push('-map', `[${opts.audioLabel ?? 'aout'}]`);
    } else {
      args.push('-an');
    }

    const crf = String(opts.crf ?? 17);
    if (hw === 'h264_nvenc') {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', crf, '-b:v', '0');
    } else if (hw === 'h264_qsv') {
      args.push('-c:v', 'h264_qsv', '-global_quality', crf);
    } else if (hw === 'h264_amf') {
      args.push('-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', crf, '-qp_p', crf);
    } else if (hw === 'h264_videotoolbox') {
      args.push('-c:v', 'h264_videotoolbox', '-b:v', '12M');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf);
    }
    if (/\[aout\]/.test(filter)) {
      args.push('-c:a', 'aac', '-b:a', '192k');
    }
    args.push(...(opts.extraOutputArgs ?? []));
    args.push('-progress', 'pipe:1', '-nostats', opts.outPath);

    const totalDuration = opts.inputs.reduce((acc, i) => acc + (i.durationSec ?? 0), 0) || undefined;

    await new Promise<void>((resolve, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(this.requireFfmpeg(), args, { windowsHide: true });
      let stdoutCarry = '';
      let stderrTail = '';
      let lastState: RenderProgress = {
        jobId: '',
        state: 'running',
        progress: 0,
        startedAt: Date.now(),
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutCarry += chunk;
        const lines = stdoutCarry.split(/\r?\n/);
        stdoutCarry = lines.pop() ?? '';
        for (const line of lines) {
          const [key, value] = line.split('=');
          if (!key || value === undefined) continue;
          if (key === 'out_time_ms' && totalDuration && totalDuration > 0) {
            const outSec = Number(value) / 1_000_000;
            lastState.progress = Math.min(0.999, Math.max(0, outSec / totalDuration));
            onProgress?.({ ...lastState });
          } else if (key === 'frame') {
            lastState.frames = Number(value);
          } else if (key === 'fps') {
            lastState.fps = Number(value);
          } else if (key === 'speed') {
            lastState.speed = value.trim();
          } else if (key === 'progress' && value.trim() === 'end') {
            lastState.progress = 1;
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-8192);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          lastState.progress = 1;
          onProgress?.({ ...lastState });
          resolve();
        } else {
          const errLines = stderrTail
            .split(/\r?\n/)
            .filter((l) => /error|invalid|no such|failed|unable|not found|matches no/i.test(l))
            .slice(-6)
            .join(' | ');
          reject(
            new Error(
              `ffmpeg render exited with code ${code}: ${errLines || stderrTail.slice(-800)}`
            )
          );
        }
      });
    });

    return { outPath: opts.outPath };
  }
}

function parseFps(rate?: string): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return undefined;
  return num / den;
}

/** Convenience for tests / CLI: run a one-shot ffmpeg command. */
export function runFfmpegSync(bin: string, args: string[]): { code: number; stderr: string } {
  const res = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  return { code: res.status ?? -1, stderr: res.stderr ?? '' };
}
