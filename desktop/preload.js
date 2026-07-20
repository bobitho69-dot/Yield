// Preload — runs before the Yield web app loads, in an isolated context.
// It exposes a tiny, safe marker so the web app can tell it's running inside the
// Yield desktop shell (e.g. to show "Get the app" only on the web). No Node APIs
// are leaked to the page; contextIsolation stays on.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('yieldDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
});
