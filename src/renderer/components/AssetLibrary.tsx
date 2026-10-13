import { AssetMeta } from '../../shared/types';
import { useKinetix } from '../store';

const KIND_BADGE: Record<string, { label: string; cls: string }> = {
  video: { label: 'V', cls: 'bg-track-video/20 text-track-video' },
  audio: { label: 'A', cls: 'bg-track-audio/20 text-track-audio' },
  image: { label: 'I', cls: 'bg-track-text/20 text-track-text' },
};

export function AssetLibrary() {
  const project = useKinetix((s) => s.project);
  const importMedia = useKinetix((s) => s.importMedia);
  const addClipToTimeline = useKinetix((s) => s.addClipToTimeline);
  const analyzeAsset = useKinetix((s) => s.analyzeAsset);
  const lastAnalysis = useKinetix((s) => s.lastAnalysis);

  const assets = project?.assets ?? [];

  return (
    <aside className="w-60 shrink-0 border-r border-surface-700/70 bg-surface-900 flex flex-col">
      <div className="h-10 flex items-center justify-between px-3 border-b border-surface-700/70">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Library</span>
        <button className="kx-btn-primary !px-2 !py-1" onClick={() => void importMedia()}>
          + Import
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {assets.length === 0 && (
          <div className="text-[11px] text-zinc-600 leading-relaxed p-2">
            No media yet. Import videos, audio or images — then drag them onto the timeline or click ▶ to append.
          </div>
        )}
        {assets.map((a) => (
          <AssetRow
            key={a.id}
            asset={a}
            onAdd={() => void addClipToTimeline(a)}
            onAnalyze={() => void analyzeAsset(a)}
          />
        ))}
      </div>
      {lastAnalysis && (
        <div className="border-t border-surface-700/70 p-3 text-[10px] text-zinc-500 space-y-1">
          <div className="font-semibold text-zinc-400 uppercase tracking-wider">Last Beat Analysis</div>
          <div>
            Engine: <span className="text-accent-soft">{lastAnalysis.engine}</span>
          </div>
          <div>Tempo: {lastAnalysis.tempoBpm.toFixed(1)} BPM</div>
          <div>Beats: {lastAnalysis.beatsMs.length}</div>
          <div className="flex items-end gap-px h-8 pt-1">
            {(lastAnalysis.energyProfile ?? []).map((v, i) => (
              <div key={i} className="flex-1 bg-accent/50 rounded-sm" style={{ height: `${Math.max(8, v * 100)}%` }} />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function AssetRow({ asset, onAdd, onAnalyze }: { asset: AssetMeta; onAdd: () => void; onAnalyze: () => void }) {
  const badge = KIND_BADGE[asset.kind] ?? KIND_BADGE.video;
  return (
    <div
      className="group rounded-md border border-surface-700/60 bg-surface-850 p-2 hover:border-accent/60 transition-colors"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-kinetix-asset', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className="flex items-center gap-2">
        <span className={`w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center ${badge.cls}`}>
          {badge.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-zinc-200 truncate" title={asset.name}>
            {asset.name}
          </div>
          <div className="text-[10px] text-zinc-500">
            {asset.durationSec > 0 ? `${asset.durationSec.toFixed(2)}s` : '—'}
            {asset.width ? ` · ${asset.width}×${asset.height}` : ''}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button className="kx-btn-ghost !px-1.5 !py-0.5 !text-[10px]" onClick={onAdd}>
          Append
        </button>
        <button className="kx-btn-ghost !px-1.5 !py-0.5 !text-[10px]" onClick={onAnalyze} title="Extract audio & detect beats">
          Analyze
        </button>
      </div>
    </div>
  );
}
