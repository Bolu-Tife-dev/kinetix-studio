/**
 * Stages FFmpeg / FFprobe binaries into vendor/ffmpeg/<platform>/ so
 * electron-builder can ship them as extraResources and end users never
 * need a system FFmpeg install.
 *
 * - Current host platform binaries are copied from ffmpeg-static / ffprobe-static.
 * - Other platforms are downloaded from well-known static-build mirrors when
 *   network access is available. Missing binaries degrade gracefully: the app
 *   falls back to ffmpeg-static module or system PATH at runtime.
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import https from 'node:https';

const ROOT = process.cwd();
const VENDOR = path.join(ROOT, 'vendor', 'ffmpeg');
const HOST = process.platform; // win32 | darwin | linux

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 8) return reject(new Error(`Too many redirects: ${url}`));
      let abs;
      try {
        abs = new URL(u, url).toString();
      } catch {
        return reject(new Error(`Invalid URL: ${u}`));
      }
      https
        .get(abs, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${abs}`));
          }
          const out = createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(dest)));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

function stageHost() {
  const outDir = path.join(VENDOR, HOST === 'win32' ? 'win32' : HOST === 'darwin' ? 'darwin' : 'linux');
  ensureDir(outDir);
  const ffmpegBin = HOST === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffprobeBin = HOST === 'win32' ? 'ffprobe.exe' : 'ffprobe';

  const staticFfmpeg = path.join(ROOT, 'node_modules', 'ffmpeg-static', ffmpegBin);
  if (existsSync(staticFfmpeg)) {
    copyFileSync(staticFfmpeg, path.join(outDir, ffmpegBin));
    console.log(`[stage-ffmpeg] staged host ffmpeg -> ${outDir}`);
  } else {
    console.warn('[stage-ffmpeg] ffmpeg-static not present; relying on runtime fallback');
  }

  // ffprobe-static layout: bin/<platform>/<arch>/ffprobe(.exe)
  const probeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const staticProbe = path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin', HOST, probeArch, ffprobeBin);
  if (existsSync(staticProbe)) {
    copyFileSync(staticProbe, path.join(outDir, ffprobeBin));
    console.log(`[stage-ffmpeg] staged host ffprobe -> ${outDir}`);
  }
}

async function stageLinux() {
  const outDir = path.join(VENDOR, 'linux');
  ensureDir(outDir);
  if (existsSync(path.join(outDir, 'ffmpeg')) && existsSync(path.join(outDir, 'ffprobe'))) return;
  const tarball = path.join(VENDOR, 'ffmpeg-linux-amd64.tar.xz');
  try {
    console.log('[stage-ffmpeg] downloading linux amd64 static build...');
    await download('https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz', tarball);
    // Discover the internal prefix directory (e.g. ffmpeg-7.0.2-amd64-static/).
    const listing = execFileSync('tar', ['-tJf', tarball], { encoding: 'utf8' });
    const prefix = listing
      .split(/\r?\n/)
      .find((l) => l.trim().endsWith('/'))?.replace(/\/$/, '');
    const members = prefix ? [`${prefix}/ffmpeg`, `${prefix}/ffprobe`] : ['ffmpeg', 'ffprobe'];
    execFileSync('tar', ['-xJf', tarball, '-C', outDir, '--strip-components=1', ...members], { stdio: 'inherit' });
    rmSync(tarball, { force: true });
    console.log('[stage-ffmpeg] linux binaries staged');
  } catch (err) {
    console.warn(`[stage-ffmpeg] linux staging skipped (${err.message}); build will ship without bundled linux ffmpeg`);
  }
}

async function stageDarwin() {
  const outDir = path.join(VENDOR, 'darwin');
  ensureDir(outDir);
  if (existsSync(path.join(outDir, 'ffmpeg'))) return;
  try {
    console.log('[stage-ffmpeg] downloading darwin x64 release builds...');
    const ffZip = path.join(VENDOR, 'ff-mac.zip');
    const fpZip = path.join(VENDOR, 'fp-mac.zip');
    await download('https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip', ffZip);
    await download('https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffprobe.zip', fpZip);
    execFileSync('tar', ['-xf', ffZip, '-C', outDir], { stdio: 'inherit' });
    execFileSync('tar', ['-xf', fpZip, '-C', outDir], { stdio: 'inherit' });
    rmSync(ffZip, { force: true });
    rmSync(fpZip, { force: true });
    console.log('[stage-ffmpeg] darwin binaries staged');
  } catch (err) {
    console.warn(`[stage-ffmpeg] darwin staging skipped (${err.message}); run build:mac on macOS for full bundling`);
  }
}

stageHost();
await stageLinux();
await stageDarwin();
console.log('[stage-ffmpeg] done');
