export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:5';

export type TrackKind = 'video' | 'audio' | 'text';

export type TransitionKind = 'cut' | 'flash' | 'glitch' | 'fade' | 'zoom-punch';

export type MediaKind = 'video' | 'audio' | 'image';

export interface AssetMeta {
  id: string;
  name: string;
  path: string;
  kind: MediaKind;
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  addedAt: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: 'left' | 'center' | 'right';
  x: number;
  y: number;
  background: string | null;
  letterSpacing: number;
  uppercase: boolean;
}

export interface TimelineClip {
  id: string;
  track: TrackKind;
  /** Absolute start on the timeline, in seconds. */
  start: number;
  /** Timeline duration in seconds. */
  duration: number;
  /** In-point inside the source media, in seconds. */
  sourceIn: number;
  /** Optional out-point inside the source media, in seconds. */
  sourceOut?: number;
  assetId?: string;
  src?: string;
  name: string;
  transitionIn?: TransitionKind;
  /** Opacity 0..1 for overlays / fades. */
  opacity?: number;
  /** Scale multiplier applied around center (zoom-punch transitions). */
  scale?: number;
  /** For text clips. */
  text?: string;
  textStyle?: TextStyle;
  /** Beat marker id this clip was snapped to (build-sequence provenance). */
  beatIndex?: number;
}

export interface ProjectState {
  id: string;
  name: string;
  aspectRatio: AspectRatio;
  fps: number;
  width: number;
  height: number;
  assets: AssetMeta[];
  clips: TimelineClip[];
  durationSec: number;
  updatedAt: number;
}

export interface BeatAnalysis {
  engine: 'librosa' | 'fallback-energy';
  sampleRate: number;
  durationSec: number;
  tempoBpm: number;
  beatsMs: number[];
  onsetsMs: number[];
  energyProfile?: number[];
}

export interface RenderProgress {
  jobId: string;
  state: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  outPath?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  frames?: number;
  fps?: number;
  speed?: string;
  logTail?: string;
}

export interface BuildSequenceRequest {
  clips: Array<{
    path?: string;
    assetId?: string;
    name?: string;
    inSec?: number;
    outSec?: number;
  }>;
  beats: number[];
  tempoBpm?: number;
  aspectRatio?: AspectRatio;
  transition?: TransitionKind;
  /** Optional text overlay spawned on every Nth beat. */
  textEveryNBeats?: number;
  textTemplate?: string;
  /** Snap mode: 'beat' places a cut on every beat, 'bar' groups 4 beats. */
  grouping?: 'beat' | 'bar' | 'half-bar';
  replaceTimeline?: boolean;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};
