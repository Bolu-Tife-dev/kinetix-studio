import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BeatAnalysis } from '../../shared/types';
import { FfmpegService } from './ffmpeg';

/**
 * Audio beat / transient analysis.
 *
 * Primary engine: Python sidecar (librosa) shipped in extraResources.
 * Fallback engine: pure-Node energy-onset detector so the app (and CI tests)
 * work on machines without a Python environment.
 */
export class BeatAnalyzer {
  constructor(
    private ffmpeg: FfmpegService,
    private pythonBin: string,
    private pythonScript: string | null
  ) {}

  setPython(bin: string, script: string | null): void {
    this.pythonBin = bin;
    this.pythonScript = script;
  }

  /** Extract audio from any media file and run beat detection. */
  async extractAndAnalyze(mediaPath: string): Promise<BeatAnalysis & { wavPath: string }> {
    const wavPath = path.join(
      path.dirname(mediaPath) || process.cwd(),
      `.kinetix-audio-${Date.now()}.wav`
    );
    await this.ffmpeg.extractAudioWav(mediaPath, wavPath);
    try {
      const analysis = await this.analyzeWav(wavPath);
      return { ...analysis, wavPath };
    } catch (err) {
      await fsp.rm(wavPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Run beat detection on an existing WAV file. */
  async analyzeWav(wavPath: string): Promise<BeatAnalysis> {
    const py = await this.runPythonSidecar(wavPath);
    if (py) return py;
    return this.fallbackAnalyze(wavPath);
  }

  private async runPythonSidecar(wavPath: string): Promise<BeatAnalysis | null> {
    if (!this.pythonBin || !this.pythonScript) return null;
    return new Promise((resolve) => {
      const child = spawn(this.pythonBin, [this.pythonScript!, wavPath], {
        windowsHide: true,
        timeout: 120_000,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code !== 0) return resolve(null);
        try {
          const parsed = JSON.parse(out.trim().split('\n').pop()!) as BeatAnalysis;
          if (!Array.isArray(parsed.beatsMs)) return resolve(null);
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * Pure-Node fallback: windowed RMS energy onsets on 10 ms hops with an
   * adaptive threshold. Good enough to drive beat-synced cuts when librosa
   * is unavailable.
   */
  private async fallbackAnalyze(wavPath: string): Promise<BeatAnalysis> {
    const buf = await fsp.readFile(wavPath);
    // Parse minimal WAV header: find "data" chunk, assume PCM s16le mono 22050.
    const dataOffset = findChunk(buf, 'data');
    if (dataOffset < 0) throw new Error('Invalid WAV: data chunk not found');
    const fmtOffset = findChunk(buf, 'fmt ');
    let sampleRate = 22050;
    let channels = 1;
    let bitsPerSample = 16;
    if (fmtOffset >= 0) {
      channels = buf.readUInt16LE(fmtOffset + 2);
      sampleRate = buf.readUInt32LE(fmtOffset + 4);
      bitsPerSample = buf.readUInt16LE(fmtOffset + 14);
    }
    const dataLen = buf.readUInt32LE(dataOffset + 4);
    const bytesPerSample = bitsPerSample / 8;
    const sampleCount = Math.floor(Math.min(dataLen, buf.length - dataOffset - 8) / (bytesPerSample * channels));
    const hop = Math.max(1, Math.floor(sampleRate * 0.01)); // 10 ms
    const energies: number[] = [];
    for (let h = 0; h + hop <= sampleCount; h += hop) {
      let acc = 0;
      for (let s = h; s < h + hop; s++) {
        const off = dataOffset + 8 + s * bytesPerSample * channels;
        const v = buf.readInt16LE(off) / 32768;
        acc += v * v;
      }
      energies.push(acc / hop);
    }
    // Smooth
    const smoothed = energies.map((_, i) => {
      const lo = Math.max(0, i - 2);
      const hi = Math.min(energies.length, i + 3);
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += energies[k];
      return sum / (hi - lo);
    });
    const peak = Math.max(...smoothed, 1e-9);
    const norm = smoothed.map((e) => e / peak);
    const mean = norm.reduce((a, b) => a + b, 0) / (norm.length || 1);
    const thresh = mean * 1.6 + 0.05;
    const minGapFrames = 18; // 180 ms refractory
    const onsetsMs: number[] = [];
    let last = -minGapFrames;
    for (let i = 1; i < norm.length - 1; i++) {
      if (norm[i] > thresh && norm[i] >= norm[i - 1] && norm[i] >= norm[i + 1]) {
        if (i - last >= minGapFrames) {
          onsetsMs.push(Math.round(i * 10));
          last = i;
        }
      }
    }
    let tempoBpm = 0;
    if (onsetsMs.length >= 3) {
      const intervals = onsetsMs.slice(1).map((v, i) => v - onsetsMs[i]).sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      if (median > 0) {
        tempoBpm = 60000 / median;
        while (tempoBpm > 180) tempoBpm /= 2;
        while (tempoBpm > 0 && tempoBpm < 70) tempoBpm *= 2;
      }
    }
    const buckets = 128;
    const step = Math.max(1, Math.floor(norm.length / buckets));
    const energyProfile: number[] = [];
    for (let b = 0; b < buckets; b++) {
      const chunk = norm.slice(b * step, (b + 1) * step);
      energyProfile.push(Math.round(Math.max(...chunk, 0) * 10000) / 10000);
    }
    return {
      engine: 'fallback-energy',
      sampleRate,
      durationSec: Math.round((sampleCount / sampleRate) * 10000) / 10000,
      tempoBpm: Math.round(tempoBpm * 100) / 100,
      beatsMs: onsetsMs,
      onsetsMs,
      energyProfile,
    };
  }
}

function findChunk(buf: Buffer, id: string): number {
  // Walk RIFF chunks starting at offset 12.
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (chunkId === id) return pos;
    pos += 8 + size + (size % 2);
  }
  return -1;
}
