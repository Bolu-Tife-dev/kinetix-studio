import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BuildSequenceRequest,
  ProjectState,
  TimelineClip,
  TransitionKind,
  AssetMeta,
} from '../../shared/types';
import { FfmpegService } from './ffmpeg';
import { ProjectStore } from './projectStore';

/**
 * Auto-edit engine: takes raw user clips + beat timestamps (ms) and produces
 * a beat-synced multi-track timeline with transitions and overlays.
 */
export class SequenceBuilder {
  constructor(
    private store: ProjectStore,
    private ffmpeg: FfmpegService
  ) {}

  async build(req: BuildSequenceRequest): Promise<ProjectState> {
    if (!req.clips || req.clips.length === 0) {
      throw new Error('build-sequence requires at least one clip');
    }
    if (!req.beats || req.beats.length < 2) {
      throw new Error('build-sequence requires at least two beat timestamps (ms)');
    }

    const grouping = req.grouping ?? 'beat';
    const groupSize = grouping === 'bar' ? 4 : grouping === 'half-bar' ? 2 : 1;
    const transition: TransitionKind = req.transition ?? 'glitch';

    // Resolve clip sources + probe durations in parallel.
    const resolved = await Promise.all(
      req.clips.map(async (c, i) => {
        const src = c.path ?? this.store.get().assets.find((a) => a.id === c.assetId)?.path;
        if (!src) throw new Error(`Clip #${i} is missing "path" or a valid "assetId"`);
        let durationSec = (c.outSec ?? 0) - (c.inSec ?? 0);
        if (durationSec <= 0) {
          try {
            const probe = await this.ffmpeg.probe(src);
            durationSec = probe.durationSec;
          } catch {
            durationSec = 2.5;
          }
        }
        const inSec = c.inSec ?? 0;
        const outSec = c.outSec ?? inSec + durationSec;
        return {
          src,
          name: c.name ?? path.basename(src),
          inSec,
          outSec,
          sourceDur: Math.max(0.1, outSec - inSec),
        };
      })
    );

    // Build cut points from beats: every `groupSize`-th beat is a cut boundary.
    const beats = [...req.beats].sort((a, b) => a - b);
    const cutBeats: number[] = [];
    for (let i = 0; i < beats.length; i += groupSize) {
      cutBeats.push(beats[i]);
    }
    if (cutBeats.length < 2) {
      // Degenerate beat grid — fall back to a fixed 2.5s cadence from first beat.
      const base = beats[0] ?? 0;
      cutBeats.length = 0;
      for (let t = base; t < base + 60_000; t += 2500) cutBeats.push(t);
    }

    const totalBeats = beats.length;
    const tempo = req.tempoBpm && req.tempoBpm > 0 ? req.tempoBpm : 120;

    const clips: Array<Omit<TimelineClip, 'id'>> = [];
    const newAssets: AssetMeta[] = [];
    let clipCursor = 0;
    let sourceCursor = 0; // running in-point within current source clip

    for (let seg = 0; seg < cutBeats.length - 1; seg++) {
      const segStartSec = cutBeats[seg] / 1000;
      const segEndSec = cutBeats[seg + 1] / 1000;
      const segDur = Math.max(0.05, segEndSec - segStartSec);

      const source = resolved[clipCursor % resolved.length];
      const available = source.sourceDur - sourceCursor;
      const useDur = Math.min(segDur, Math.max(0.05, available));

      clips.push({
        track: 'video',
        start: segStartSec,
        duration: useDur,
        sourceIn: source.inSec + sourceCursor,
        sourceOut: source.inSec + sourceCursor + useDur,
        src: source.src,
        name: source.name,
        transitionIn: seg === 0 ? 'cut' : transition,
        opacity: 1,
        scale: transition === 'zoom-punch' ? 1.08 : 1,
        beatIndex: seg * groupSize,
      });

      sourceCursor += useDur;
      if (sourceCursor >= source.sourceDur - 0.01) {
        clipCursor += 1;
        sourceCursor = 0;
      }
    }

    // Text overlays: stamp a kinetic title every N beats.
    const every = req.textEveryNBeats ?? Math.max(4, Math.round(groupSize * 4));
    if (every > 0) {
      for (let b = 0; b + 1 < totalBeats; b += every) {
        const start = beats[b] / 1000;
        const endBeats = Math.min(totalBeats - 1, b + groupSize);
        const dur = Math.max(0.3, beats[endBeats] / 1000 - start);
        const label = (req.textTemplate ?? 'BEAT {n}').replace('{n}', String(Math.floor(b / groupSize) + 1));
        clips.push({
          track: 'text',
          start,
          duration: dur,
          sourceIn: 0,
          name: label,
          text: label,
          textStyle: {
            fontFamily: 'Inter',
            fontSize: 72,
            fontWeight: 800,
            color: '#ffffff',
            align: 'center',
            x: 0.5,
            y: 0.82,
            background: '#7c5cff',
            letterSpacing: 2,
            uppercase: true,
          },
          opacity: 1,
          transitionIn: 'flash',
        });
      }
    }

    // Register any unresolved sources as assets so the library reflects them.
    const project = this.store.get();
    for (const r of resolved) {
      const existing = project.assets.find((a) => a.path === r.src) ?? newAssets.find((a) => a.path === r.src);
      if (!existing) {
        try {
          const probe = await this.ffmpeg.probe(r.src);
          newAssets.push({
            id: randomUUID(),
            name: r.name,
            path: r.src,
            kind: probe.hasAudio && !probe.hasVideo ? 'audio' : probe.hasVideo ? 'video' : 'image',
            durationSec: probe.durationSec,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            hasAudio: probe.hasAudio,
            addedAt: Date.now(),
          });
        } catch {
          newAssets.push({
            id: randomUUID(),
            name: r.name,
            path: r.src,
            kind: 'video',
            durationSec: 0,
            hasAudio: true,
            addedAt: Date.now(),
          });
        }
      }
    }

    const allAssets = [...project.assets];
    for (const a of newAssets) {
      if (!allAssets.some((x) => x.path === a.path)) allAssets.push(a);
    }

    if (req.aspectRatio) {
      this.store.setAspectRatio(req.aspectRatio);
    }
    if (req.replaceTimeline === false) {
      // Append to existing timeline offset by current duration.
      const offset = project.durationSec;
      for (const c of clips) {
        this.store.addClip({ ...c, id: randomUUID(), start: c.start + offset });
      }
      return this.store.get();
    }
    return this.store.replaceTimeline(clips, { replaceAssets: allAssets });
  }
}
