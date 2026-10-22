"use strict";

/**
 * Electron main process.
 *
 * The window is a real desktop window (no browser, no Edge profile, no sync
 * prompts). All backend work lives in core/core.js — the process/terminal
 * logic that was already hardened in the previous single-file build — and is
 * exposed to the renderer through a narrow IPC surface defined below.
 *
 * Lifecycle contract (deliberate, and a user requirement):
 *   - closing the window quits the launcher;
 *   - quitting the launcher NEVER ends opencode sessions;
 *   - only the "关闭 opencode" action ends them (all of them).
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const core = require("./core/core");

const APP_NAME = "opencode 启动器";
const isDev = !app.isPackaged;

let win = null;

/* ------------------------------------------------------------ single copy --- */

// A second launch focuses the window that already exists instead of starting a
// second copy (two copies would race on the config file).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

/* ----------------------------------------------------------------- window --- */

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#15181d" : "#f5f6f8",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    win = null;
  });

  // Open external links in the default browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  core.log(`app start version=${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node}`);
  core.cleanupRunScripts();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Quitting here is intentional: opencode sessions are detached and keep
  // running (never kill them on exit), the launcher just goes away.
  app.quit();
});

nativeTheme.on("updated", () => {
  win?.webContents.send("theme:changed", nativeTheme.shouldUseDarkColors ? "dark" : "light");
});

/* -------------------------------------------------------------------- IPC --- */

const handle = (channel, fn) => ipcMain.handle(channel, (_e, payload) => fn(payload));

/** Everything the window needs on first paint. */
handle("state:get", async () => {
  const cfg = core.readConfig();
  const oc = core.locateOpencode();
  const npm = await core.resolveNpm().catch(() => "");
  const [current, major, running] = await Promise.all([
    core.installedVersion().catch(() => ""),
    core.opencodeMajor().catch(() => 0),
    core.isLaunchedRunning().catch(() => false),
  ]);
  return {
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      isDev,
    },
    paths: {
      dataDir: core.dataDir(),
      config: core.configPath(),
      log: core.logPath(),
      db: core.opencodeDbPath(),
      ocLog: core.opencodeLogDir(),
    },
    config: cfg,
    opencode: {
      found: oc.found,
      path: oc.path,
      current: current || "",
      major: major || 0,
      npmPkg: core.opencodeNpmPkg(),
      npm,
      running,
    },
    terminals: {
      wt: core.hasWindowsTerminal(),
    },
  };
});

handle("prefs:save", (prefs) => {
  const cfg = core.readConfig();
  cfg.prefs = { ...cfg.prefs, ...(prefs || {}) };
  // Per-launch choices never persist (they only make sense for one directory).
  delete cfg.prefs.session;
  delete cfg.prefs.continueSession;
  core.writeConfig(cfg);
  return { ok: true };
});

handle("config:reveal", async () => {
  await shell.openPath(core.dataDir());
  return { ok: true };
});

handle("path:open", async (p) => {
  const target = String(p || "");
  if (!target) return { ok: false, error: "路径为空" };
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
});

/* ----- projects ----- */

handle("project:pick", async (startDir) => {
  const r = await dialog.showOpenDialog(win, {
    title: "选择 opencode 项目目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: startDir || core.readConfig().lastProject || app.getPath("home"),
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
  const dir = r.filePaths[0];
  const cfg = core.readConfig();
  if (!cfg.projects.some((p) => core.pathKey(p.path) === core.pathKey(dir))) {
    cfg.projects.unshift({ path: dir, name: path.basename(dir) || dir, addedAt: Date.now() });
  }
  cfg.lastProject = dir;
  core.writeConfig(cfg);
  return { ok: true, dir, marker: core.isProjectDir(dir), config: core.readConfig() };
});

handle("project:add", async (dir) => {
  const target = String(dir || "").trim();
  if (!target) return { ok: false, error: "请填写项目目录" };
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return { ok: false, error: `目录不存在：${target}` };
  }
  if (!st.isDirectory()) return { ok: false, error: `不是目录：${target}` };
  const cfg = core.readConfig();
  if (!cfg.projects.some((p) => core.pathKey(p.path) === core.pathKey(target))) {
    cfg.projects.unshift({ path: target, name: path.basename(target) || target, addedAt: Date.now() });
  }
  cfg.lastProject = target;
  core.writeConfig(cfg);
  // Register right away so the web UI and terminal see it without waiting for
  // the next reconciliation pass.
  await core.ensureServiceProject(target).catch(() => null);
  return { ok: true, config: core.readConfig() };
});

handle("project:remove", async (dir) => {
  const target = String(dir || "");
  const cfg = core.readConfig();
  cfg.projects = cfg.projects.filter((p) => core.pathKey(p.path) !== core.pathKey(target));
  if (cfg.projects.length === 0) cfg.lastProject = "";
  else if (core.pathKey(cfg.lastProject) === core.pathKey(target)) {
    cfg.lastProject = cfg.projects[0].path;
  }
  core.writeConfig(cfg);
  // Drop the service-side row too, otherwise the next reconciliation would see
  // a project the service still knows and add it straight back. This also
  // removes that project's sessions, which is what "delete the project" means
  // everywhere else in opencode.
  const svc = await core.deleteServiceProjectByPath(target).catch(() => ({ removed: false }));
  return { ok: true, config: core.readConfig(), serviceRemoved: !!(svc && svc.removed) };
});

handle("projects:sync", () => core.syncProjectRegistry());

/**
 * Manual refresh: reconcile with opencode, drop every cached session list, and
 * let the renderer repaint both the project view and the records view.
 */
handle("app:refresh", async () => {
  const sync = await core.syncProjectRegistry().catch(() => null);
  core.invalidateSessions();
  return { ok: true, sync };
});

handle("project:select", async (dir) => {
  const target = String(dir || "");
  const cfg = core.readConfig();
  cfg.lastProject = target;
  core.writeConfig(cfg);
  const [git, sessions] = await Promise.all([
    core.gitStatus(target).catch(() => null),
    core.listSessions(target).catch(() => ({ ok: false, sessions: [] })),
  ]);
  return { ok: true, dir: target, marker: core.isProjectDir(target), git, sessions, config: core.readConfig() };
});

handle("project:git", (dir) => core.gitStatus(String(dir || "")).catch((e) => ({ ok: false, error: String(e) })));

/* ----- launch / kill ----- */

handle("launch", async (opts) => {
  const cfg = core.readConfig();
  // No project picked means "open the default": the last project, or the home
  // directory when there is none yet.
  const dir = path.normalize(String((opts && opts.dir) || cfg.lastProject || os.homedir()));
  const prefs = { ...cfg.prefs, ...((opts && opts.opts) || {}) };
  const terminal = (opts && opts.terminal) || prefs.terminal || "auto";
  const result = await core.launch({ ...prefs, dir, terminal });
  if (result.ok) {
    cfg.lastProject = dir;
    const persist = { ...prefs };
    delete persist.session;
    delete persist.continueSession;
    cfg.prefs = persist;
    core.writeConfig(cfg);
  }
  return { ...result, dir };
});

handle("kill", async () => {
  // "Close opencode" means everything it opened: every terminal pane the
  // launcher spawned, and the built-in web window. Leaving that window alive
  // would show a dead app the moment the service goes away.
  const r = await core.killLaunched();
  const web = closeWebWindow();
  return { ...r, web };
});

handle("running:count", async () => {
  const list = await core.listLaunches().catch(() => []);
  const webWinOpen = !!(webWin && !webWin.isDestroyed());
  // An open window is not a running service: if opencode died while the window
  // stayed open, the page can only show "Failed to fetch". Ask the service.
  const web = webWinOpen ? await core.webAlive().catch(() => false) : false;
  return { count: list.length + (web ? 1 : 0), sessions: list, web, webWin: webWinOpen };
});

/* ----- sessions ----- */

handle("sessions:list", async (dir) => {
  const target = String(dir || core.readConfig().lastProject || "");
  if (!target) return { ok: false, reason: "请先选择项目目录", sessions: [] };
  return core.listSessions(target, { refresh: true }).catch((e) => ({
    ok: false,
    reason: String((e && e.message) || e),
    sessions: [],
  }));
});

handle("sessions:delete", async (id) => {
  const sid = String(id || "").trim();
  if (!sid) return { ok: false, error: "会话 ID 为空" };
  // deleteSession reports failure in its return value rather than throwing —
  // returning {ok:true} unconditionally used to hide a failed delete.
  const r = await core.deleteSession(sid);
  if (r && r.ok) core.invalidateSessions();
  return r || { ok: false, error: "删除失败" };
});

handle("sessions:rename", async (payload) => {
  const { id, title } = payload || {};
  try {
    const r = await core.renameSession(id, title);
    return r || { ok: false, error: "重命名失败" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ----- all records ----- */

handle("projects:scanned", async () => core.listScannedProjects());
handle("project:delete", async (id) => core.deleteProject(id));

handle("sessions:all", async () => core.listAllSessions());

/* ----- web ----- */

handle("web:status", async () => core.webStatus());

handle("web:start", async () => {
  const r = await core.webStart();
  if (r && r.ok && r.url) {
    await shell.openExternal(r.url).catch(() => {});
  }
  return r;
});

handle("web:open_project", async (dir) => {
  const r = await core.webOpenProject(dir);
  if (!r || !r.ok) return r || { ok: false, error: "无法在 Web 版中打开该项目" };
  return r;
});

handle("web:sync", async () => {
  const r = await core.webSyncProjects();
  if (!r || !r.ok) return r || { ok: false, error: "同步失败" };
  if (r.open && r.open.url) await shell.openExternal(r.open.url).catch(() => {});
  return r;
});

handle("web:open", async () => {
  const r = await core.webOpenUrl();
  if (!r || !r.ok) return r || { ok: false, error: "无法启动 opencode 服务" };
  await shell.openExternal(r.url).catch(() => {});
  return r;
});

/* ----- web (built-in window) ----- */

// One window only: opening the web UI twice reuses it and tops up the project
// list instead of paying for a second renderer.
let webWin = null;

/**
 * Close the built-in web window, if one is open.
 *
 * Returns true when a window was actually destroyed, so the caller can report
 * whether "close opencode" had a web surface to take down.
 */
function closeWebWindow() {
  if (!webWin || webWin.isDestroyed()) {
    webWin = null;
    return false;
  }
  const w = webWin;
  webWin = null;
  w.destroy();
  return true;
}

/**
 * Take the one-time session cookie out of a pairing link.
 *
 * A browser navigation to the link answers with a 302 into the app plus a
 * `Set-Cookie` header. Following that redirect inside the window turned out to
 * be unreliable (Electron reports ERR_FAILED on every open after the first),
 * so the cookie is collected in the main process and the app is loaded
 * directly instead — one request, no in-window redirect.
 */
async function primeWebSession(link, base, ses) {
  try {
    const res = await fetch(link, { headers: { Accept: "text/html" }, redirect: "manual" });
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const pair = String(line).split(";")[0];
      const at = pair.indexOf("=");
      if (at < 0) continue;
      await ses.cookies.set({
        url: base,
        name: pair.slice(0, at).trim(),
        value: pair.slice(at + 1).trim(),
        path: "/",
        httpOnly: true,
        sameSite: "lax",
      });
    }
    return raw.length > 0;
  } catch {
    return false;
  }
}

/**
 * Create (or reuse) the built-in window that shows the opencode web UI, and
 * seed its workspace panel with the service's project list.
 *
 * The panel is backed by browser localStorage, not by the server's project
 * table, so the list has to be written from inside the page — `webSeedScript`
 * does that and reloads once when anything moved.
 *
 * Returns true when a new window was created.
 */
async function openWebWindow(link, base, dirs, reload) {
  const script = core.webSeedScript(dirs);

  if (webWin && !webWin.isDestroyed()) {
    webWin.show();
    webWin.focus();
    if (reload) {
      // The service had been down, so this page is a dead shell — reload it
      // once it can talk to the backend again, then top up the project list.
      webWin.webContents.once("did-finish-load", () => {
        if (script) webWin.webContents.executeJavaScript(script, true).catch(() => {});
      });
      webWin.webContents.reload();
    } else if (script) {
      webWin.webContents.executeJavaScript(script, true).catch(() => {});
    }
    return false;
  }

  const w = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 920,
    minHeight: 620,
    title: "opencode Web",
    autoHideMenuBar: true,
    backgroundColor: "#fafafa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  webWin = w;
  w.on("closed", () => {
    if (webWin === w) webWin = null;
  });
  // External links belong in the default browser, same as the launcher window.
  w.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target).catch(() => {});
    return { action: "deny" };
  });

  let seeded = false;
  w.webContents.on("did-finish-load", async () => {
    if (seeded) return;
    // Falling back to the pairing link: wait until the redirect lands.
    if (/\/auth\/connect\//.test(w.webContents.getURL())) return;
    seeded = true;
    if (!script) return;
    try {
      await w.webContents.executeJavaScript(script, true);
    } catch {
      /* seeding is best effort: never block the web UI */
    }
  });

  // A service worker left behind by an earlier session keeps intercepting the
  // navigation and Electron reports it as ERR_FAILED, so drop it before load.
  try {
    await w.webContents.session.clearStorageData({ storages: ["serviceworkers", "cachestorage"] });
  } catch {
    /* nothing to clear */
  }

  const primed = await primeWebSession(link, base, w.webContents.session);
  await w.loadURL(primed && base ? base : link).catch(() => {});
  return true;
}

/**
 * Open the web UI in the built-in window with the workspace panel in sync.
 *
 * The library is registered first so folders the service has never seen still
 * show up; `webProjectDirs` then reads back the authoritative list, which is
 * the same one the settings page renders.
 */
handle("web:open_app", async () => {
  const open = await core.webOpenUrl();
  if (!open || !open.ok) return open || { ok: false, error: "无法启动 opencode 服务" };
  // Reconcile first: projects created in the web UI or the terminal land in the
  // library, and library entries the service dropped disappear from it.
  const sync = await core.syncProjectRegistry().catch(() => null);
  const dirs = await core.webSeedDirs().catch(() => []);
  const created = await openWebWindow(open.url, open.base, dirs, open.started);
  return {
    ok: true,
    url: open.base,
    started: open.started,
    projects: dirs.length,
    sync,
    created,
  };
});

/** Script body for the one-click bookmarklet used with a normal browser. */
handle("web:bookmarklet", async () => {
  const body = core.webBookmarkletBody();
  if (!body) return { ok: false, error: "无法生成同步书签" };
  return { ok: true, body };
});

/* ----- maintenance ----- */

handle("maintenance:status", async () => {
  const npm = await core.resolveNpm().catch(() => "");
  const pkg = core.opencodeNpmPkg();
  const [current, major, latest] = await Promise.all([
    core.installedVersion({ refresh: true }).catch(() => ""),
    core.opencodeMajor({ refresh: true }).catch(() => 0),
    core.latestVersion(npm, pkg).catch(() => ""),
  ]);
  return { current, major, latest, npm, pkg };
});

handle("maintenance:install", async () => {
  const send = (text) => win?.webContents.send("install:line", text);
  try {
    const r = await core.installOpencode(send);
    core.invalidateOpencodeCache();
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

handle("maintenance:uninstall", async () => {
  const send = (text) => win?.webContents.send("install:line", text);
  try {
    const r = await core.uninstallOpencode(send);
    core.invalidateOpencodeCache();
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

handle("maintenance:uninstallApp", async () => {
  // Hand the job to the NSIS uninstaller this app was installed with.
  const exeDir = path.dirname(app.getPath("exe"));
  const candidates = fs.readdirSync(exeDir).filter((f) => /^uninstall.*\.exe$/i.test(f));
  if (!candidates.length) return { ok: false, error: "未找到卸载程序（绿色运行模式无法卸载）" };
  const un = path.join(exeDir, candidates[0]);
  const { spawn } = require("node:child_process");
  const child = spawn(un, ["/currentuser"], { detached: true, stdio: "ignore" });
  child.unref();
  setTimeout(() => app.quit(), 400);
  return { ok: true };
});

/* ----- cache / log / doctor ----- */

handle("cache:analyze", () => core.analyzeCache());
handle("cache:clear", (targets) => core.clearCache(Array.isArray(targets) ? targets : []));

handle("log:read", () => {
  const p = core.logPath();
  try {
    const text = fs.readFileSync(p, "utf8");
    return { ok: true, path: p, text };
  } catch (e) {
    return { ok: false, path: p, text: "", error: String((e && e.message) || e) };
  }
});

handle("doctor", async () => {
  const lines = [];
  const r = await core.runDoctor((t) => lines.push(t));
  return { ...r, log: lines.join("") };
});
