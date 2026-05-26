// Electron main process — Caisson desktop shell (Section 10 Phase 1).
//
// Two run modes, deliberately kept apart so the dev stack's native-module ABI
// (Node) is never disturbed by Electron's ABI:
//
//   DEV-RUN  (PC_DESKTOP_DEV=1)  — the window points at the already-running
//     tsx server / Vite dev server. Electron does NOT host the server, so it
//     never loads better-sqlite3 / node-pty → no @electron/rebuild needed, and
//     `pnpm dev` keeps working untouched. This is the iteration mode for the
//     shell itself.
//
//   PACKAGED (app.isPackaged)    — Electron hosts the bundled server in-process
//     (Electron-ABI natives, rebuilt at package time) and the window loads the
//     server's own static bundle on 127.0.0.1:PORT. Wired in 1.5; the hook is
//     stubbed here so the shape is visible.

import { app, BrowserWindow, Menu, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEV = process.env.PC_DESKTOP_DEV === '1';
const PORT = Number(process.env.PORT ?? 4040);
// Packaged resource root (electron-builder `extraResources` → `pcserver/`).
// Mirrors the repo's sub-paths so the server's ROOT-relative resolution
// (apps/web/dist, templates, packages/mcp/dist, channel-server) just works.
const PC_ROOT = join(process.resourcesPath, 'pcserver');
// Dev-run target: default to Vite (:5173 — the live UI the user develops
// against; it proxies /api + /ws to :4040). Override with PC_DESKTOP_URL to
// hit the server's own static fallback on :4040 directly.
const DEV_URL = process.env.PC_DESKTOP_URL ?? 'http://127.0.0.1:5173';

let mainWindow: BrowserWindow | null = null;

/**
 * Boot the Hono/channel server inside this process. Packaged-mode only —
 * loads the esbuild server bundle (1.5) by file path so there's no dependency
 * on tsx at runtime. Env (PC_DATA_DIR, ports) is set by the caller first.
 */
async function startInProcessServer(): Promise<void> {
  // The server reads all its paths from env + ROOT (PC_ROOT). Set them before
  // importing the bundle — index.ts captures them at module-eval time.
  process.env.PC_ROOT = PC_ROOT;
  process.env.PC_DATA_DIR ??= app.getPath('userData'); // 1.3 — per-user data dir
  process.env.PORT ??= String(PORT);
  process.env.CHANNEL_PORT ??= '8788';
  // Importing the bundle runs the full boot sequence (migrations, seeds, the
  // Hono `serve()` + the :8788 channel listener) inside this process. The
  // bundle has top-level await, so this resolves once the server is listening.
  const serverEntry = join(PC_ROOT, 'server.mjs');
  await import(pathToFileURL(serverEntry).href);
}

async function createWindow(): Promise<void> {
  const url = DEV ? DEV_URL : `http://127.0.0.1:${PORT}`;

  // No native File/Edit/View/Window menu — PC's chrome is the web UI. Removing
  // the application menu also drops its default accelerators; copy/paste/etc.
  // still work via Chromium's built-in editing handling in the renderer.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    icon: join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the system browser, not a new Electron window
  // (the OAuth login flow during onboarding relies on this — Phase 2).
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

void app.whenReady().then(async () => {
  if (!DEV) {
    // PC_DATA_DIR is set in packaged mode (1.3) before the server boots.
    await startInProcessServer();
  }
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
