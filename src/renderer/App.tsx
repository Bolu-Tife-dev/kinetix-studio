import { AspectRatioSwitcher } from './components/AspectRatioSwitcher';
import { AssetLibrary } from './components/AssetLibrary';
import { CanvasPreview } from './components/CanvasPreview';
import { Timeline } from './components/Timeline';
import { AgentPanel } from './components/AgentPanel';
import { SettingsModal } from './components/SettingsModal';
import { TransportBar } from './components/TransportBar';
import { useKinetix } from './store';

export default function App() {
  const booted = useKinetix((s) => s.booted);
  const project = useKinetix((s) => s.project);
  const activePanel = useKinetix((s) => s.activePanel);
  const setActivePanel = useKinetix((s) => s.setActivePanel);
  const binaries = useKinetix((s) => s.binaries);

  if (!booted || !project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold tracking-tight text-white">
            Kinetix <span className="text-accent">Studio</span>
          </div>
          <div className="mt-2 text-xs text-zinc-500">Booting engine…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <header className="h-12 flex items-center gap-3 px-3 border-b border-surface-700/70 bg-surface-900">
        <div className="flex items-center gap-2 pr-3 border-r border-surface-700/70">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-accent to-accent-dim flex items-center justify-center text-[11px] font-black text-white">
            K
          </div>
          <span className="text-sm font-semibold tracking-tight text-white">
            Kinetix <span className="text-accent-soft">Studio</span>
          </span>
        </div>
        <ProjectName />
        <div className="flex-1" />
        <AspectRatioSwitcher />
        <TransportBar />
        <div className="flex items-center gap-1.5 pl-3 border-l border-surface-700/70">
          <button
            className={`kx-btn ${activePanel === 'agent' ? 'bg-accent text-white' : 'kx-btn-ghost'}`}
            onClick={() => setActivePanel(activePanel === 'agent' ? null : 'agent')}
            title="AI Agent Control"
          >
            Agent
          </button>
          <button
            className={`kx-btn ${activePanel === 'settings' ? 'bg-accent text-white' : 'kx-btn-ghost'}`}
            onClick={() => setActivePanel(activePanel === 'settings' ? null : 'settings')}
            title="Settings"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Engine status strip */}
      <div className="h-6 flex items-center gap-4 px-3 text-[10px] text-zinc-500 bg-surface-950 border-b border-surface-800">
        <span>
          FFmpeg:{' '}
          <span className={binaries.ffmpeg ? 'text-emerald-400' : 'text-red-400'}>
            {binaries.ffmpeg ? 'bundled / detected' : 'not found'}
          </span>
        </span>
        <span>
          API:{' '}
          <span className="text-emerald-400">
            127.0.0.1:{useKinetix.getState().settings?.port ?? 4815}
          </span>
        </span>
        <span>Timeline: {project.clips.length} clips · {project.durationSec.toFixed(1)}s</span>
      </div>

      <div className="flex-1 flex min-h-0">
        <AssetLibrary />
        <main className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 flex items-center justify-center bg-[radial-gradient(ellipse_at_center,#141821_0%,#08090c_70%)] p-4">
            <CanvasPreview />
          </div>
          <Timeline />
        </main>
        {activePanel === 'agent' && <AgentPanel />}
        {activePanel === 'settings' && <SettingsModal />}
      </div>
    </div>
  );
}

function ProjectName() {
  const project = useKinetix((s) => s.project);
  const setName = async (name: string) => {
    await window.kinetix?.setProjectName(name);
  };
  if (!project) return null;
  return (
    <input
      className="kx-input max-w-[220px] font-medium"
      defaultValue={project.name}
      key={project.id + project.name}
      onBlur={(e) => void setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      aria-label="Project name"
    />
  );
}
