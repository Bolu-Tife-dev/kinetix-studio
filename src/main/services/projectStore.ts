import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AspectRatio,
  ASPECT_DIMENSIONS,
  ProjectState,
  TimelineClip,
  AssetMeta,
} from '../../shared/types';

/**
 * Authoritative project state. Lives in the Electron main process; the
 * renderer mirrors it through IPC and external agents mutate it through the
 * REST API. Persisted as project.json inside userData.
 */
export class ProjectStore {
  private state: ProjectState;
  private listeners = new Set<(s: ProjectState) => void>();
  private persistPath: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(userDataDir: string, initialState?: Partial<ProjectState>) {
    this.persistPath = path.join(userDataDir, 'project.json');
    this.state = {
      id: randomUUID(),
      name: 'Untitled Project',
      aspectRatio: '16:9',
      fps: 30,
      ...ASPECT_DIMENSIONS['16:9'],
      assets: [],
      clips: [],
      durationSec: 0,
      updatedAt: Date.now(),
      ...initialState,
    };
  }

  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as ProjectState;
      this.state = { ...this.state, ...parsed };
    } catch {
      /* first run */
    }
  }

  private schedulePersist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void fsp
        .writeFile(this.persistPath, JSON.stringify(this.state, null, 2), 'utf8')
        .catch(() => undefined);
    }, 250);
  }

  get(): ProjectState {
    return structuredClone(this.state);
  }

  subscribe(fn: (s: ProjectState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(mutator: (s: ProjectState) => void): ProjectState {
    mutator(this.state);
    this.recomputeDuration();
    this.state.updatedAt = Date.now();
    this.schedulePersist();
    const snapshot = this.get();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        /* listener errors must not break the store */
      }
    }
    return snapshot;
  }

  private recomputeDuration(): void {
    const end = this.state.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
    this.state.durationSec = Math.round(end * 1000) / 1000;
  }

  setAspectRatio(ratio: AspectRatio): ProjectState {
    return this.commit((s) => {
      s.aspectRatio = ratio;
      const dim = ASPECT_DIMENSIONS[ratio];
      s.width = dim.width;
      s.height = dim.height;
    });
  }

  setName(name: string): ProjectState {
    return this.commit((s) => {
      s.name = name;
    });
  }

  addAsset(asset: Omit<AssetMeta, 'id' | 'addedAt'>): AssetMeta {
    const full: AssetMeta = { ...asset, id: randomUUID(), addedAt: Date.now() };
    this.commit((s) => {
      s.assets.push(full);
    });
    return full;
  }

  removeAsset(assetId: string): ProjectState {
    return this.commit((s) => {
      s.assets = s.assets.filter((a) => a.id !== assetId);
      s.clips = s.clips.filter((c) => c.assetId !== assetId);
    });
  }

  addClip(clip: Omit<TimelineClip, 'id'> & { id?: string }): TimelineClip {
    const full: TimelineClip = { id: clip.id ?? randomUUID(), ...clip };
    this.commit((s) => {
      s.clips.push(full);
      s.clips.sort((a, b) => a.start - b.start || a.track.localeCompare(b.track));
    });
    return full;
  }

  updateClip(id: string, patch: Partial<TimelineClip>): TimelineClip | null {
    let updated: TimelineClip | null = null;
    this.commit((s) => {
      const clip = s.clips.find((c) => c.id === id);
      if (!clip) return;
      Object.assign(clip, patch, { id: clip.id });
      updated = clip;
      s.clips.sort((a, b) => a.start - b.start || a.track.localeCompare(b.track));
    });
    return updated;
  }

  removeClip(id: string): boolean {
    let removed = false;
    this.commit((s) => {
      const before = s.clips.length;
      s.clips = s.clips.filter((c) => c.id !== id);
      removed = s.clips.length !== before;
    });
    return removed;
  }

  /** Atomically replace the full timeline (used by build-sequence). */
  replaceTimeline(clips: Array<Omit<TimelineClip, 'id'> & { id?: string }>, opts?: { replaceAssets?: AssetMeta[] }): ProjectState {
    return this.commit((s) => {
      s.clips = clips.map((c) => ({ id: c.id ?? randomUUID(), ...c }));
      s.clips.sort((a, b) => a.start - b.start || a.track.localeCompare(b.track));
      if (opts?.replaceAssets) s.assets = opts.replaceAssets;
    });
  }

  clearTimeline(): ProjectState {
    return this.commit((s) => {
      s.clips = [];
    });
  }
}
