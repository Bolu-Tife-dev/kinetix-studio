import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { resolveAppPaths } from './paths';
import { ProjectStore } from './services/projectStore';
import { SettingsService } from './services/settings';
import { FfmpegService } from './services/ffmpeg';
import { BeatAnalyzer } from './services/analyzer';
import { RenderService } from './services/renderService';
import { SequenceBuilder } from './services/sequenceBuilder';
import { createApiServer, ApiContext } from './server/api';
import { ASPECT_DIMENSIONS, AspectRatio } from '../shared/types';

// Register the privileged scheme before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kinetix-media',
    privileges: { bypassCSP: true, stream: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const KINETIX_PORT = Number(process.env.KINETIX_PORT ?? 4815);
const KINETIX_HOST = '127.0.0.1';

let mainWindow: BrowserWindow | null = null;
let apiServer: import('http').Server | null = null;
let ctx: ApiContext | null = null;

async function bootstrap(): Promise<void> {
  const paths = await resolveAppPaths();
  const settings = new SettingsService(paths.userData);
  await settings.load();

  const store = new ProjectStore(paths.userData);
  await store.load();

  const ffmpeg = new FfmpegService({ ffmpeg: paths.ffmpeg, ffprobe: paths.ffprobe });
  const analyzer = new BeatAnalyzer(ffmpeg, findPython(), paths.pythonScript);
  const renderDir = path.join(paths.userData, 'renders');
  fs.mkdirSync(renderDir, { recursive: true });
  const render = new RenderService(ffmpeg, renderDir);
  const builder = new SequenceBuilder(store, ffmpeg);

  const rendererDist = app.isPackaged
    ? path.join(process.resourcesPath, '..', 'app.asar.unpacked') // fallback; real path below
    : path.resolve(__dirname, '..', 'dist');
  const distCandidate = app.isPackaged
    ? path.join(__dirname, '..', 'dist')
    : rendererDist;

  ctx = { store, settings, ffmpeg, analyzer, render, builder, rendererDist: distCandidate };

  // Broadcast state changes (API-driven edits) to the renderer.
  store.subscribe((state) => {
    mainWindow?.webContents.send('kinetix:project-updated', state);
  });
  render.onProgress((p) => {
    mainWindow?.webContents.send('kinetix:render-progress', p);
  });

  const apiApp = createApiServer(ctx);
  await new Promise<void>((resolve, reject) => {
    apiServer = apiApp.listen(KINETIX_PORT, KINETIX_HOST, () => resolve());
    apiServer?.on('error', reject);
  }).catch((err) => {
    console.error('[kinetix] failed to start local API:', err);
  });

  registerIpcHandlers(ctx);
  registerMediaProtocol();

  await createWindow();
}

function findPython(): string {
  const candidates =
    process.platform === 'win32'
      ? ['python', 'python3', 'py']
      : ['python3', 'python'];
  // We don't block on detection; the analyzer falls back to Node if spawn fails.
  return candidates[0];
}

function registerMediaProtocol(): void {
  protocol.handle('kinetix-media', (request) => {
    try {
      const url = new URL(request.url);
      // kinetix-media://local/<absolute-path-urlencoded>
      const host = decodeURIComponent(url.hostname);
      let filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (host && host !== 'local') {
        filePath = `${host}/${filePath}`;
      }
      if (process.platform === 'win32' && /^[A-Za-z]\//.test(filePath)) {
        filePath = filePath.replace('/', ':/');
        filePath = `/${filePath}`;
      }
      if (!fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      return new Response(`Bad media request: ${err}`, { status: 400 });
    }
  });
}

function mediaUrlFor(absPath: string): string {
  return `kinetix-media://local/${encodeURIComponent(absPath).replace(/%2F/gi, '/')}`;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#08090c',
    title: 'Kinetix Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
    if (fs.existsSync(distIndex)) {
      await mainWindow.loadFile(distIndex);
    } else {
      await mainWindow.loadURL(`http://${KINETIX_HOST}:${KINETIX_PORT}/`);
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function registerIpcHandlers(c: ApiContext): void {
  ipcMain.handle('kinetix:get-initial-state', () => ({
    project: c.store.get(),
    settings: c.settings.get(),
    apiBase: `http://${KINETIX_HOST}:${KINETIX_PORT}`,
    binaries: {
      ffmpeg: c.ffmpeg.binaries.ffmpeg,
      ffprobe: c.ffmpeg.binaries.ffprobe,
    },
  }));

  ipcMain.handle('kinetix:get-settings', () => c.settings.get());
  ipcMain.handle('kinetix:update-settings', async (_e, patch) => c.settings.update(patch));
  ipcMain.handle('kinetix:rotate-api-key', () => c.settings.rotateApiKey());

  ipcMain.handle('kinetix:set-aspect', (_e, ratio: AspectRatio) => c.store.setAspectRatio(ratio));
  ipcMain.handle('kinetix:set-project-name', (_e, name: string) => c.store.setName(name));

  ipcMain.handle('kinetix:add-clip', (_e, clip) => c.store.addClip(clip));
  ipcMain.handle('kinetix:update-clip', (_e, id: string, patch) => c.store.updateClip(id, patch));
  ipcMain.handle('kinetix:remove-clip', (_e, id: string) => c.store.removeClip(id));
  ipcMain.handle('kinetix:replace-timeline', (_e, clips) => c.store.replaceTimeline(clips));
  ipcMain.handle('kinetix:clear-timeline', () => c.store.clearTimeline());
  ipcMain.handle('kinetix:add-asset', (_e, asset) => c.store.addAsset(asset));
  ipcMain.handle('kinetix:remove-asset', (_e, id: string) => c.store.removeAsset(id));

  ipcMain.handle('kinetix:media-url', (_e, absPath: string) => mediaUrlFor(absPath));

  ipcMain.handle('kinetix:import-media', async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Media',
          extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'aac', 'm4a', 'png', 'jpg', 'jpeg'],
        },
      ],
    });
    if (result.canceled) return [];
    const assets = [];
    for (const p of result.filePaths) {
      try {
        const probe = await c.ffmpeg.probe(p);
        assets.push(
          c.store.addAsset({
            name: path.basename(p),
            path: p,
            kind: probe.hasAudio && !probe.hasVideo ? 'audio' : probe.hasVideo ? 'video' : 'image',
            durationSec: probe.durationSec,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            hasAudio: probe.hasAudio,
          })
        );
      } catch {
        assets.push(
          c.store.addAsset({
            name: path.basename(p),
            path: p,
            kind: 'video',
            durationSec: 0,
            hasAudio: true,
          })
        );
      }
    }
    return assets;
  });

  ipcMain.handle('kinetix:probe', async (_e, p: string) => c.ffmpeg.probe(p));

  ipcMain.handle('kinetix:analyze-audio', async (_e, p: string) => {
    const result = await c.analyzer.extractAndAnalyze(p);
    return result;
  });

  ipcMain.handle('kinetix:build-sequence', async (_e, req) => c.builder.build(req));

  ipcMain.handle('kinetix:start-render', async (_e, opts) => {
    const jobId = c.render.enqueueRender(c.store.get(), opts ?? {});
    return jobId;
  });
  ipcMain.handle('kinetix:render-status', (_e, jobId?: string) => c.render.getStatus(jobId));

  ipcMain.handle('kinetix:pick-output', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export MP4',
      defaultPath: 'kinetix-export.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('kinetix:show-item', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('kinetix:open-external', (_e, url: string) => shell.openExternal(url));

  // Aspect helper used by preview for letterbox math parity with the renderer filter.
  ipcMain.handle('aspect-dimensions', (_e, ratio: AspectRatio) => ASPECT_DIMENSIONS[ratio]);
}

app.whenReady().then(() => {
  void bootstrap();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', () => {
  apiServer?.close();
});
