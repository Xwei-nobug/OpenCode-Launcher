/*
 * Bridges the renderer's `launcher.invoke(channel, payload)` calls (the exact
 * surface the Electron build used) onto Tauri commands. Keeping the channel
 * names identical is what lets index.html/app.js run unchanged.
 */
(function () {
  const tauri = window.__TAURI__;
  if (!tauri) {
    document.body.innerHTML =
      '<p style="padding:24px;font:14px system-ui">Tauri 运行时未就绪（缺少 __TAURI__ 全局对象）。</p>';
    return;
  }

  const CHANNELS = {
    "state:get": "state_get",
    "prefs:save": "prefs_save",
    "config:reveal": "config_reveal",
    "path:open": "path_open",
    "project:pick": "project_pick",
    "project:add": "project_add",
    "project:remove": "project_remove",
    "projects:sync": "projects_sync",
    "app:refresh": "app_refresh",
    "project:select": "project_select",
    "project:git": "project_git",
    launch: "launch",
    kill: "kill",
    "running:count": "running_count",
    "sessions:list": "sessions_list",
    "sessions:delete": "sessions_delete",
    "sessions:rename": "sessions_rename",
    "projects:scanned": "projects_scanned",
    "sessions:all": "sessions_all",
    "project:delete": "project_delete",
    "web:status": "web_status",
    "web:start": "web_start",
    "web:open": "web_open",
    "web:open_app": "web_open_app",
    "web:bookmarklet": "web_bookmarklet",
    "web:open_project": "web_open_project",
    "maintenance:status": "maintenance_status",
    "maintenance:install": "maintenance_install",
    "maintenance:uninstall": "maintenance_uninstall",
    "maintenance:uninstallApp": "maintenance_uninstall_app",
    "cache:analyze": "cache_analyze",
    "cache:clear": "cache_clear",
    "log:read": "log_read",
    doctor: "doctor",
  };

  const installListeners = new Set();
  tauri.event.listen("install-line", (e) => {
    installListeners.forEach((cb) => cb(e.payload));
  });

  window.launcher = {
    invoke(channel, payload) {
      const cmd = CHANNELS[channel] || channel.replace(/[^a-z0-9_]/gi, "_");
      return tauri.core.invoke(cmd, { p: payload === undefined ? null : payload });
    },
    onInstallLine(cb) {
      installListeners.add(cb);
      return () => installListeners.delete(cb);
    },
    onTheme(cb) {
      // No nativeTheme in WebView2 — follow the OS and live-update with it.
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const fire = () => cb(mq.matches ? "dark" : "light");
      mq.addEventListener("change", fire);
      fire();
      return () => mq.removeEventListener("change", fire);
    },
    platform: "win32",
  };
})();