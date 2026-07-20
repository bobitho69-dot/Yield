// Yield for desktop — an Electron shell around the hosted Yield workspace.
// It opens Yield Code by default and offers native menu items to jump between
// Code, Chat, and the app builder. Because it loads the live web app, everything
// (GitHub OAuth, agents, MCP config, the multi-model backend) works exactly as it
// does in the browser — plus a proper app window, menu bar, and deep-linking.
//
// Point it at your own deployment with the YIELD_URL env var, or edit APP_URL below.

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');

// The Yield deployment the desktop app loads. Override at runtime:  YIELD_URL=https://your-yield.workers.dev
const APP_URL = (process.env.YIELD_URL || 'https://yield.example.workers.dev').replace(/\/+$/, '');
const ROUTES = { code: '/code', chat: '/chat', build: '/app', security: '/security', download: '/download' };

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0c11',
    title: 'Yield',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  go('code');

  // Open external links (github.com, docs, download) in the user's real browser,
  // but keep Yield navigation inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isYieldUrl(url)) { win.loadURL(url); return { action: 'deny' }; }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isYieldUrl(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  // Friendly offline / unreachable-deployment message instead of a blank window.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return; // aborted (normal during redirects)
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Can’t reach Yield',
      message: 'Yield couldn’t be reached.',
      detail: `Tried to load ${url}\n(${desc}).\n\nCheck your internet connection, or set YIELD_URL to your own Yield deployment and relaunch.`,
      buttons: ['Retry', 'OK'],
      defaultId: 0,
    }).then((r) => { if (r.response === 0) win.reload(); });
  });
}

function isYieldUrl(url) {
  try { return new URL(url).origin === new URL(APP_URL).origin; } catch { return false; }
}
function go(route) {
  if (!win) return;
  win.loadURL(APP_URL + (ROUTES[route] || '/'));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => go('chat') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Yield Code', accelerator: 'CmdOrCtrl+1', click: () => go('code') },
        { label: 'Yield Chat', accelerator: 'CmdOrCtrl+2', click: () => go('chat') },
        { label: 'App Builder', accelerator: 'CmdOrCtrl+3', click: () => go('build') },
        { label: 'Security', accelerator: 'CmdOrCtrl+4', click: () => go('security') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => win && win.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => win && win.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
      ],
    },
    { role: 'editMenu' },
    {
      role: 'viewMenu',
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Yield on the web', click: () => shell.openExternal(APP_URL) },
        { label: 'Documentation', click: () => shell.openExternal(APP_URL + '/api/docs') },
        { label: 'Report an issue', click: () => shell.openExternal('https://github.com/bobitho69-dot/yield/issues') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
