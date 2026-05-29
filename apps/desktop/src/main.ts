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
//   PACKAGED (app.isPackaged)    — Electron starts the agent host as a sibling
//     process, hosts the bundled API server in-process, and loads the server's
//     static bundle on 127.0.0.1:PORT.

import { app, BrowserWindow, Menu, shell } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  packagedAgentHostLockFilePath,
  removePackagedAgentHostLockFile,
  requestPackagedAgentHostShutdown,
  spawnPackagedAgentHostProcess,
  waitForChildExit,
  waitForPackagedAgentHostLock,
} from './agent-host-process';

const DEV = process.env.PC_DESKTOP_DEV === '1';
const APP_NAME = DEV ? 'Caisson Dev' : 'Caisson';
const APP_ID = DEV ? 'com.projectcompanion.app.dev' : 'com.projectcompanion.app';
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
let agentHostProcess: ChildProcess | null = null;
let agentHostLockFile: string | null = null;
let allowingQuitAfterHostShutdown = false;
let stoppingAgentHost = false;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

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
  await startPackagedAgentHost();
  // Importing the bundle runs the full boot sequence (migrations, seeds, the
  // Hono `serve()` + the :8788 channel listener) inside this process. The
  // bundle has top-level await, so this resolves once the server is listening.
  const serverEntry = join(PC_ROOT, 'server.mjs');
  await import(pathToFileURL(serverEntry).href);
}

async function startPackagedAgentHost(): Promise<void> {
  const dataDir = process.env.PC_DATA_DIR ?? app.getPath('userData');
  const lockFilePath = packagedAgentHostLockFilePath(dataDir);
  removePackagedAgentHostLockFile(lockFilePath);
  const startedAt = Date.now();
  const { child, spec } = spawnPackagedAgentHostProcess({
    pcRoot: PC_ROOT,
    dataDir,
    execPath: process.execPath,
    env: process.env,
  });
  agentHostProcess = child;
  agentHostLockFile = spec.lockFilePath;

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
  child.once('exit', (code, signal) => {
    agentHostProcess = null;
    if (stoppingAgentHost || allowingQuitAfterHostShutdown) return;
    console.error(
      `[agent-host] packaged host exited unexpectedly: code=${code ?? 'null'} signal=${signal ?? 'none'}`,
    );
  });

  const ready = await waitForPackagedAgentHostLock({
    lockFilePath: agentHostLockFile,
    startedAt,
  });
  if (!ready) {
    stoppingAgentHost = true;
    child.kill();
    throw new Error('packaged agent host did not publish its lock file before server boot');
  }
}

async function stopPackagedAgentHost(): Promise<void> {
  const child = agentHostProcess;
  if (!child) return;
  stoppingAgentHost = true;

  if (agentHostLockFile) {
    await requestPackagedAgentHostShutdown({ lockFilePath: agentHostLockFile });
  }
  if (await waitForChildExit(child, 2_000)) return;
  child.kill();
  await waitForChildExit(child, 2_000);
}

async function createWindow(): Promise<void> {
  const url = DEV ? DEV_URL : `http://127.0.0.1:${PORT}`;
  const windowIcon = join(__dirname, '..', 'build', DEV ? 'icon-dev.png' : 'icon.png');

  // No native File/Edit/View/Window menu — PC's chrome is the web UI. Removing
  // the application menu also drops its default accelerators; copy/paste/etc.
  // still work via Chromium's built-in editing handling in the renderer.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    icon: windowIcon,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow?.setTitle(APP_NAME);
  });

  // Reload affordances. The app menu is nulled (above) which also drops the
  // default Ctrl+R / F5 accelerators, leaving no way to refresh the renderer.
  // Add them back via raw key input plus a right-click context menu.
  const { webContents } = mainWindow;
  webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const isReload = key === 'f5' || (input.control && key === 'r');
    if (!isReload) return;
    if (input.shift) webContents.reloadIgnoringCache();
    else webContents.reload();
  });
  webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: 'Reload', click: () => webContents.reload() },
      { label: 'Force Reload', click: () => webContents.reloadIgnoringCache() },
    ]).popup({ window: mainWindow ?? undefined });
  });

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

app.on('before-quit', (event) => {
  if (DEV || allowingQuitAfterHostShutdown || !agentHostProcess) return;
  event.preventDefault();
  if (stoppingAgentHost) return;
  void stopPackagedAgentHost().finally(() => {
    allowingQuitAfterHostShutdown = true;
    app.quit();
  });
});
