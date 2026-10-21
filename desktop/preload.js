"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Explicit allowlist: the renderer can only call what the main process
// actually implements — no arbitrary IPC passthrough.
const INVOKE = new Set([
  "state:get",
  "prefs:save",
  "config:reveal",
  "path:open",
  "project:pick",
  "project:add",
  "project:remove",
  "projects:sync",
  "app:refresh",
  "project:select",
  "project:git",
  "launch",
  "kill",
  "running:count",
  "sessions:list",
  "sessions:delete",
  "sessions:rename",
  "projects:scanned",
  "project:delete",
  "sessions:all",
  "web:status",
  "web:start",
  "web:open",
  "web:open_app",
  "web:bookmarklet",
  "web:open_project",
  "web:sync",
  "maintenance:status",
  "maintenance:install",
  "maintenance:uninstall",
  "maintenance:uninstallApp",
  "cache:analyze",
  "cache:clear",
  "log:read",
  "doctor",
]);

contextBridge.exposeInMainWorld("launcher", {
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) {
      return Promise.reject(new Error(`unknown channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onInstallLine(cb) {
    const fn = (_e, text) => cb(text);
    ipcRenderer.on("install:line", fn);
    return () => ipcRenderer.removeListener("install:line", fn);
  },
  onTheme(cb) {
    const fn = (_e, theme) => cb(theme);
    ipcRenderer.on("theme:changed", fn);
    return () => ipcRenderer.removeListener("theme:changed", fn);
  },
  platform: process.platform,
});
