import { useState } from 'react';
import { useKinetix } from '../store';

export function SettingsModal() {
  const settings = useKinetix((s) => s.settings);
  const binaries = useKinetix((s) => s.binaries);
  const apiBase = useKinetix((s) => s.apiBase);
  const updateSettings = useKinetix((s) => s.updateSettings);
  const rotateApiKey = useKinetix((s) => s.rotateApiKey);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!settings) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(settings.apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <aside className="w-80 shrink-0 border-l border-surface-700/70 bg-surface-900 flex flex-col">
      <div className="h-10 flex items-center px-3 border-b border-surface-700/70">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Settings</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-5 text-xs">
        <section className="space-y-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Open API</label>
          <label className="flex items-center gap-2 text-zinc-300">
            <input
              type="checkbox"
              checked={settings.apiEnabled}
              onChange={(e) => void updateSettings({ apiEnabled: e.target.checked })}
              className="accent-accent"
            />
            Enable local REST API for external agents
          </label>
          <div className="text-[10px] text-zinc-600">
            Bound to <span className="font-mono text-zinc-400">{apiBase}</span> (loopback only).
          </div>
          <div className="space-y-1">
            <div className="text-[10px] text-zinc-500">API Key</div>
            <div className="flex gap-1">
              <input
                className="kx-input font-mono"
                type={revealed ? 'text' : 'password'}
                value={settings.apiKey}
                readOnly
                aria-label="Current API key"
              />
              <button className="kx-btn-ghost" onClick={() => setRevealed(!revealed)} title="Toggle visibility">
                {revealed ? '🙈' : '👁'}
              </button>
            </div>
            <div className="flex gap-1">
              <button className="kx-btn-ghost flex-1 justify-center" onClick={() => void copy()}>
                {copied ? 'Copied!' : 'Copy key'}
              </button>
              <button className="kx-btn-ghost flex-1 justify-center" onClick={() => void rotateApiKey()}>
                Rotate
              </button>
            </div>
          </div>
          <pre className="rounded bg-surface-950 border border-surface-800 p-2 text-[9px] text-zinc-500 overflow-x-auto">{`curl ${apiBase}/api/v1/timeline \\
  -H "X-API-Key: ${settings.apiKey.slice(0, 10)}…"`}</pre>
        </section>

        <section className="space-y-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Defaults</label>
          <div className="flex items-center justify-between text-zinc-300">
            <span>Default transition</span>
            <select
              className="kx-input !w-28"
              value={settings.defaultTransition}
              onChange={(e) => void updateSettings({ defaultTransition: e.target.value as never })}
              aria-label="Default transition"
            >
              <option value="glitch">Glitch</option>
              <option value="flash">Flash</option>
              <option value="fade">Fade</option>
              <option value="zoom-punch">Zoom</option>
              <option value="cut">Cut</option>
            </select>
          </div>
        </section>

        <section className="space-y-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Media Engine</label>
          <div className="space-y-1 text-[10px] text-zinc-500 font-mono break-all">
            <div>
              ffmpeg:{' '}
              <span className={binaries.ffmpeg ? 'text-emerald-400' : 'text-red-400'}>
                {binaries.ffmpeg ?? 'NOT FOUND'}
              </span>
            </div>
            <div>
              ffprobe:{' '}
              <span className={binaries.ffprobe ? 'text-emerald-400' : 'text-red-400'}>
                {binaries.ffprobe ?? 'NOT FOUND'}
              </span>
            </div>
            <div className="text-zinc-600 pt-1">
              Beat analysis: librosa Python sidecar with pure-Node energy fallback.
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
}
