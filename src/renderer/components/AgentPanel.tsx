import { useState } from 'react';
import { useKinetix } from '../store';

/**
 * Embedded Agent Control Interface: paste an API key, trigger automated
 * editing scripts, and watch a live log of API/agent operations.
 */
export function AgentPanel() {
  const settings = useKinetix((s) => s.settings);
  const apiBase = useKinetix((s) => s.apiBase);
  const agentKeyInput = useKinetix((s) => s.agentKeyInput);
  const setAgentKeyInput = useKinetix((s) => s.setAgentKeyInput);
  const updateSettings = useKinetix((s) => s.updateSettings);
  const rotateApiKey = useKinetix((s) => s.rotateApiKey);
  const logs = useKinetix((s) => s.agentLogs);
  const pushLog = useKinetix((s) => s.pushLog);
  const analyzeAsset = useKinetix((s) => s.analyzeAsset);
  const autoBuild = useKinetix((s) => s.autoBuild);
  const startRender = useKinetix((s) => s.startRender);
  const project = useKinetix((s) => s.project);
  const renderProgress = useKinetix((s) => s.renderProgress);
  const [busy, setBusy] = useState<string | null>(null);
  const [rawBody, setRawBody] = useState('{\n  "path": "C:\\\\path\\\\to\\\\clip.mp4"\n}');

  const runScript = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    pushLog({ direction: 'out', message: `▶ ${name}` });
    try {
      await fn();
    } catch (err) {
      pushLog({ direction: 'sys', message: `✖ ${name}: ${String(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const callApi = async (method: string, path: string, body?: unknown) => {
    const key = settings?.apiKey ?? '';
    try {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          'X-API-Key': agentKeyInput || key,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      pushLog({
        direction: 'in',
        method,
        path,
        status: res.status,
        message: res.ok ? `✔ ${method} ${path}` : `✖ ${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 160)}`,
      });
      return json;
    } catch (err) {
      pushLog({ direction: 'in', method, path, status: 0, message: `✖ ${method} ${path}: ${String(err)}` });
      return null;
    }
  };

  const videoAssets = (project?.assets ?? []).filter((a) => a.kind === 'video');

  return (
    <aside className="w-80 shrink-0 border-l border-surface-700/70 bg-surface-900 flex flex-col">
      <div className="h-10 flex items-center px-3 border-b border-surface-700/70">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">AI Agent Control</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
        {/* API key */}
        <section className="space-y-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">API Key</label>
          <input
            className="kx-input font-mono"
            type="password"
            value={agentKeyInput}
            onChange={(e) => setAgentKeyInput(e.target.value)}
            placeholder="kx_…"
            aria-label="API key"
          />
          <div className="flex gap-1.5">
            <button
              className="kx-btn-ghost flex-1"
              onClick={() => void updateSettings({ apiKey: agentKeyInput, apiEnabled: true })}
            >
              Save & Enable
            </button>
            <button className="kx-btn-ghost" onClick={() => void rotateApiKey()} title="Generate a new key">
              Rotate
            </button>
          </div>
          <div className="text-[10px] text-zinc-600 font-mono break-all">{apiBase}/api/v1</div>
        </section>

        {/* Automated scripts */}
        <section className="space-y-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Automated Scripts</label>
          <button
            className="kx-btn-primary w-full justify-center"
            disabled={busy !== null || videoAssets.length === 0}
            onClick={() =>
              void runScript('analyze-beats', async () => {
                if (videoAssets[0]) await analyzeAsset(videoAssets[0]);
              })
            }
          >
            {busy === 'analyze-beats' ? 'Analyzing…' : '1 · Extract audio & detect beats'}
          </button>
          <button
            className="kx-btn-primary w-full justify-center"
            disabled={busy !== null}
            onClick={() => void runScript('auto-build-sequence', autoBuild)}
          >
            {busy === 'auto-build-sequence' ? 'Building…' : '2 · Auto-build beat-synced sequence'}
          </button>
          <button
            className="kx-btn-primary w-full justify-center"
            disabled={busy !== null}
            onClick={() => void runScript('render-mp4', startRender)}
          >
            {busy === 'render-mp4' ? 'Rendering…' : '3 · Render full-res MP4'}
          </button>
          {renderProgress && (
            <div className="rounded-md bg-surface-850 border border-surface-700 p-2 space-y-1">
              <div className="flex justify-between text-[10px] text-zinc-400">
                <span>Render {renderProgress.state}</span>
                <span>{(renderProgress.progress * 100).toFixed(0)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface-700 overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${renderProgress.progress * 100}%` }} />
              </div>
              {renderProgress.outPath && <div className="text-[10px] text-zinc-600 font-mono break-all">{renderProgress.outPath}</div>}
            </div>
          )}
        </section>

        {/* Raw API console */}
        <section className="space-y-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Direct API Call</label>
          <div className="flex gap-1">
            <select
              className="kx-input !w-20"
              id="agent-method"
              defaultValue="GET"
              aria-label="HTTP method"
            >
              <option>GET</option>
              <option>POST</option>
              <option>PUT</option>
            </select>
            <input className="kx-input flex-1 font-mono" defaultValue="/api/v1/timeline" id="agent-path" aria-label="API path" />
          </div>
          <textarea
            className="kx-input font-mono h-20 resize-none"
            value={rawBody}
            onChange={(e) => setRawBody(e.target.value)}
            aria-label="JSON body"
          />
          <button
            className="kx-btn-ghost w-full justify-center"
            onClick={() => {
              const method = (document.getElementById('agent-method') as HTMLSelectElement).value;
              const p = (document.getElementById('agent-path') as HTMLInputElement).value;
              let body: unknown;
              try {
                body = rawBody.trim() ? JSON.parse(rawBody) : undefined;
              } catch {
                pushLog({ direction: 'sys', message: 'Body is not valid JSON' });
                return;
              }
              void callApi(method, p, method === 'GET' ? undefined : body);
            }}
          >
            Send
          </button>
        </section>

        {/* Quick endpoints */}
        <section className="space-y-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Endpoints</label>
          {[
            ['GET', '/api/v1/timeline'],
            ['POST', '/api/v1/audio/extract-and-analyze'],
            ['POST', '/api/v1/timeline/build-sequence'],
            ['POST', '/api/v1/render'],
            ['GET', '/api/v1/render/status'],
          ].map(([m, p]) => (
            <button
              key={p}
              className="w-full text-left rounded px-2 py-1 bg-surface-850 hover:bg-surface-800 border border-surface-700/50 font-mono text-[10px] text-zinc-400"
              onClick={() => void callApi(m, p, m === 'POST' ? {} : undefined)}
            >
              <span className="text-accent-soft">{m}</span> {p}
            </button>
          ))}
        </section>

        {/* Log */}
        <section className="space-y-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Activity Log</label>
          <div className="rounded-md bg-surface-950 border border-surface-800 p-2 space-y-1 max-h-48 overflow-y-auto font-mono text-[10px]">
            {logs.length === 0 && <div className="text-zinc-700">No activity yet.</div>}
            {logs.map((l) => (
              <div
                key={l.id}
                className={
                  l.direction === 'in' ? 'text-emerald-400' : l.direction === 'out' ? 'text-sky-400' : 'text-zinc-500'
                }
              >
                {l.message}
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}
