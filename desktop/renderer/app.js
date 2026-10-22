"use strict";

/**
 * Renderer. All backend work goes through the preload bridge ("launcher").
 * No framework — the app is small and the state is explicit.
 *
 * Information architecture: projects and sessions are ONE view. A project row
 * expands in place to list its sessions (each with a delete button), so the
 * user never has to switch panes to see what a project contains.
 */

const $ = (id) => document.getElementById(id);
const api = (channel, payload) => window.launcher.invoke(channel, payload);

const CHEV =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

const state = {
  ready: false,
  config: { projects: [], prefs: {}, lastProject: "" },
  app: {},
  paths: {},
  opencode: {},
  currentDir: "",
  view: "projects",
  git: null,
  // path -> { status: "loading" | "ok" | "error", sessions: [], reason: "" }
  sessionsByProject: {},
  expanded: new Set(),
  // path -> session id the user picked with the radio button (launch resumes it)
  selectedSession: new Map(),
  cache: null,
  running: 0,
  maintenanceLoaded: false,
  recordsLoaded: false,
  // All sessions / projects opencode knows about (not just the added ones).
  allSessions: [],
  allProjects: [],
  recordsFilter: "",
  busy: false,
};

/* ---------------------------------------------------------------- helpers --- */

function toast(text, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .2s ease";
    setTimeout(() => el.remove(), 220);
  }, kind === "err" ? 4200 : 2600);
}

async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } finally {
    if (btn) btn.disabled = false;
  }
}

const fmtSize = (n) => {
  const v = Number(n) || 0;
  if (v >= 1 << 30) return (v / (1 << 30)).toFixed(2) + " GB";
  if (v >= 1 << 20) return (v / (1 << 20)).toFixed(1) + " MB";
  if (v >= 1 << 10) return (v / (1 << 10)).toFixed(0) + " KB";
  return v + " B";
};

const fmtTime = (ms) => {
  const t = Number(ms) || 0;
  if (!t) return "—";
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
};

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------------- boot --- */

async function boot() {
  const s = await api("state:get");
  state.app = s.app;
  state.paths = s.paths;
  state.config = s.config;
  state.opencode = s.opencode;
  state.currentDir = s.config.lastProject || "";

  $("appVersion").textContent = s.app.version;
  $("ocVersion").textContent = s.opencode.current || "未安装";
  $("verElectron").textContent = s.app.electron;
  $("verNode").textContent = s.app.node;
  $("pathData").textContent = s.paths.dataDir;
  $("pathLog").textContent = s.paths.log;
  $("pathDb").textContent = s.paths.db;
  $("pathOcLog").textContent = s.paths.ocLog;

  applyTheme(s.app.theme);
  window.launcher.onTheme(applyTheme);
  window.launcher.onInstallLine((text) => {
    const box = $("installLog");
    box.hidden = false;
    box.textContent += text;
    box.scrollTop = box.scrollHeight;
  });

  bind();
  renderHero();

  if (state.currentDir) {
    state.expanded.add(state.currentDir);
    await selectProject(state.currentDir, { silent: true });
  } else {
    renderProjects();
  }

  state.ready = true;
  refreshRunning();

  // Reconcile with opencode in the background: a project created (or deleted)
  // in the web UI or the terminal should show up here without a manual refresh.
  syncProjectsQuietly();
}

/**
 * Pull the library in line with opencode's project table, then repaint once if
 * anything moved. Failures are swallowed — a stale list is better than a
 * startup error, and the next action retries anyway.
 */
async function syncProjectsQuietly() {
  try {
    const r = await api("projects:sync");
    if (!r || !r.ok) return;
    const added = (r.added || []).length;
    const dropped = (r.dropped || []).length;
    const renamed = (r.renamed || []).length;
    if (!added && !dropped && !renamed) return;

    const s = await api("state:get");
    state.config = s.config;
    renderProjects();
    renderHero();

    const bits = [];
    if (added) bits.push(`新增 ${added} 个`);
    if (dropped) bits.push(`移除 ${dropped} 个`);
    if (renamed) bits.push(`改名 ${renamed} 个`);
    toast(`项目库已与 opencode 同步：${bits.join("、")}`, "ok");
  } catch {
    /* best effort */
  }
}

/**
 * Manual refresh: reconcile with opencode, drop every cached session list, then
 * repaint the project view and the records view in one go.
 */
async function refreshAll() {
  const r = await api("app:refresh");
  const s = await api("state:get");
  state.config = s.config;
  state.opencode = s.opencode;

  for (const dir of Object.keys(state.sessionsByProject)) delete state.sessionsByProject[dir];
  if (state.currentDir) ensureSessions(state.currentDir, true);
  renderProjects();
  renderHero();
  await loadRecords(true);

  const sync = (r && r.sync) || {};
  const bits = [];
  for (const [key, label] of [
    ["added", "新增"],
    ["dropped", "移除"],
    ["renamed", "改名"],
  ]) {
    const n = (sync[key] || []).length;
    if (n) bits.push(`${label} ${n} 个`);
  }
  toast(bits.length ? `已刷新：${bits.join("、")}` : "已刷新", "ok");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

/* ------------------------------------------------------------------- view --- */

function showView(name) {
  state.view = name;
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  for (const v of ["projects", "records", "maintenance", "settings"]) {
    $("view-" + v).hidden = v !== name;
  }
  if (name === "records" && !state.recordsLoaded) {
    state.recordsLoaded = true;
    loadRecords();
  }
  if (name === "maintenance" && !state.maintenanceLoaded) {
    state.maintenanceLoaded = true;
    checkVersions();
    loadCache();
  }
}

function bind() {
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

  $("btnAddProject").addEventListener("click", () => withBusy($("btnAddProject"), addProjectViaDialog));
  $("btnKill").addEventListener("click", () => withBusy($("btnKill"), doKill));
  $("btnRevealProject").addEventListener("click", () => openPath(state.currentDir));
  $("btnGitRefresh").addEventListener("click", () => refreshGit());

  $("btnWeb").addEventListener("click", () => withBusy($("btnWeb"), openWeb));
  $("btnRefresh").addEventListener("click", () => withBusy($("btnRefresh"), refreshAll));
  $("btnRecordsRefresh").addEventListener("click", () => withBusy($("btnRecordsRefresh"), () => loadRecords(true)));
  $("recordsFilter").addEventListener("input", (e) => {
    state.recordsFilter = e.target.value.trim().toLowerCase();
    renderRecords();
  });

  $("btnCheckVersion").addEventListener("click", () => withBusy($("btnCheckVersion"), checkVersions));
  $("btnInstall").addEventListener("click", () => withBusy($("btnInstall"), () => installOpencode(false)));
  $("btnUpdate").addEventListener("click", () => withBusy($("btnUpdate"), () => installOpencode(true)));
  $("btnUninstallOc").addEventListener("click", () => withBusy($("btnUninstallOc"), uninstallOpencode));

  $("btnCacheRefresh").addEventListener("click", () => withBusy($("btnCacheRefresh"), loadCache));
  $("btnCacheClear").addEventListener("click", () => withBusy($("btnCacheClear"), clearCache));
  $("btnDoctor").addEventListener("click", () => withBusy($("btnDoctor"), runDoctor));

  $("prefTerminal").addEventListener("change", savePrefs);
  $("prefExtra").addEventListener("change", savePrefs);
  document.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => {
      const map = {
        dataDir: state.paths.dataDir,
        logFile: state.paths.log,
        dbFile: state.paths.db,
        ocLog: state.paths.ocLog,
      };
      openPath(map[b.dataset.open]);
    })
  );
  $("btnUninstallApp").addEventListener("click", uninstallApp);

  // The "running" chip is refreshed on the events that can change it (launch,
  // kill, window focus) instead of on a timer: every poll walks the process
  // table, which is expensive enough to make clicks feel sticky when it fires
  // in the middle of an interaction.
  let lastRunCheck = 0;
  const refreshRunningThrottled = () => {
    if (Date.now() - lastRunCheck < 8000) return;
    lastRunCheck = Date.now();
    refreshRunning();
  };
  window.addEventListener("focus", refreshRunningThrottled);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshRunningThrottled();
  });
}

/* ------------------------------------------------------ projects + sessions --- */

function projectNode(path) {
  return [...document.querySelectorAll("#projectList .project-node")].find((n) => n.dataset.path === path) || null;
}

/** Fill one project's session box in place — no list rebuild. */
function paintSessionBox(path) {
  const node = projectNode(path);
  if (!node) return;
  let box = node.querySelector(".session-box");
  if (!box) {
    box = document.createElement("div");
    box.className = "session-box";
    node.appendChild(box);
  }
  box.hidden = !state.expanded.has(path);
  const info = state.sessionsByProject[path];
  box.innerHTML = "";
  if (!info || info.status === "loading") {
    box.innerHTML = `<div class="session-loading">正在读取会话…</div>`;
    return;
  }
  if (info.status === "error") {
    box.innerHTML = `<div class="session-empty">${esc(info.reason || "读取会话失败")}</div>`;
    return;
  }
  if (!info.sessions.length) {
    box.innerHTML = `<div class="session-empty">该项目还没有 opencode 会话。</div>`;
    return;
  }
  const idx = (state.config.projects || []).findIndex((p) => p.path === path);
  for (const s of info.sessions) box.appendChild(sessionRow(path, s, `pick-${idx}`));
  paintRowState(path);
}

/** Update one row's count badge and launch label in place. */
function paintRowState(path) {
  const node = projectNode(path);
  if (!node) return;
  const row = node.querySelector(".project-row");
  if (!row) return;
  const info = state.sessionsByProject[path];
  let badge = row.querySelector(".p-count");
  const text = info && info.status === "ok" ? `${info.sessions.length} 个会话` : "";
  if (!text) {
    if (badge) badge.remove();
  } else if (badge) {
    badge.textContent = text;
  } else {
    badge = document.createElement("span");
    badge.className = "p-count";
    badge.textContent = text;
    row.querySelector(".item-actions").before(badge);
  }
  const picked = state.selectedSession.get(path) || "";
  const launch = row.querySelector('[data-act="launch"]');
  if (launch) {
    launch.textContent = picked ? "终端打开 · 续接" : "终端打开";
    launch.title = picked ? "续接选中的会话" : "启动一个新会话";
  }
}


function ensureSessions(path, force = false) {
  const info = state.sessionsByProject[path];
  if (!force && info && (info.status === "ok" || info.status === "loading")) return Promise.resolve();
  // Only the box is repainted — a background refresh keeps the current rows on
  // screen instead of blanking the whole list for a moment.
  state.sessionsByProject[path] = { status: "loading", sessions: [], reason: "" };
  paintSessionBox(path);
  return api("sessions:list", path)
    .then((r) => {
      state.sessionsByProject[path] = {
        status: r.ok ? "ok" : "error",
        sessions: r.sessions || [],
        reason: r.reason || "",
      };
    })
    .catch((e) => {
      state.sessionsByProject[path] = { status: "error", sessions: [], reason: String((e && e.message) || e) };
    })
    .then(() => paintSessionBox(path));
}

/**
 * Expand / collapse one project. Pure DOM work: the node keeps its session box
 * and only the `open` class and `hidden` flag change, so the list is never
 * rebuilt (rebuilding it on every click is what made this feel sticky).
 */
function toggleExpand(path) {
  const node = projectNode(path);
  if (state.expanded.has(path)) {
    state.expanded.delete(path);
    if (node) {
      node.classList.remove("open");
      const box = node.querySelector(".session-box");
      if (box) box.hidden = true;
    }
    return;
  }
  state.expanded.add(path);
  if (node) {
    node.classList.add("open");
    paintSessionBox(path); // instant: cached rows, or the "reading" hint
  }
  const info = state.sessionsByProject[path];
  if (!info || info.status !== "ok") ensureSessions(path);
}

function renderProjects() {
  const list = $("projectList");
  list.innerHTML = "";
  const projects = state.config.projects || [];
  if (!projects.length) {
    list.innerHTML = `<li class="muted small" style="padding:10px 12px">还没有项目。点击「添加项目…」选择 opencode 项目目录。</li>`;
    return;
  }

  for (const p of projects) {
    const open = state.expanded.has(p.path);
    const current = p.path === state.currentDir;
    const info = state.sessionsByProject[p.path];
    const picked = state.selectedSession.get(p.path) || "";
    const launchLabel = picked ? "终端打开 · 续接" : "终端打开";

    const li = document.createElement("li");
    li.className = "project-node" + (current ? " current" : "") + (open ? " open" : "");
    li.dataset.path = p.path;

    // ---- project row
    const row = document.createElement("div");
    row.className = "project-row";
    row.innerHTML = `
      <span class="chev" title="展开 / 收起会话">${CHEV}</span>
      <div class="p-main">
        <div class="p-name">${esc(p.name || p.path)}</div>
        <div class="p-path">${esc(p.path)}</div>
      </div>
      ${info && info.status === "ok" ? `<span class="p-count">${info.sessions.length} 个会话</span>` : ""}
      <div class="item-actions">
        <button class="btn tiny ghost" data-act="reveal" title="在资源管理器中打开项目目录">打开项目文件夹</button>
        <button class="btn tiny primary" data-act="launch" title="${picked ? "续接选中的会话" : "启动一个新会话"}">${launchLabel}</button>
        <button class="btn tiny danger ghost" data-act="remove" title="从项目库移除，并删除 opencode 中的项目记录（不删除磁盘文件）">移除</button>
      </div>`;

    row.addEventListener("click", async (e) => {
      if (e.target.closest("[data-act]")) return;
      if (!open) {
        state.expanded.add(p.path);
        ensureSessions(p.path);
      }
      await selectProject(p.path, { silent: true });
    });
    row.querySelector(".chev").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleExpand(p.path);
    });
    row.querySelector('[data-act="reveal"]').addEventListener("click", (e) => {
      e.stopPropagation();
      openPath(p.path);
    });
    row.querySelector('[data-act="launch"]').addEventListener("click", (e) => {
      e.stopPropagation();
      withBusy(null, () => doLaunch(p.path, state.selectedSession.get(p.path) || ""));
    });
    row.querySelector('[data-act="remove"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      // The library drives every other surface, so removing here also drops the
      // project's opencode record (and its sessions). Ask before losing them;
      // files on disk are never touched.
      const label = p.name || p.path;
      if (!confirm(`从项目库移除「${label}」？\n\n这会同时删除 opencode 中该项目的记录和它的会话，磁盘文件不受影响。`)) return;
      const r = await api("project:remove", p.path);
      state.config = r.config;
      delete state.sessionsByProject[p.path];
      state.expanded.delete(p.path);
      state.selectedSession.delete(p.path);
      if (state.currentDir === p.path) {
        state.currentDir = r.config.lastProject || "";
        state.git = null;
        renderHero();
        renderGit();
      }
      renderProjects();
      toast(r.serviceRemoved ? "已从项目库和 opencode 中移除" : "已从项目库移除");
    });
    li.appendChild(row);
    list.appendChild(li);
    if (open) paintSessionBox(p.path);
  }
}

/** Repaint just the selected state of one project's session rows. */
function paintSelection(path) {
  const picked = state.selectedSession.get(path) || "";
  const node = projectNode(path);
  if (node) {
    for (const el of node.querySelectorAll(".session-row")) {
      const on = el.dataset.sessionId === picked;
      el.classList.toggle("selected", on);
      const radio = el.querySelector('input[type="radio"]');
      if (radio) radio.checked = on;
    }
    paintRowState(path);
  }
}

function sessionRow(path, s, group) {
  const picked = state.selectedSession.get(path) === s.id;
  const el = document.createElement("div");
  el.className = "session-row" + (picked ? " selected" : "");
  el.dataset.sessionId = s.id;
  el.title = "点选此会话，再点项目行的「启动」续接；双击直接启动";
  el.innerHTML = `
    <label class="s-pick" title="选中此会话">
      <input type="radio" name="${esc(group)}" ${picked ? "checked" : ""} />
    </label>
    <div class="s-main">
      <div class="s-name">${esc(sessionLabel(s))}</div>
      <div class="s-sub">${s.messages || 0} 条消息 · ${fmtTime(s.updated)}${s.model ? " · " + esc(s.model) : ""}</div>
    </div>
    <button class="btn tiny ghost s-rename" title="重命名此会话">重命名</button>
    <button class="btn tiny danger ghost s-del" title="删除此会话">删除</button>`;

  // Clicking the radio of the already-selected row clears the choice — that is
  // how you get back to "launch a fresh session".
  const pick = () => {
    if (state.selectedSession.get(path) === s.id) state.selectedSession.delete(path);
    else state.selectedSession.set(path, s.id);
    paintSelection(path);
  };
  el.querySelector("input").addEventListener("click", (e) => {
    // Do NOT preventDefault() here. The browser ticks the radio *before* it
    // dispatches the click and rolls that back once the event is cancelled, so
    // cancelling left the circle empty even though the selection went through
    // — the control the user clicked looked like it had ignored them.
    const input = e.currentTarget;
    if (state.selectedSession.get(path) === s.id) {
      // A radio cannot un-tick itself by being clicked — do it by hand.
      input.checked = false;
      state.selectedSession.delete(path);
    } else {
      state.selectedSession.set(path, s.id);
    }
    paintSelection(path);
  });
  el.addEventListener("click", (e) => {
    if (e.target.closest(".s-del, .s-rename, .s-name-input, .s-pick")) return;
    pick();
  });
  el.addEventListener("dblclick", (e) => {
    if (e.target.closest(".s-del, .s-rename, .s-name-input, .s-pick")) return;
    withBusy(null, () => doLaunch(path, s.id));
  });
  el.querySelector(".s-rename").addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(el, path, s);
  });
  el.querySelector(".s-del").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`删除会话「${s.title || s.id}」？此操作不可撤销。`)) return;
    const r = await api("sessions:delete", s.id);
    if (!r.ok) return toast(r.error || "删除失败", "err");
    toast("会话已删除", "ok");
    if (state.selectedSession.get(path) === s.id) state.selectedSession.delete(path);
    ensureSessions(path, true);
  });
  return el;
}

/**
 * Turn a session's title into an inline editor. Enter or blur saves, Esc
 * cancels; the list is refreshed from the backend once the rename lands.
 */
function startRename(rowEl, path, s) {
  if (rowEl.querySelector(".s-name-input")) return;
  const nameEl = rowEl.querySelector(".s-name");
  if (!nameEl) return;

  const prev = s.title || s.slug || s.id;
  const input = document.createElement("input");
  input.className = "s-name-input";
  input.value = prev;
  input.maxLength = 200;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const next = input.value.replace(/\s+/g, " ").trim();
    if (!save || !next || next === prev) {
      renderProjects();
      return;
    }
    input.disabled = true;
    const r = await api("sessions:rename", { id: s.id, title: next });
    if (!r.ok) {
      toast(r.error || "重命名失败", "err");
      renderProjects();
      return;
    }
    toast("会话已重命名", "ok");
    const info = state.sessionsByProject[path];
    const hit = info && Array.isArray(info.sessions) ? info.sessions.find((x) => x.id === s.id) : null;
    if (hit) hit.title = next; // show it immediately, then confirm with a read
    renderProjects();
    ensureSessions(path, true);
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

/**
 * Inline rename inside the 全部记录 view. Same contract as startRename, but
 * it edits the flat session list instead of a project row, and it also
 * refreshes the project-scoped list afterwards.
 */
function startRecordRename(rowEl, s, dir) {
  if (rowEl.querySelector(".r-name-input")) return;
  const nameEl = rowEl.querySelector(".r-name");
  if (!nameEl) return;

  const prev = s.title || "";
  const input = document.createElement("input");
  input.className = "r-name-input s-name-input";
  input.value = prev || s.slug || s.id;
  input.maxLength = 200;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const next = input.value.replace(/\s+/g, " ").trim();
    if (!save || !next || next === prev) {
      renderRecords();
      return;
    }
    input.disabled = true;
    const r = await api("sessions:rename", { id: s.id, title: next });
    if (!r.ok) {
      toast(r.error || "重命名失败", "err");
      renderRecords();
      return;
    }
    toast("会话已重命名", "ok");
    const hit = state.allSessions.find((x) => x.id === s.id);
    if (hit) hit.title = next;
    const info = state.sessionsByProject[target];
    const scoped = info && Array.isArray(info.sessions) ? info.sessions.find((x) => x.id === s.id) : null;
    if (scoped) scoped.title = next;
    renderRecords();
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function renderHero() {
  const p = (state.config.projects || []).find((x) => x.path === state.currentDir);
  $("heroName").textContent = p ? p.name || p.path : "尚未选择项目";
  $("heroPath").textContent = p ? p.path : "添加一个项目目录后即可启动 opencode";
  const tags = $("heroTags");
  tags.innerHTML = "";
  if (p) {
    const items = [
      state.git && state.git.ok ? "Git 仓库" : "",
      state.opencode.found ? `opencode ${state.opencode.current || ""}`.trim() : "opencode 未安装",
    ].filter(Boolean);
    for (const t of items) {
      const el = document.createElement("span");
      el.className = "tag" + (t === "opencode 未安装" ? "" : " ok");
      el.textContent = t;
      tags.appendChild(el);
    }
  }
}

async function addProjectViaDialog() {
  const r = await api("project:pick", state.currentDir || "");
  if (!r.ok) {
    if (!r.cancelled) toast(r.error || "添加失败", "err");
    return;
  }
  state.config = r.config;
  state.expanded.add(r.dir);
  await selectProject(r.dir, { silent: true });
  toast(r.marker ? "项目已添加" : "目录已添加（未检测到项目标记）", "ok");
}

async function selectProject(dir, { silent = false } = {}) {
  if (!dir) return;
  const r = await api("project:select", dir);
  if (!r.ok) {
    toast(r.error || "无法打开项目", "err");
    return;
  }
  state.config = r.config;
  state.currentDir = r.dir;
  state.git = r.git;
  state.sessionsByProject[r.dir] = {
    status: r.sessions && r.sessions.ok ? "ok" : "error",
    sessions: (r.sessions && r.sessions.sessions) || [],
    reason: (r.sessions && r.sessions.reason) || "",
  };
  renderProjects();
  renderHero();
  renderGit();
  if (!silent) toast("已切换到 " + (r.dir.split(/[\\/]/).pop() || r.dir));
}

async function refreshGit() {
  if (!state.currentDir) return;
  state.git = await api("project:git", state.currentDir);
  renderGit();
  renderHero();
}

function renderGit() {
  const card = $("gitCard");
  const body = $("gitBody");
  const g = state.git;
  if (!g || !g.ok) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const parts = [];
  parts.push(`<div class="git-head">
    <span class="tag accent">${esc(g.branch || "detached")}</span>
    ${g.ahead ? `<span class="tag">领先 ${g.ahead}</span>` : ""}
    ${g.behind ? `<span class="tag">落后 ${g.behind}</span>` : ""}
    ${g.staged ? `<span class="tag ok">已暂存 ${g.staged}</span>` : ""}
    ${g.unstaged ? `<span class="tag">已修改 ${g.unstaged}</span>` : ""}
    ${g.untracked ? `<span class="tag">未跟踪 ${g.untracked}</span>` : ""}
    ${g.clean ? `<span class="tag ok">干净</span>` : ""}
  </div>`);
  const files = (g.files || []).slice(0, 8);
  for (const f of files) parts.push(`<div class="git-file">${esc(f.status)} ${esc(f.name)}</div>`);
  if ((g.files || []).length >= 8 && !g.clean) parts.push(`<div class="git-file">… 仅显示前 8 个文件</div>`);
  body.innerHTML = parts.join("");
}

/* ---------------------------------------------------------- launch / kill --- */

async function doLaunch(dir, sessionId) {
  // No project picked means "open the default": the backend falls back to the
  // last project, then to the home directory.
  const target = dir || state.config.lastProject || "";
  const opts = { extraArgs: state.config.prefs.extraArgs || "", auto: Boolean(state.config.prefs.auto) };
  if (sessionId) opts.session = sessionId;
  const r = await api("launch", { dir: target, opts, terminal: state.config.prefs.terminal || "auto" });
  if (!r.ok) return toast(r.error || "启动失败", "err");
  if (sessionId) {
    const info = state.sessionsByProject[dir];
    const hit = info && Array.isArray(info.sessions) ? info.sessions.find((x) => x.id === sessionId) : null;
    toast(`已在新终端中续接「${(hit && hit.title) || "选中会话"}」`, "ok");
  } else {
    toast("已在新的终端窗口中启动 opencode", "ok");
  }
  refreshRunning();
  // The terminal pane is spawned asynchronously: right after launch the scan
  // finds nothing yet, so the chip would stay on "未运行" until some other
  // event (window focus) happened to trigger another probe. Re-probe once the
  // pane had time to come up so the banner reflects the running session.
  setTimeout(refreshRunning, 4000);
  // a resumed session gains messages; a fresh one may show up as a new row
  if (target && state.expanded.has(target)) setTimeout(() => ensureSessions(target, true), 2500);
}

async function doKill() {
  const r = await api("kill");
  if (!r.ok) {
    const first = (r.errors && r.errors[0]) || {};
    return toast(first.error || r.error || "关闭失败", "err");
  }
  const total = (r.killed ? r.killed.length : 0) + (r.swept || 0);
  // The built-in window goes down with the processes, so say so — otherwise it
  // looks like only the terminals were closed.
  const bits = [];
  if (total > 0) bits.push(`已关闭 ${total} 个 opencode 进程`);
  if (r.web) bits.push("已关闭 Web 窗口");
  toast(bits.length ? bits.join("，") : "当前没有运行中的 opencode 进程", "ok");
  refreshRunning();
}

async function refreshRunning() {
  try {
    const r = await api("running:count");
    state.running = r.count || 0;
    const chip = $("runningChip");
    $("runningText").textContent = state.running > 0 ? `运行中 ${state.running}` : "未运行";
    chip.classList.toggle("running", state.running > 0);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------ maintenance --- */

async function checkVersions() {
  const r = await api("maintenance:status");
  $("ocInstalled").textContent = r.current || "未安装";
  $("ocLatest").textContent = r.latest || "查询失败";
  $("ocMode").textContent = r.pkg || "—";
  state.opencode.current = r.current || "";
  $("ocVersion").textContent = state.opencode.current || "未安装";
}

async function installOpencode(updateMode) {
  const box = $("installLog");
  box.hidden = false;
  box.textContent = "";
  const r = await api("maintenance:install");
  await checkVersions();
  if (!r.ok) {
    toast(updateMode ? "更新失败：" + (r.error || "未知错误") : "安装失败：" + (r.error || "未知错误"), "err");
    return;
  }
  toast(updateMode ? "opencode 已更新" : "opencode 已就绪", "ok");
  refreshRunning();
}

async function uninstallOpencode() {
  if (
    !confirm(
      "卸载 opencode？\n\n会先关闭正在运行的会话，并清理缓存与后台服务。\n会话记录会保留，之后随时可以重新安装。"
    )
  )
    return;
  const box = $("installLog");
  box.hidden = false;
  box.textContent = "";
  const r = await api("maintenance:uninstall");
  await checkVersions();
  if (!r.ok) return toast(r.error || "卸载失败", "err");
  toast("opencode 已卸载", "ok");
}

async function loadCache() {
  const c = await api("cache:analyze");
  state.cache = c;
  const box = $("cacheList");
  box.innerHTML = "";
  const items = (c.items || []).filter((i) => i && i.size > 0);
  if (!items.length) {
    box.innerHTML = `<p class="muted small">暂无可清理的缓存。</p>`;
    return;
  }
  for (const it of items) {
    const row = document.createElement("label");
    row.className = "cache-row";
    const locked = !it.clearable;
    let note = "";
    if (it.risky && locked) note = "（opencode 运行中，暂不可清理）";
    else if (!it.clearable && it.key !== "other") note = "（不可清理）";
    row.innerHTML = `
      <input type="checkbox" value="${esc(it.key)}" ${locked ? "disabled" : "checked"} />
      <span class="c-name">${esc(it.name)}${note ? ` <span class="muted small">${note}</span>` : ""}</span>
      <span class="c-size">${fmtSize(it.size)}</span>`;
    box.appendChild(row);
  }
}

async function clearCache() {
  const keys = [...document.querySelectorAll("#cacheList input:checked")].map((i) => i.value);
  if (!keys.length) return toast("先勾选要清理的项", "err");
  const r = await api("cache:clear", keys);
  if (!r.ok) return toast(r.error || "清理失败", "err");
  toast("缓存已清理", "ok");
  loadCache();
}

async function runDoctor() {
  const box = $("doctorLog");
  box.textContent = "检查中…";
  const r = await api("doctor");
  box.textContent = r.text || r.log || "无输出";
  toast(r.ok ? "环境自检通过" : "环境自检发现问题", r.ok ? "ok" : "err");
}

async function uninstallApp() {
  if (!confirm("卸载 opencode 启动器？卸载后本程序将被移除。")) return;
  const r = await api("maintenance:uninstallApp");
  if (!r.ok) toast(r.error || "无法启动卸载程序", "err");
}

/* ---------------------------------------------------------------- records --- */

/**
 * The "全部记录" view: every session and every project opencode itself
 * knows about. The launcher's own project list only holds folders that were
 * added by hand, so sessions started inside opencode were invisible here.
 */
async function loadRecords(force = false) {
  if (!force && state.recordsLoaded && state.allSessions.length) {
    renderRecords();
    return;
  }
  const sum = $("recordsSummary");
  sum.textContent = "正在读取 opencode 记录…";
  const [s, p] = await Promise.all([api("sessions:all"), api("projects:scanned")]);
  state.allSessions = (s && s.sessions) || [];
  state.allProjects = (p && p.projects) || [];
  state.recordsLoaded = true;
  renderRecords();
}

function recordAgo(ms) {
  const t = Number(ms) || 0;
  if (!t) return "—";
  const d = Date.now() - t;
  const min = Math.floor(d / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}

/**
 * opencode names untitled sessions "New session - <iso date>" — the slug is
 * not used as a title there, so the launcher follows the same rule.
 */
function sessionLabel(s) {
  if (s.title) return s.title;
  const t = Number(s.created || s.updated) || 0;
  if (t) {
    const d = new Date(t);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}Z`;
    return `New session - ${iso}`;
  }
  return s.slug || s.id || "(未命名会话)";
}

function projectNameFor(dir) {
  const p = state.allProjects.find((x) => pathKey(x.path) === pathKey(dir));
  if (p) return p.name || dir;
  const known = (state.config.projects || []).find((x) => pathKey(x.path) === pathKey(dir));
  if (known) return known.name || dir;
  const parts = String(dir || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

function pathKey(p) {
  return String(p || "")
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

function renderRecords() {
  const sum = $("recordsSummary");
  const q = state.recordsFilter;
  const sessions = state.allSessions.filter((s) => {
    if (!q) return true;
    return (
      sessionLabel(s).toLowerCase().includes(q) ||
      String(s.directory || "").toLowerCase().includes(q) ||
      String(s.model || "").toLowerCase().includes(q)
    );
  });
  const projects = state.allProjects.filter((p) => {
    if (!q) return true;
    return (
      String(p.name || "").toLowerCase().includes(q) ||
      String(p.path || "").toLowerCase().includes(q)
    );
  });

  const totalSessions = state.allSessions.length;
  const totalProjects = state.allProjects.length;
  const shown = q ? `筛选出 ${sessions.length} 个会话、${projects.length} 个项目（共 ${totalSessions} 个会话 / ${totalProjects} 个项目）` : `共 ${totalSessions} 个会话、${totalProjects} 个项目`;
  sum.textContent = shown;

  const sbox = $("allSessions");
  sbox.innerHTML = "";
  if (!sessions.length) {
    sbox.innerHTML = `<li class="muted small" style="padding:8px 2px">${q ? "没有匹配的会话。" : "opencode 里还没有会话记录。"}</li>`;
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "record-row";
    const dir = s.directory || "";
    li.innerHTML = `
      <div class="r-main">
        <div class="r-name">${esc(sessionLabel(s))}</div>
        <div class="r-sub">${esc(projectNameFor(dir))} · ${esc(recordAgo(s.updated))}${s.messages ? " · " + s.messages + " 条消息" : ""}</div>
      </div>
      <div class="r-path" title="${esc(dir)}">${esc(dir)}</div>
      <div class="r-actions">
        <button class="btn tiny ghost" data-act="open-dir" title="在资源管理器中打开">打开目录</button>
        <button class="btn tiny ghost" data-act="rename" title="重命名此会话">重命名</button>
        <button class="btn tiny danger ghost" data-act="del" title="删除此会话">删除</button>
        <button class="btn tiny primary" data-act="resume" title="在终端中续接此会话">续接</button>
      </div>`;
    li.querySelector('[data-act="open-dir"]').addEventListener("click", () => openPath(dir));
    li.querySelector('[data-act="resume"]').addEventListener("click", () =>
      withBusy(null, () => doLaunch(dir, s.id))
    );
    li.querySelector('[data-act="rename"]').addEventListener("click", () =>
      startRecordRename(li, s, dir)
    );
    li.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`删除会话「${sessionLabel(s)}」？此操作不可撤销。`)) return;
      const r = await api("sessions:delete", s.id);
      if (!r.ok) return toast(r.error || "删除失败", "err");
      toast("会话已删除", "ok");
      // The session is gone from opencode — drop it from every local view.
      state.allSessions = state.allSessions.filter((x) => x.id !== s.id);
      for (const path of Object.keys(state.sessionsByProject)) {
        const info = state.sessionsByProject[path];
        if (info && Array.isArray(info.sessions)) {
          info.sessions = info.sessions.filter((x) => x.id !== s.id);
        }
      }
      if (state.selectedSession.get(dir) === s.id) state.selectedSession.delete(dir);
      renderRecords();
      paintSessionBox(dir);
      paintRowState(dir);
    });
    sbox.appendChild(li);
  }

  const pbox = $("allProjects");
  pbox.innerHTML = "";
  if (!projects.length) {
    pbox.innerHTML = `<li class="muted small" style="padding:8px 2px">${q ? "没有匹配的项目。" : "opencode 里还没有项目记录。"}</li>`;
  }
  const added = new Set((state.config.projects || []).map((x) => pathKey(x.path)));
  for (const p of projects) {
    const li = document.createElement("li");
    li.className = "record-row";
    const isAdded = added.has(pathKey(p.path));
    const n = state.allSessions.filter((s) => pathKey(s.directory) === pathKey(p.path)).length;
    li.innerHTML = `
      <div class="r-main">
        <div class="r-name">${esc(p.name || p.path)}${p.archived ? ' <span class="tag">已归档</span>' : ""}</div>
        <div class="r-sub">${n} 个会话${p.vcs ? " · " + esc(p.vcs) : ""}</div>
      </div>
      <div class="r-path" title="${esc(p.path)}">${esc(p.path)}</div>
      <div class="r-actions">
        <button class="btn tiny ghost" data-act="open-dir" title="在资源管理器中打开">打开目录</button>
        ${
          isAdded
            ? `<button class="btn tiny ghost" data-act="select" title="切换到该项目">设为当前</button>`
            : `<button class="btn tiny primary" data-act="add" title="加入启动器的项目库">加入项目库</button>`
        }
        <button class="btn tiny danger ghost" data-act="del-project" title="从 opencode 的项目记录中删除">删除记录</button>
      </div>`;
    li.querySelector('[data-act="open-dir"]').addEventListener("click", () => openPath(p.path));
    li.querySelector('[data-act="del-project"]').addEventListener("click", async () => {
      const extra = p.archived ? "（已归档）" : "";
      const msg =
        `删除项目记录「${p.name || p.path}」${extra}？\n\n` +
        (n ? `该项目在 opencode 中的 ${n} 个会话会一并删除。\n` : "") +
        (isAdded ? "启动器项目库中的该条目会保留。\n" : "") +
        `磁盘上的文件不会被删除。`;
      if (!confirm(msg)) return;
      const r = await api("project:delete", p.id);
      if (!r.ok) return toast(r.error || "删除失败", "err");
      toast(r.sessions ? `已删除项目记录及其 ${r.sessions} 个会话` : "已删除项目记录", "ok");
      // The project is gone from opencode — drop it and its sessions locally.
      state.allProjects = state.allProjects.filter((x) => x.id !== p.id);
      state.allSessions = state.allSessions.filter((s) => pathKey(s.directory) !== pathKey(p.path));
      for (const path of Object.keys(state.sessionsByProject)) {
        if (pathKey(path) !== pathKey(p.path)) continue;
        const info = state.sessionsByProject[path];
        if (info && Array.isArray(info.sessions)) info.sessions = [];
        state.selectedSession.delete(path);
      }
      renderRecords();
    });
    const act = li.querySelector('[data-act="add"]') || li.querySelector('[data-act="select"]');
    if (act) {
      act.addEventListener("click", async () => {
        if (act.dataset.act === "add") {
          const r = await api("project:add", p.path);
          if (!r.ok) return toast(r.error || "加入失败", "err");
          state.config = r.config;
          renderProjects();
          toast("已加入项目库", "ok");
        } else {
          await selectProject(p.path, { silent: true });
          showView("projects");
        }
        loadRecords(true);
      });
    }
    pbox.appendChild(li);
  }
}

/* -------------------------------------------------------------------- web --- */

/**
 * Register every project in the library with the opencode service, then open
 * the web UI. opencode only creates a project record when something opens the
 * directory, which is why sessions created from the launcher used to be
 * missing from the web client — this makes the two lists match.
 */
async function syncToWeb() {
  if (!(state.config.projects || []).length) return toast("项目库是空的", "err");
  const r = await api("web:sync");
  if (!r.ok) return toast(r.error || "同步失败", "err");
  const total = r.total || 0;
  const done = r.registered || 0;
  const s = r.sessions || {};
  let msg = `已同步 ${done}/${total} 个目录`;
  if (s.reattached) msg += `，修正 ${s.reattached} 个会话归属`;
  if (s.migrated) msg += `，迁移 ${s.migrated} 个旧会话`;
  if (r.missing && r.missing.length) msg += `，${r.missing.length} 个目录不在磁盘上`;
  if (!done) return toast(msg, "err");
  toast(msg, "ok");
}

async function openWeb() {
  const r = await api("web:open_app");
  if (!r || !r.ok) return toast((r && r.error) || "无法打开 Web 版", "err");
  const bits = [];
  if (r.started) bits.push("已启动 opencode 服务");
  bits.push(`内置窗口已打开，工作区同步 ${r.projects || 0} 个项目`);
  if (r.created === false) bits.push("复用已有窗口");
  toast(bits.join("，"), "ok");
  // The window is up and the service is serving it — reflect that in the chip.
  refreshRunning();
  if (r.sync && ((r.sync.added || []).length || (r.sync.dropped || []).length)) {
    const s2 = await api("state:get");
    state.config = s2.config;
    renderProjects();
  }
  // The window loads the one-time pairing link; the session cookie it sets
  // keeps the Web UI signed in from then on.
}

/**
 * One-click bookmarklet for people who prefer their own browser.
 *
 * It runs in the web page, asks the service for the project list and writes
 * the workspace panel's localStorage key — the same merge the built-in window
 * performs, just triggered by hand.
 */
async function copyWebBookmarklet() {
  const r = await api("web:bookmarklet");
  if (!r || !r.ok) return toast((r && r.error) || "无法生成同步书签", "err");
  const url = `javascript:${encodeURIComponent(r.body)}`;
  if (!(await copyText(url))) return toast("复制失败，请检查剪贴板权限", "err");
  toast("同步书签已复制：新建一个书签，网址粘贴这段，在 Web 页面点一下即可同步", "ok");
}

/** Clipboard with a fallback: file:// windows may refuse the async API. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ prefs --- */

async function savePrefs() {
  const prefs = {
    terminal: $("prefTerminal").value,
    extraArgs: $("prefExtra").value.trim(),
  };
  await api("prefs:save", prefs);
  state.config.prefs = { ...state.config.prefs, ...prefs };
}

async function openPath(p) {
  if (!p) return;
  const r = await api("path:open", p);
  if (!r.ok) toast(r.error || "打开失败", "err");
}

/* ------------------------------------------------------------------- init --- */

boot().catch((e) => {
  console.error(e);
  toast("初始化失败：" + (e && e.message ? e.message : e), "err");
});
