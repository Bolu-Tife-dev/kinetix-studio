import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Runtime path resolution that works inside Electron (packaged + unpackaged)
 * and inside plain Node (vitest). Electron is imported lazily so unit tests
 * never load the binary.
 */
export interface AppPaths {
  userData: string;
  ffmpeg: string | null;
  ffprobe: string | null;
  pythonScript: string | null;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}

let cachedElectron: typeof import('electron') | null | undefined;

async function tryLoadElectron(): Promise<typeof import('electron') | null> {
  if (cachedElectron !== undefined) return cachedElectron;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron') as typeof import('electron');
    cachedElectron = mod;
  } catch {
    cachedElectron = null;
  }
  return cachedElectron ?? null;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstExisting(candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (c && isExecutable(c)) return c;
  }
  return null;
}

function whichSync(bin: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT?.split(';') ?? ['.EXE', '.CMD', '.BAT']) : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + (ext.toLowerCase().startsWith('.') ? ext : ''));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function resolveAppPaths(overrideUserData?: string): Promise<AppPaths> {
  const electron = await tryLoadElectron();
  const isPackaged = Boolean(electron?.app?.isPackaged);
  const resourcesBase = isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '..', '..');

  let userData: string;
  if (overrideUserData) {
    userData = overrideUserData;
  } else if (electron?.app) {
    userData = electron.app.getPath('userData');
  } else {
    userData = path.join(os.tmpdir(), 'kinetix-studio-test');
  }
  fs.mkdirSync(userData, { recursive: true });

  const exe = process.platform === 'win32' ? '.exe' : '';
  const ffmpegName = `ffmpeg${exe}`;
  const ffprobeName = `ffprobe${exe}`;

  const ffmpeg = firstExisting([
    path.join(resourcesBase, 'ffmpeg', ffmpegName),
    path.join(resourcesBase, 'resources', 'ffmpeg', ffmpegName),
    safeRequireStatic('ffmpeg-static'),
    whichSync('ffmpeg'),
  ]);

  const ffprobe = firstExisting([
    path.join(resourcesBase, 'ffmpeg', ffprobeName),
    path.join(resourcesBase, 'resources', 'ffmpeg', ffprobeName),
    resolveFfprobeStatic(),
    whichSync('ffprobe'),
  ]);

  const pythonScript = firstExisting([
    path.join(resourcesBase, 'python', 'beat_analysis.py'),
    path.resolve(__dirname, '..', '..', 'src', 'main', 'python', 'beat_analysis.py'),
  ]);

  return { userData, ffmpeg, ffprobe, pythonScript, isPackaged, platform: process.platform };
}

function safeRequireStatic(mod: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require(mod);
    return typeof p === 'string' ? p : null;
  } catch {
    return null;
  }
}

function resolveFfprobeStatic(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('ffprobe-static') as { path?: string };
    return mod.path ?? null;
  } catch {
    return null;
  }
}
