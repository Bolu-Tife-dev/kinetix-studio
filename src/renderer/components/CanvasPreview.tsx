import { useEffect, useMemo, useRef } from 'react';
import { TimelineClip } from '../../shared/types';
import { useKinetix } from '../store';

/**
 * Canvas preview: renders the active video clip inside an aspect-ratio box
 * with a smart auto-centering crop matrix (object-cover / object-contain
 * parity with the FFmpeg scale+pad render filter), plus live text overlays.
 */
export function CanvasPreview() {
  const project = useKinetix((s) => s.project);
  const playhead = useKinetix((s) => s.playhead);
  const playing = useKinetix((s) => s.playing);
  const setPlayhead = useKinetix((s) => s.setPlayhead);
  const setPlaying = useKinetix((s) => s.setPlaying);
  const videoRef = useRef<HTMLVideoElement>(null);
  const urlCache = useRef(new Map<string, string>());

  const videoClip = useMemo(() => {
    if (!project) return null;
    return (
      project.clips
        .filter((c) => c.track === 'video' && playhead >= c.start && playhead < c.start + c.duration)
        .sort((a, b) => b.start - a.start)[0] ?? null
    );
  }, [project, playhead]);

  const audioClips = useMemo(() => {
    if (!project) return [];
    return project.clips.filter((c) => c.track === 'audio' && playhead >= c.start && playhead < c.start + c.duration);
  }, [project, playhead]);

  const textClips = useMemo(() => {
    if (!project) return [];
    return project.clips.filter((c) => c.track === 'text' && playhead >= c.start && playhead < c.start + c.duration);
  }, [project, playhead]);

  const src = useMemo(() => {
    if (!videoClip?.src) return null;
    const cached = urlCache.current.get(videoClip.src);
    if (cached) return cached;
    const url = `kinetix-media://local/${encodeURI(videoClip.src)}`;
    urlCache.current.set(videoClip.src, url);
    return url;
  }, [videoClip?.src]);

  const audioSrc = useMemo(() => {
    const clip = audioClips[0];
    if (!clip?.src) return null;
    const cached = urlCache.current.get(clip.src);
    if (cached) return cached;
    const url = `kinetix-media://local/${encodeURI(clip.src)}`;
    urlCache.current.set(clip.src, url);
    return url;
  }, [audioClips]);

  // Drive the playhead from the <video> element while playing (frame-accurate
  // to the source), otherwise advance with rAF when there is no video clip.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const v = videoRef.current;
      if (v && !v.paused && !v.ended) {
        const clip = videoClip;
        if (clip) {
          const timelineT = clip.start + (v.currentTime - clip.sourceIn);
          setPlayhead(timelineT);
          if (v.currentTime >= (clip.sourceOut ?? clip.start + clip.duration) - 0.02) {
            // advance to next video clip or stop
            const next = useKinetix
              .getState()
              .project?.clips.filter((c) => c.track === 'video' && c.start >= clip.start + clip.duration - 0.01)
              .sort((a, b) => a.start - b.start)[0];
            if (next) setPlayhead(next.start + 0.001);
            else {
              setPlaying(false);
              setPlayhead((useKinetix.getState().project?.durationSec ?? 0));
            }
          }
        }
      } else {
        setPlayhead(useKinetix.getState().playhead + dt);
        if (useKinetix.getState().playhead >= (useKinetix.getState().project?.durationSec ?? 0)) {
          setPlaying(false);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, videoClip, setPlayhead, setPlaying]);

  // Sync the <video> element to the active clip.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoClip || !src) return;
    const target = videoClip.sourceIn + Math.max(0, playhead - videoClip.start);
    if (v.src !== src) {
      v.src = src;
      const onLoaded = () => {
        v.currentTime = target;
        if (playing) void v.play().catch(() => undefined);
      };
      v.addEventListener('loadedmetadata', onLoaded, { once: true });
      return () => v.removeEventListener('loadedmetadata', onLoaded);
    }
    if (Math.abs(v.currentTime - target) > 0.35) {
      v.currentTime = target;
    }
    if (playing && v.paused) void v.play().catch(() => undefined);
    if (!playing && !v.paused) v.pause();
  }, [videoClip, src, playhead, playing]);

  const ratio = project?.aspectRatio ?? '16:9';
  const [rw, rh] = ratio.split(':').map(Number);
  const aspect = rw / rh;

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="relative bg-black rounded-lg overflow-hidden shadow-2xl shadow-black/60 ring-1 ring-surface-700/60"
        style={{ aspectRatio: `${rw} / ${rh}`, height: 'min(58vh, 520px)', width: `calc(min(58vh, 520px) * ${aspect})` }}
      >
        {/* Video layer — object-cover = smart center crop; object-contain = letterbox.
            We use contain to mirror the render filter's scale+pad centering matrix. */}
        {src ? (
          <video
            ref={videoRef}
            className="absolute inset-0 w-full h-full object-contain bg-black"
            playsInline
            muted={false}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-600 gap-2">
            <div className="text-4xl">▦</div>
            <div className="text-xs">No clip under playhead</div>
          </div>
        )}
        {audioSrc && (
          <audio
            src={audioSrc}
            ref={(el) => {
              if (!el) return;
              const clip = audioClips[0];
              if (!clip) return;
              const target = clip.sourceIn + Math.max(0, playhead - clip.start);
              if (Math.abs(el.currentTime - target) > 0.4) el.currentTime = target;
              if (playing && el.paused) void el.play().catch(() => undefined);
              if (!playing && !el.paused) el.pause();
            }}
          />
        )}

        {/* Live text overlays */}
        {textClips.map((clip) => (
          <TextOverlay key={clip.id} clip={clip} />
        ))}

        {/* Aspect ratio guide frame */}
        <div className="absolute inset-0 pointer-events-none ring-1 ring-inset ring-white/5 rounded-lg" />
      </div>
      <div className="text-[10px] text-zinc-600">
        Preview · {project?.width}×{project?.height} · {ratio} — Space play/pause · S split · T text · Del remove
      </div>
    </div>
  );
}

function TextOverlay({ clip }: { clip: TimelineClip }) {
  const style = clip.textStyle;
  const align = style?.align ?? 'center';
  const x = (style?.x ?? 0.5) * 100;
  const y = (style?.y ?? 0.82) * 100;
  return (
    <div
      className="absolute pointer-events-none whitespace-pre-wrap text-center"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(${align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0%'}, -50%)`,
        fontFamily: style?.fontFamily ?? 'Inter, sans-serif',
        fontSize: `clamp(12px, ${((style?.fontSize ?? 64) / 1080) * 100}cqh, ${(style?.fontSize ?? 64) / 4}px)`,
        fontWeight: style?.fontWeight ?? 800,
        color: style?.color ?? '#fff',
        letterSpacing: `${style?.letterSpacing ?? 0}px`,
        textTransform: style?.uppercase ? 'uppercase' : 'none',
        background: style?.background ?? 'transparent',
        padding: style?.background ? '0.25em 0.6em' : undefined,
        borderRadius: style?.background ? '0.2em' : undefined,
        opacity: clip.opacity ?? 1,
        textShadow: '0 2px 12px rgba(0,0,0,0.6)',
      }}
    >
      {clip.text}
    </div>
  );
}
