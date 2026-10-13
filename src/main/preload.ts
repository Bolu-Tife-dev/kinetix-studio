import { contextBridge, ipcRenderer } from 'electron';

export interface KinetixBridge {
  getInitialState(): Promise<{
    project: unknown;
    settings: unknown;
    apiBase: string;
    binaries: { ffmpeg: string | null; ffprobe: string | null };
  }>;
  getSettings(): Promise<unknown>;
  updateSettings(patch: Record<string, unknown>): Promise<unknown>;
  rotateApiKey(): Promise<string>;
  setAspect(ratio: '16:9' | '9:16' | '1:1' | '4:5'): Promise<unknown>;
  setProjectName(name: string): Promise<unknown>;
  addClip(clip: unknown): Promise<unknown>;
  updateClip(id: string, patch: Record<string, unknown>): Promise<unknown>;
  removeClip(id: string): Promise<boolean>;
  replaceTimeline(clips: unknown[]): Promise<unknown>;
  clearTimeline(): Promise<unknown>;
  addAsset(asset: Record<string, unknown>): Promise<unknown>;
  removeAsset(id: string): Promise<unknown>;
  mediaUrl(absPath: string): Promise<string>;
  importMedia(): Promise<unknown[]>;
  probe(path: string): Promise<unknown>;
  analyzeAudio(path: string): Promise<unknown>;
  buildSequence(req: unknown): Promise<unknown>;
  startRender(opts?: Record<string, unknown>): Promise<string>;
  renderStatus(jobId?: string): Promise<unknown>;
  pickOutputPath(): Promise<string | null>;
  showItemInFolder(path: string): void;
  openExternal(url: string): void;
  onProjectUpdated(cb: (project: unknown) => void): () => void;
  onRenderProgress(cb: (p: unknown) => void): () => void;
}

const bridge: KinetixBridge = {
  getInitialState: () => ipcRenderer.invoke('kinetix:get-initial-state'),
  getSettings: () => ipcRenderer.invoke('kinetix:get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('kinetix:update-settings', patch),
  rotateApiKey: () => ipcRenderer.invoke('kinetix:rotate-api-key'),
  setAspect: (ratio) => ipcRenderer.invoke('kinetix:set-aspect', ratio),
  setProjectName: (name) => ipcRenderer.invoke('kinetix:set-project-name', name),
  addClip: (clip) => ipcRenderer.invoke('kinetix:add-clip', clip),
  updateClip: (id, patch) => ipcRenderer.invoke('kinetix:update-clip', id, patch),
  removeClip: (id) => ipcRenderer.invoke('kinetix:remove-clip', id),
  replaceTimeline: (clips) => ipcRenderer.invoke('kinetix:replace-timeline', clips),
  clearTimeline: () => ipcRenderer.invoke('kinetix:clear-timeline'),
  addAsset: (asset) => ipcRenderer.invoke('kinetix:add-asset', asset),
  removeAsset: (id) => ipcRenderer.invoke('kinetix:remove-asset', id),
  mediaUrl: (absPath) => ipcRenderer.invoke('kinetix:media-url', absPath),
  importMedia: () => ipcRenderer.invoke('kinetix:import-media'),
  probe: (path) => ipcRenderer.invoke('kinetix:probe', path),
  analyzeAudio: (path) => ipcRenderer.invoke('kinetix:analyze-audio', path),
  buildSequence: (req) => ipcRenderer.invoke('kinetix:build-sequence', req),
  startRender: (opts) => ipcRenderer.invoke('kinetix:start-render', opts),
  renderStatus: (jobId) => ipcRenderer.invoke('kinetix:render-status', jobId),
  pickOutputPath: () => ipcRenderer.invoke('kinetix:pick-output'),
  showItemInFolder: (path) => void ipcRenderer.invoke('kinetix:show-item', path),
  openExternal: (url) => void ipcRenderer.invoke('kinetix:open-external', url),
  onProjectUpdated: (cb) => {
    const listener = (_e: unknown, project: unknown) => cb(project);
    ipcRenderer.on('kinetix:project-updated', listener);
    return () => ipcRenderer.removeListener('kinetix:project-updated', listener);
  },
  onRenderProgress: (cb) => {
    const listener = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('kinetix:render-progress', listener);
    return () => ipcRenderer.removeListener('kinetix:render-progress', listener);
  },
};

contextBridge.exposeInMainWorld('kinetix', bridge);
