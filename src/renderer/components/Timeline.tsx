import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TimelineClip, TrackKind } from '../../shared/types';
import { useKinetix } from '../store';

const TRACKS: Array<{ kind: TrackKind; label: string; height: number; cls: string }> = [
  { kind: 'video', label: 'Video', height: 56, cls: 'bg-track-video/15 border-track-video/40' },
  { kind: 'audio', label: 'Audio', height: 40, cls: 'bg-track-audio/15 border-track-audio/40' },
  { kind: 'text', label: 'Text', height: 36, cls: 'bg-track-text/15 border-track-text/40' },
];

const TRANSITION_MARK: Record<string, string> = {
  cut: '│',
  flash: '⚡',
  glitch: '◈',
  fade: '◐',
  'zoom-punch': '◎',
};

export function Timeline() {
  const project = useKinetix((s) => s.project);
  const playhead = useKinetix((s) => s.playhead);
  const setPlayhead = useKinetix((s) => s.setPlayhead);
  const pxPerSec = useKinetix((s) => s.pxPerSec);
  const setPxPerSec = useKinetix((s) => s.setPxPerSec);
  const selectedClipId = useKinetix((s) => s.selectedClipId);
  const selectClip = useKinetix((s) => s.selectClip);
  const moveClip = useKinetix((s) => s.moveClip);
  const trimClip = useKinetix((s) => s.trimClip);
  const updateClipLocal = useKinetix((s) => s.updateClipLocal);
  const addClipToTimeline = useKinetix((s) => s.addClipToTimeline);
  const addTextClip = useKinetix((s) => s.addTextClip);

  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<Record<TrackKind, HTMLDivElement | null>>({ video: null, audio: null, text: null });
  const [drag, setDrag] = useState<
    | { type: 'move'; clipId: string; grabOffset: number }
    | { type: 'trim'; clipId: string; edge: 'left' | 'right'; orig: TimelineClip }
    | { type: 'scrub' }
    | null
  >(null);

  const duration = Math.max(project?.durationSec ?? 0, 30);
  const contentWidth = duration * pxPerSec + 240;

  const ticks = useMemo(() => {
    const stepCandidates = [0.5, 1, 2, 5, 10, 30, 60];
    const step = stepCandidates.find((s) => s * pxPerSec >= 48) ?? 60;
    const out: Array<{ t: number; label: string }> = [];
    for (let t = 0; t <= duration + step; t += step) {
      out.push({ t, label: formatTime(t) });
    }
    return out;
  }, [duration, pxPerSec]);

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left + el.scrollLeft - 120; // 120 = track header width
      return Math.max(0, x / pxPerSec);
    },
    [pxPerSec]
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      if (drag.type === 'scrub') {
        setPlayhead(timeFromClientX(e.clientX));
        return;
      }
      if (drag.type === 'move') {
        const t = timeFromClientX(e.clientX) - drag.grabOffset;
        updateClipLocal(drag.clipId, { start: Math.max(0, t) });
        return;
      }
      if (drag.type === 'trim') {
        const clip = drag.orig;
        const t = timeFromClientX(e.clientX);
        if (drag.edge === 'right') {
          const newDur = Math.max(0.1, t - clip.start);
          updateClipLocal(clip.id, { duration: newDur });
        } else {
          const maxStart = clip.start + clip.duration - 0.1;
          const newStart = Math.min(maxStart, Math.max(0, t));
          const delta = newStart - clip.start;
          updateClipLocal(clip.id, {
            start: newStart,
            duration: clip.duration - delta,
            sourceIn: Math.max(0, clip.sourceIn + delta),
          });
        }
      }
    };
    const onUp = () => {
      if (drag.type === 'move' || drag.type === 'trim') {
        const clip = useKinetix.getState().project?.clips.find((c) => c.id === drag.clipId);
        if (clip) {
          void moveClip(clip.id, clip.start);
          if (drag.type === 'trim') {
            void trimClip(clip.id, clip.start, clip.duration, clip.sourceIn);
          }
        }
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, setPlayhead, timeFromClientX, updateClipLocal, moveClip, trimClip]);

  const onLaneDrop = (e: React.DragEvent, track: TrackKind) => {
    e.preventDefault();
    const assetId = e.dataTransfer.getData('application/x-kinetix-asset');
    if (!assetId || !project) return;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) return;
    if (track === 'text') {
      void addTextClip(asset.name);
      return;
    }
    if (track === 'audio' && asset.kind === 'video') {
      // Dropping a video onto the audio lane places its audio stream.
      void addClipToTimeline(asset, 'audio', timeFromClientX(e.clientX));
      return;
    }
    void addClipToTimeline(asset, track === 'audio' ? 'audio' : 'video', timeFromClientX(e.clientX));
  };

  if (!project) return null;

  return (
    <div className="h-56 border-t border-surface-700/70 bg-surface-900 flex flex-col">
      <div className="h-8 flex items-center gap-2 px-3 border-b border-surface-800">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Timeline</span>
        <div className="flex-1" />
        <button className="kx-btn-ghost !py-0.5" onClick={() => setPxPerSec(pxPerSec / 1.4)} title="Zoom out">
          −
        </button>
        <span className="text-[10px] text-zinc-500 w-14 text-center tabular-nums">{pxPerSec.toFixed(0)} px/s</span>
        <button className="kx-btn-ghost !py-0.5" onClick={() => setPxPerSec(pxPerSec * 1.4)} title="Zoom in">
          +
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden relative">
        <div className="flex" style={{ width: contentWidth + 120 }}>
          {/* Track headers column (sticky) */}
          <div className="sticky left-0 z-20 w-[120px] shrink-0 bg-surface-900 border-r border-surface-800">
            <div className="h-7 border-b border-surface-800" />
            {TRACKS.map((t) => (
              <div
                key={t.kind}
                className="flex items-center px-2 border-b border-surface-800/80 text-[11px] font-medium text-zinc-400"
                style={{ height: t.height }}
              >
                <span className={`w-1.5 h-4 rounded-full mr-2 ${t.cls.split(' ')[1]}`} />
                {t.label}
              </div>
            ))}
          </div>

          {/* Ruler */}
          <div
            className="relative h-7 border-b border-surface-800 cursor-ew-resize select-none"
            style={{ width: contentWidth }}
            onPointerDown={(e) => {
              setDrag({ type: 'scrub' });
              setPlayhead(timeFromClientX(e.clientX));
            }}
          >
            {ticks.map((tick) => (
              <div key={tick.t} className="absolute top-0 bottom-0 flex items-end" style={{ left: tick.t * pxPerSec }}>
                <div className="w-px h-2.5 bg-surface-600" />
                <span className="absolute top-0.5 left-1 text-[9px] text-zinc-600 tabular-nums">{tick.label}</span>
              </div>
            ))}
          </div>

          {/* Lanes */}
          {TRACKS.map((track) => (
            <div
              key={track.kind}
              ref={(el) => {
                laneRefs.current[track.kind] = el;
              }}
              className={`relative border-b border-surface-800/80 ${track.cls.split(' ')[0]}`}
              style={{ height: track.height, width: contentWidth }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(e) => onLaneDrop(e, track.kind)}
              onClick={(e) => {
                if (e.target === e.currentTarget) selectClip(null);
              }}
            >
              {/* second markers */}
              {Array.from({ length: Math.ceil(duration) + 1 }, (_, s) => (
                <div key={s} className="absolute top-0 bottom-0 w-px bg-surface-800/60" style={{ left: s * pxPerSec }} />
              ))}
              {project.clips
                .filter((c) => c.track === track.kind)
                .map((clip) => (
                  <ClipBlock
                    key={clip.id}
                    clip={clip}
                    pxPerSec={pxPerSec}
                    selected={clip.id === selectedClipId}
                    onSelect={() => selectClip(clip.id)}
                    onMoveStart={(e) => {
                      e.stopPropagation();
                      const t = timeFromClientX(e.clientX);
                      setDrag({ type: 'move', clipId: clip.id, grabOffset: t - clip.start });
                    }}
                    onTrimStart={(e, edge) => {
                      e.stopPropagation();
                      setDrag({ type: 'trim', clipId: clip.id, edge, orig: { ...clip } });
                    }}
                  />
                ))}
            </div>
          ))}

          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none"
            style={{ left: 120 + playhead * pxPerSec }}
          >
            <div className="w-3 h-3 -ml-1.5 bg-red-500 rounded-b-sm" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ClipBlock({
  clip,
  pxPerSec,
  selected,
  onSelect,
  onMoveStart,
  onTrimStart,
}: {
  clip: TimelineClip;
  pxPerSec: number;
  selected: boolean;
  onSelect: () => void;
  onMoveStart: (e: React.PointerEvent) => void;
  onTrimStart: (e: React.PointerEvent, edge: 'left' | 'right') => void;
}) {
  const width = Math.max(8, clip.duration * pxPerSec);
  const colors: Record<TrackKind, string> = {
    video: 'bg-track-video/30 border-track-video/60 hover:bg-track-video/40',
    audio: 'bg-track-audio/30 border-track-audio/60 hover:bg-track-audio/40',
    text: 'bg-track-text/30 border-track-text/60 hover:bg-track-text/40',
  };
  return (
    <div
      className={`kx-timeline-clip ${colors[clip.track]} border ${selected ? 'selected' : ''}`}
      style={{ left: clip.start * pxPerSec, width, top: 3, bottom: 3 }}
      onPointerDown={onMoveStart}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      title={`${clip.name} · ${clip.duration.toFixed(2)}s`}
    >
      <div
        className="kx-handle left"
        onPointerDown={(e) => onTrimStart(e, 'left')}
      />
      <div className="px-1.5 py-0.5 truncate text-zinc-100/90 font-medium flex items-center gap-1">
        {clip.transitionIn && clip.transitionIn !== 'cut' && (
          <span className="text-[9px] opacity-80" title={`Transition: ${clip.transitionIn}`}>
            {TRANSITION_MARK[clip.transitionIn]}
          </span>
        )}
        {clip.track === 'text' ? (clip.text ?? clip.name) : clip.name}
      </div>
      {clip.track === 'audio' && <div className="absolute inset-x-0 bottom-0 h-1 bg-track-audio/50" />}
      <div
        className="kx-handle right"
        onPointerDown={(e) => onTrimStart(e, 'right')}
      />
    </div>
  );
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s < 10 ? '0' : ''}${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}`;
}
