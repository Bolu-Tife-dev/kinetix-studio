import { AspectRatio } from '../../shared/types';
import { useKinetix } from '../store';

const RATIOS: Array<{ ratio: AspectRatio; label: string; icon: string }> = [
  { ratio: '16:9', label: 'Widescreen', icon: ' widescreen' },
  { ratio: '9:16', label: 'Shorts', icon: 'vertical' },
  { ratio: '1:1', label: 'Square', icon: 'square' },
  { ratio: '4:5', label: 'Portrait', icon: 'portrait' },
];

export function AspectRatioSwitcher() {
  const project = useKinetix((s) => s.project);
  const setAspect = useKinetix((s) => s.setAspect);
  if (!project) return null;

  return (
    <div className="flex items-center gap-1 bg-surface-850 rounded-lg p-1" role="group" aria-label="Aspect ratio">
      {RATIOS.map(({ ratio, label }) => {
        const active = project.aspectRatio === ratio;
        return (
          <button
            key={ratio}
            title={`${label} — smart auto-centering crop`}
            onClick={() => void setAspect(ratio)}
            className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-colors ${
              active ? 'bg-accent text-white shadow' : 'text-zinc-400 hover:text-zinc-200 hover:bg-surface-700'
            }`}
          >
            {ratio}
          </button>
        );
      })}
    </div>
  );
}
