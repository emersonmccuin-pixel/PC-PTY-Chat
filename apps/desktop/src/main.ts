// Electron main process — Project Companion desktop shell (Section 10 Phase 1).
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

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

const DEV = process.env.PC_DESKTOP_DEV === '1';
const PORT = Number(process.env.PORT ?? 4040);
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
  // 1.5 wires this to the unpacked `server.mjs` resource:
  //   await import(pathToFileURL(join(process.resourcesPath, 'server', 'server.mjs')).href);
  // For Phase 1.1 the packaged path is not yet built; dev-run is the live mode.
  throw new Error(
    'in-process server hosting not wired until Section 10 Phase 1.5 — run with PC_DESKTOP_DEV=1',
  );
}

async function createWindow(): Promise<void> {
  const url = DEV ? DEV_URL : `http://127.0.0.1:${PORT}`;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
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
