/**
 * Cross-platform Linux build driver.
 *
 * - On Linux hosts: runs electron-builder --linux directly.
 * - On Windows hosts: builds inside WSL (Ubuntu) because the Windows host
 *   cannot create AppImage symlinks without Developer Mode and has no fpm
 *   for .deb. The project is synced to the WSL ext4 filesystem, dependencies
 *   installed there, and artifacts copied back into ./release.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

if (process.platform === 'linux') {
  process.exit(run('npx', ['electron-builder', '--linux']));
}

// ---- Windows host: route through WSL --------------------------------------
console.log('[build:linux] Windows host detected — building Linux targets inside WSL…');

const wsl = (bash) => run('wsl.exe', ['-e', 'bash', '-lc', bash]);

// Resolve the WSL user's home (cannot create dirs under /home directly).
const homeRes = spawnSync('wsl.exe', ['-e', 'bash', '-lc', 'echo $HOME'], { encoding: 'utf8', windowsHide: true });
const wslHome = (homeRes.stdout ?? '').trim() || '/home/ubuntu';
const WSL_BUILD_DIR = `${wslHome}/kinetix-build/kinetix-studio`;
console.log(`[build:linux] WSL build dir: ${WSL_BUILD_DIR}`);

// 1. Sync sources (no node_modules / release / vendor-win noise).
const sync = [
  `mkdir -p "${WSL_BUILD_DIR}"`,
  `rm -rf "${WSL_BUILD_DIR}/src" "${WSL_BUILD_DIR}/scripts" "${WSL_BUILD_DIR}/tests"`,
  `mkdir -p "${WSL_BUILD_DIR}/src" "${WSL_BUILD_DIR}/scripts" "${WSL_BUILD_DIR}/vendor/ffmpeg/linux"`,
  `cp -f "${wslPath(ROOT)}/package.json" "${wslPath(ROOT)}/package-lock.json" "${WSL_BUILD_DIR}/" 2>/dev/null || cp -f "${wslPath(ROOT)}/package.json" "${WSL_BUILD_DIR}/"`,
  `cp -rf "${wslPath(ROOT)}/src/." "${WSL_BUILD_DIR}/src/"`,
  `cp -rf "${wslPath(ROOT)}/scripts/." "${WSL_BUILD_DIR}/scripts/"`,
  `cp -rf "${wslPath(ROOT)}/vendor/ffmpeg/linux/." "${WSL_BUILD_DIR}/vendor/ffmpeg/linux/" 2>/dev/null || true`,
  `cp -f "${wslPath(ROOT)}/tsconfig.json" "${wslPath(ROOT)}/vite.config.mts" "${wslPath(ROOT)}/tailwind.config.js" "${wslPath(ROOT)}/postcss.config.js" "${wslPath(ROOT)}/vitest.config.mts" "${WSL_BUILD_DIR}/" 2>/dev/null || true`,
];
if (wsl(sync.join(' && ')) !== 0) {
  console.error('[build:linux] WSL sync failed');
  process.exit(1);
}

// 2. Install deps inside WSL (skipped when lockfile unchanged and node_modules present).
const install = wsl(
  `cd "${WSL_BUILD_DIR}" && ` +
    `if [ ! -d node_modules/electron ] || [ package.json -nt node_modules/.install-stamp ]; then ` +
    `npm install --no-audit --no-fund && touch node_modules/.install-stamp; else echo '[build:linux] deps up to date'; fi`
);
if (install !== 0) {
  console.error('[build:linux] WSL npm install failed');
  process.exit(1);
}

// 3. Build (typecheck + renderer + main happen in WSL for correct Electron binary).
const build = wsl(
  `cd "${WSL_BUILD_DIR}" && npm run build && npx electron-builder --linux`
);
if (build !== 0) {
  console.error('[build:linux] electron-builder failed inside WSL');
  process.exit(1);
}

// 4. Copy artifacts back.
fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
const copyBack = wsl(`cp -f "${WSL_BUILD_DIR}"/release/* "${wslPath(path.join(ROOT, 'release'))}/" 2>/dev/null; ls -la "${WSL_BUILD_DIR}/release"`);
if (copyBack !== 0) {
  console.error('[build:linux] artifact copy-back failed');
  process.exit(1);
}
console.log('[build:linux] done — artifacts in ./release');

function wslPath(winPath) {
  const p = winPath.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : p;
}
