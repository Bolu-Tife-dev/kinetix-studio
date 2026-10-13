import { create } from 'zustand';
import {
  AspectRatio,
  AssetMeta,
  BeatAnalysis,
  ProjectState,
  TimelineClip,
  TransitionKind,
} from '../shared/types';

declare global {
  interface Window {
    kinetix?: import('../main/preload').KinetixBridge;
  }
}

export interface AgentLogEntry {
  id: string;
  at: number;
  direction: 'in' | 'out' | 'sys';
  method?: string;
  path?: string;
  status?: number;
  message: string;
}

interface KinetixState {
  booted: boolean;
  project: ProjectState | null;
  settings: {
    apiKey: string;
    apiEnabled: boolean;
    port: number;
    autoStartServer: boolean;
    defaultTransition: TransitionKind;
  } | null;
  apiBase: string;
  binaries: { ffmpeg: string | null; ffprobe: string | null };

  playhead: number;
  playing: boolean;
  pxPerSec: number;
  selectedClipId: string | null;
  activePanel: 'agent' | 'settings' | null;

  agentKeyInput: string;
  agentLogs: AgentLogEntry[];
  lastAnalysis: BeatAnalysis | null;
  renderProgress: {
    jobId: string;
    state: string;
    progress: number;
    outPath?: string;
    error?: string;
  } | null;

  boot: () => Promise<void>;
  setProject: (p: ProjectState) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setPxPerSec: (v: number) => void;
  selectClip: (id: string | null) => void;
  setActivePanel: (p: 'agent' | 'settings' | null) => void;
  setAgentKeyInput: (v: string) => void;
  pushLog: (entry: Omit<AgentLogEntry, 'id' | 'at'>) => void;
  setLastAnalysis: (a: BeatAnalysis | null) => void;
  setRenderProgress: (p: KinetixState['renderProgress']) => void;

  importMedia: () => Promise<void>;
  addClipToTimeline: (asset: AssetMeta, track?: 'video' | 'audio', startSec?: number) => Promise<void>;
  moveClip: (id: string, start: number) => Promise<void>;
  trimClip: (id: string, start: number, duration: number, sourceIn: number) => Promise<void>;
  deleteClip: (id: string) => Promise<void>;
  splitClipAtPlayhead: () => Promise<void>;
  addTextClip: (text: string) => Promise<void>;
  updateClipLocal: (id: string, patch: Partial<TimelineClip>) => void;
  commitClip: (id: string, patch: Partial<TimelineClip>) => Promise<void>;
  setAspect: (r: AspectRatio) => Promise<void>;
  rotateApiKey: () => Promise<void>;
  updateSettings: (patch: Partial<NonNullable<KinetixState['settings']>>) => Promise<void>;
  analyzeAsset: (asset: AssetMeta) => Promise<BeatAnalysis | null>;
  autoBuild: () => Promise<void>;
  startRender: () => Promise<void>;
}

export const useKinetix = create<KinetixState>((set, get) => ({
  booted: false,
  project: null,
  settings: null,
  apiBase: 'http://127.0.0.1:4815',
  binaries: { ffmpeg: null, ffprobe: null },

  playhead: 0,
  playing: false,
  pxPerSec: 60,
  selectedClipId: null,
  activePanel: null,

  agentKeyInput: '',
  agentLogs: [],
  lastAnalysis: null,
  renderProgress: null,

  boot: async () => {
    const bridge = window.kinetix;
    if (!bridge) {
      set({ booted: true });
      return;
    }
    const initial = await bridge.getInitialState();
    set({
      project: initial.project as ProjectState,
      settings: initial.settings as KinetixState['settings'],
      apiBase: initial.apiBase,
      binaries: initial.binaries,
      agentKeyInput: (initial.settings as { apiKey?: string })?.apiKey ?? '',
      booted: true,
    });
    bridge.onProjectUpdated((p) => set({ project: p as ProjectState }));
    bridge.onRenderProgress((p) => {
      set({ renderProgress: p as KinetixState['renderProgress'] });
    });
  },

  setProject: (p) => set({ project: p }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (p) => set({ playing: p }),
  setPxPerSec: (v) => set({ pxPerSec: Math.min(400, Math.max(12, v)) }),
  selectClip: (id) => set({ selectedClipId: id }),
  setActivePanel: (p) => set({ activePanel: p }),
  setAgentKeyInput: (v) => set({ agentKeyInput: v }),
  pushLog: (entry) =>
    set((s) => ({
      agentLogs: [{ ...entry, id: Math.random().toString(36).slice(2), at: Date.now() }, ...s.agentLogs].slice(0, 200),
    })),
  setLastAnalysis: (a) => set({ lastAnalysis: a }),
  setRenderProgress: (p) => set({ renderProgress: p }),

  importMedia: async () => {
    const bridge = window.kinetix;
    if (!bridge) return;
    const assets = (await bridge.importMedia()) as AssetMeta[];
    for (const a of assets) {
      get().pushLog({ direction: 'sys', message: `Imported asset ${a.name} (${a.kind}, ${a.durationSec.toFixed(2)}s)` });
    }
  },

  addClipToTimeline: async (asset, track, startSec) => {
    const bridge = window.kinetix;
    const project = get().project;
    if (!bridge || !project) return;
    const tgtTrack = track ?? (asset.kind === 'audio' ? 'audio' : 'video');
    const start =
      startSec ??
      project.clips
        .filter((c) => c.track === tgtTrack)
        .reduce((max, c) => Math.max(max, c.start + c.duration), 0);
    await bridge.addClip({
      track: tgtTrack,
      start,
      duration: Math.max(0.2, asset.durationSec || 2),
      sourceIn: 0,
      assetId: asset.id,
      src: asset.path,
      name: asset.name,
      transitionIn: 'cut',
      opacity: 1,
      scale: 1,
    });
    get().pushLog({ direction: 'sys', message: `Added ${asset.name} to ${tgtTrack} track @ ${start.toFixed(2)}s` });
  },

  moveClip: async (id, start) => {
    const bridge = window.kinetix;
    if (!bridge) return;
    await bridge.updateClip(id, { start: Math.max(0, start) });
  },

  trimClip: async (id, start, duration, sourceIn) => {
    const bridge = window.kinetix;
    if (!bridge) return;
    await bridge.updateClip(id, { start: Math.max(0, start), duration: Math.max(0.1, duration), sourceIn: Math.max(0, sourceIn) });
  },

  deleteClip: async (id) => {
    const bridge = window.kinetix;
    if (!bridge) return;
    await bridge.removeClip(id);
    if (get().selectedClipId === id) set({ selectedClipId: null });
  },

  splitClipAtPlayhead: async () => {
    const bridge = window.kinetix;
    const { project, playhead, selectedClipId } = get();
    if (!bridge || !project) return;
    const clip =
      project.clips.find((c) => c.id === selectedClipId) ??
      project.clips.find((c) => c.track === 'video' && playhead > c.start + 0.05 && playhead < c.start + c.duration - 0.05);
    if (!clip) return;
    const offset = playhead - clip.start;
    if (offset <= 0.05 || offset >= clip.duration - 0.05) return;
    await bridge.updateClip(clip.id, { duration: offset });
    await bridge.addClip({
      ...clip,
      id: undefined,
      start: playhead,
      duration: clip.duration - offset,
      sourceIn: clip.sourceIn + offset,
      sourceOut: clip.sourceOut,
    });
  },

  addTextClip: async (text) => {
    const bridge = window.kinetix;
    const { project, playhead } = get();
    if (!bridge || !project) return;
    await bridge.addClip({
      track: 'text',
      start: playhead,
      duration: 3,
      sourceIn: 0,
      name: text.slice(0, 24),
      text,
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
        uppercase: false,
      },
      opacity: 1,
      transitionIn: 'fade',
    });
  },

  updateClipLocal: (id, patch) => {
    const project = get().project;
    if (!project) return;
    set({
      project: {
        ...project,
        clips: project.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    });
  },

  commitClip: async (id, patch) => {
    const bridge = window.kinetix;
    if (!bridge) return;
    await bridge.updateClip(id, patch);
  },

  setAspect: async (r) => {
    const bridge = window.kinetix;
    if (!bridge) return;
    await bridge.setAspect(r);
  },

  rotateApiKey: async () => {
    const bridge = window.kinetix;
    if (!bridge) return;
    const key = await bridge.rotateApiKey();
    set((s) => ({ settings: s.settings ? { ...s.settings, apiKey: key } : s.settings, agentKeyInput: key }));
    get().pushLog({ direction: 'sys', message: 'API key rotated' });
  },

  updateSettings: async (patch) => {
    const bridge = window.kinetix;
    if (!bridge) return;
    const next = (await bridge.updateSettings(patch as Record<string, unknown>)) as KinetixState['settings'];
    set({ settings: next });
  },

  analyzeAsset: async (asset) => {
    const bridge = window.kinetix;
    if (!bridge) return null;
    get().pushLog({ direction: 'sys', message: `Analyzing beats in ${asset.name}…` });
    try {
      const result = (await bridge.analyzeAudio(asset.path)) as BeatAnalysis;
      set({ lastAnalysis: result });
      get().pushLog({
        direction: 'sys',
        message: `Analysis complete via ${result.engine}: ${result.beatsMs.length} beats @ ${result.tempoBpm} BPM`,
      });
      return result;
    } catch (err) {
      get().pushLog({ direction: 'sys', message: `Analysis failed: ${String(err)}` });
      return null;
    }
  },

  autoBuild: async () => {
    const bridge = window.kinetix;
    const { project, lastAnalysis } = get();
    if (!bridge || !project) return;
    const videoAssets = project.assets.filter((a) => a.kind === 'video');
    if (videoAssets.length === 0) {
      get().pushLog({ direction: 'sys', message: 'Auto-build needs at least one video asset.' });
      return;
    }
    let beats = lastAnalysis?.beatsMs ?? [];
    if (beats.length < 2) {
      const analysis = await get().analyzeAsset(videoAssets[0]);
      beats = analysis?.beatsMs ?? [];
    }
    if (beats.length < 2) {
      get().pushLog({ direction: 'sys', message: 'Could not derive a beat grid — aborting auto-build.' });
      return;
    }
    const updated = (await bridge.buildSequence({
      clips: videoAssets.slice(0, 8).map((a) => ({ path: a.path, name: a.name })),
      beats,
      transition: project ? (get().settings?.defaultTransition ?? 'glitch') : 'glitch',
      grouping: 'beat',
      textEveryNBeats: 8,
      textTemplate: 'KINETIX',
    })) as ProjectState;
    set({ project: updated });
    get().pushLog({ direction: 'sys', message: `Auto-built sequence: ${updated.clips.length} clips synced to ${beats.length} beats.` });
  },

  startRender: async () => {
    const bridge = window.kinetix;
    if (!bridge) return;
    const outPath = await bridge.pickOutputPath();
    if (!outPath) return;
    const jobId = await bridge.startRender({ outPath });
    set({ renderProgress: { jobId, state: 'queued', progress: 0, outPath } });
    get().pushLog({ direction: 'sys', message: `Render queued: ${jobId}` });
  },
}));
