import { useEffect } from 'react';
import { useKinetix } from '../store';

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * 30);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

export function TransportBar() {
  const playhead = useKinetix((s) => s.playhead);
  const playing = useKinetix((s) => s.playing);
  const setPlaying = useKinetix((s) => s.setPlaying);
  const setPlayhead = useKinetix((s) => s.setPlayhead);
  const project = useKinetix((s) => s.project);
  const renderProgress = useKinetix((s) => s.renderProgress);
  const startRender = useKinetix((s) => s.startRender);
  const splitClipAtPlayhead = useKinetix((s) => s.splitClipAtPlayhead);
  const selectedClipId = useKinetix((s) => s.selectedClipId);
  const deleteClip = useKinetix((s) => s.deleteClip);
  const addTextClip = useKinetix((s) => s.addTextClip);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying(!useKinetix.getState().playing);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = useKinetix.getState().selectedClipId;
        if (id) void deleteClip(id);
      } else if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) {
        void splitClipAtPlayhead();
      } else if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey) {
        void addTextClip('New text');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPlaying, deleteClip, splitClipAtPlayhead, addTextClip]);

  const duration = project?.durationSec ?? 0;
  const rendering = renderProgress && (renderProgress.state === 'running' || renderProgress.state === 'queued');

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1 bg-surface-850 rounded-lg p-1">
        <button
          className="px-2 py-1 rounded-md text-zinc-300 hover:bg-surface-700 text-xs"
          onClick={() => setPlayhead(0)}
          title="Go to start"
        >
          ⏮
        </button>
        <button
          className="w-8 h-7 rounded-md bg-accent text-white text-xs font-bold hover:bg-accent-soft"
          onClick={() => setPlaying(!playing)}
          title="Play/Pause (Space)"
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          className="px-2 py-1 rounded-md text-zinc-300 hover:bg-surface-700 text-xs"
          onClick={() => setPlayhead(duration)}
          title="Go to end"
        >
          ⏭
        </button>
        <span className="px-2 font-mono text-[11px] text-zinc-400 tabular-nums">
          {fmt(playhead)} <span className="text-zinc-600">/</span> {fmt(duration)}
        </span>
      </div>

      <button className="kx-btn-ghost" onClick={() => void splitClipAtPlayhead()} title="Split at playhead (S)">
        Split
      </button>
      <button
        className="kx-btn-ghost"
        onClick={() => void addTextClip('New text')}
        title="Add text overlay (T)"
      >
        + Text
      </button>

      <button
        className="kx-btn-primary"
        onClick={() => void startRender()}
        disabled={Boolean(rendering)}
        title="Render full-resolution MP4 (hardware-accelerated)"
      >
        {rendering ? `Rendering ${(renderProgress!.progress * 100).toFixed(0)}%` : 'Export MP4'}
      </button>
    </div>
  );
}
