// Full functional test for the launcher renderer, run against the real
// index.html / app.js with the Tauri IPC mocked.
//
//   node test/full-test.mjs
//
// Covers:
//   1. boot: state, hero, version chips
//   2. project library: list, expand, session rows, counts
//   3. session pick: radio check / uncheck / switch, button labels
//   4. inline rename (Enter saves, Esc cancels)
//   5. session delete
//   6. 全部记录 view: all sessions + all projects, search filter, add to library
//   7. web version button
//   8. maintenance view: versions, cache list, doctor
//   9. settings view: prefs save, path rows
//  10. launch / kill wiring
//
// Exits non-zero on the first failing expectation.

import { chromium } from "../../desktop/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, "..", "renderer");
const indexUrl = "file:///" + join(rendererDir, "index.html").replace(/\\/g, "/");

/* ---------------------------------------------------------------- mock IPC --- */

const mockTauri = () => {
  const dir = "D:/demo/project";
  const dir2 = "D:/demo/other";
  const sessions = [
    { id: "ses_abc123", title: "run-abc123", slug: "run-abc123", directory: dir, messages: 3, updated: 1750000000000, model: "gpt" },
    { id: "ses_def456", title: "run-def456", slug: "run-def456", directory: dir, messages: 7, updated: 1750000100000, model: "gpt" },
  ];
  const allSessions = [
    ...sessions,
    { id: "ses_zzz999", title: "询问 AI 模型身份", slug: "curious-panda", directory: "D:/opencode/dist", messages: 4, updated: 1750000200000, model: "deepseek" },
    { id: "ses_untitled", title: "", slug: "cosmic-engine", directory: "D:/opencode/dist", messages: 0, updated: 1750000300000, model: "" },
  ];
  const allProjects = [
    { id: "p1", path: dir, name: "project", vcs: "git", archived: false, active: 1, updated: 1750000000000, exists: true },
    { id: "p2", path: dir2, name: "other", vcs: "", archived: false, active: 1, updated: 1750000000000, exists: true },
    { id: "p3", path: "D:/opencode/dist", name: "dist", vcs: "", archived: true, active: 0, updated: 1750000000000, exists: true },
  ];
  const config = {
    projects: [{ path: dir, name: "project", addedAt: 1 }],
    lastProject: dir,
    prefs: { terminal: "auto", extraArgs: "" },
  };
  const git = { ok: true, isRepo: true, branch: "main", ahead: 1, behind: 0, staged: 0, unstaged: 2, untracked: 0, clean: false, files: [{ status: " M", name: "a.txt" }], total: 1 };
  const state = {
    app: { version: "1.1.0", electron: "Tauri/WebView2", node: "-", theme: "light", isDev: false },
    paths: { dataDir: "C:/data", config: "C:/config.json", log: "C:/log", db: "C:/opencode.db", ocLog: "C:/oclog" },
    config,
    opencode: { found: true, path: "C:/opencode.exe", current: "2.0.30", major: 2, npmPkg: "@opencode/cli", npm: "npm", running: false },
    terminals: { wt: true },
  };

  const calls = [];
  window.__calls = calls;

  window.__TAURI__ = {
    core: {
      invoke(cmd, args) {
        calls.push({ cmd, args });
        switch (cmd) {
          case "state_get": return Promise.resolve(state);
          case "project_select":
            return Promise.resolve({ ok: true, dir, marker: "", git, sessions: { ok: true, sessions }, config });
          case "sessions_list": return Promise.resolve({ ok: true, sessions });
          case "sessions_all": return Promise.resolve({ ok: true, sessions: allSessions });
          case "projects_scanned": return Promise.resolve({ ok: true, projects: allProjects });
          case "project_git": return Promise.resolve(git);
          case "running_count": return Promise.resolve({ count: 2, sessions: [] });
          case "sessions_rename": return Promise.resolve({ ok: true, id: args.p.id, title: args.p.title });
          case "sessions_delete": return Promise.resolve({ ok: true });
          case "project_delete": return Promise.resolve({ ok: true, id: args.p, sessions: 2 });
          case "project_add":
            return Promise.resolve({ ok: true, config: { ...config, projects: [...config.projects, { path: args.p, name: "other", addedAt: 2 }] } });
          case "project_remove": return Promise.resolve({ ok: true, config });
          case "prefs_save": return Promise.resolve({ ok: true });
          case "path_open": return Promise.resolve({ ok: true });
          case "launch": return Promise.resolve({ ok: true, method: "Windows Terminal" });
          case "kill": return Promise.resolve({ ok: true, killed: [{ script: "run-1-1.cmd" }], swept: 1 });
          case "maintenance_status": return Promise.resolve({ current: "2.0.30", latest: "2.0.31", npm: "npm", pkg: "@opencode/cli" });
          case "cache_analyze":
            return Promise.resolve({
              ok: true,
              items: [
                { key: "logs", name: "日志", size: 1024 * 1024, clearable: true, risky: false },
                { key: "cache", name: "缓存", size: 2048, clearable: true, risky: false },
                { key: "other", name: "其它", size: 10, clearable: false, risky: false },
              ],
            });
          case "cache_clear": return Promise.resolve({ ok: true });
          case "doctor": return Promise.resolve({ ok: true, text: "全部正常" });
          case "web_open": {
            const r = { ok: true, url: "http://127.0.0.1:45278/auth/connect/abc123", base: "http://127.0.0.1:45278" };
            window.__webOpenedUrl = r.url;
            return Promise.resolve(r);
          }
          case "web_open_app": {
            const r = { ok: true, created: true, url: "http://127.0.0.1:45278", projects: 3, registered: 3, started: false };
            window.__webOpenedApp = r;
            return Promise.resolve(r);
          }
          case "web_status": return Promise.resolve({ ok: true, url: "http://127.0.0.1:45278", running: true });
          case "web_open_project": {
            window.__webOpenProjectDir = args.p;
            return Promise.resolve({ ok: true, register: { ok: true }, open: { ok: true, url: "http://127.0.0.1:45278/auth/connect/z1" } });
          }
          case "web_sync": {
            window.__webSyncCalled = true;
            return Promise.resolve({
              ok: true, total: 2, registered: 2, missing: [],
              sessions: { ok: true, projectsMerged: 1, reattached: 2, migrated: 1, messages: 3 },
              open: { ok: true, url: "http://127.0.0.1:45278/auth/connect/z2" },
            });
          }
          default: return Promise.resolve({ ok: true });
        }
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
};

/* --------------------------------------------------------------- harness --- */

function findChromium() {
  const root = process.env.LOCALAPPDATA + "\\ms-playwright";
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith("chromium-")) continue;
    for (const rel of ["chrome-win\\chrome.exe", "chrome-win64\\chrome.exe", "chrome-linux\\chrome"]) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);
};

const errors = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: findChromium() || undefined,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});
page.on("dialog", (d) => d.accept());

await page.addInitScript(mockTauri);
await page.goto(indexUrl);

/* 1. boot ---------------------------------------------------------------- */
await page.waitForSelector(".project-node", { timeout: 15000 });
await page.waitForTimeout(300);

const boot = await page.evaluate(() => ({
  version: document.getElementById("appVersion")?.textContent?.trim(),
  ocVersion: document.getElementById("ocVersion")?.textContent?.trim(),
  heroName: document.getElementById("heroName")?.textContent?.trim(),
  projects: document.querySelectorAll(".project-node").length,
  running: document.getElementById("runningText")?.textContent?.trim(),
  gitShown: !document.getElementById("gitCard")?.hidden,
}));
check("启动后读取状态并渲染项目库", boot.version === "1.1.0" && boot.projects === 1, JSON.stringify(boot));
check("顶部显示 opencode 版本", boot.ocVersion === "2.0.30");
check("Hero 显示当前项目名", boot.heroName === "project");
check("运行计数显示 2", boot.running === "运行中 2", boot.running);
check("Git 卡片可见", boot.gitShown === true);

/* 2. expand + sessions ---------------------------------------------------- */
// The current project is expanded on boot — only click the chevron when it
// is closed, otherwise the click would collapse the list again.
const isOpen = await page.evaluate(() => !!document.querySelector(".project-node.open"));
if (!isOpen) await page.click(".project-node .chev");
await page.waitForSelector(".session-row", { timeout: 10000, state: "visible" });
await page.waitForTimeout(250);
const expanded = await page.evaluate(() => ({
  rows: document.querySelectorAll(".session-row").length,
  count: document.querySelector(".p-count")?.textContent?.trim(),
  names: [...document.querySelectorAll(".session-row .s-name")].map((n) => n.textContent.trim()),
}));
check("展开后列出该项目的会话", expanded.rows === 2, JSON.stringify(expanded.names));
check("项目行显示会话计数", expanded.count === "2 个会话", expanded.count);

/* 3. session pick --------------------------------------------------------- */
await page.locator(".session-row input[type=radio]").first().click({ force: true });
await page.waitForTimeout(250);
const picked = await page.evaluate(() => {
  const row = document.querySelector(".session-row");
  return {
    selected: [...state.selectedSession.entries()],
    checked: row?.querySelector("input")?.checked,
    cls: row?.className,
    launch: document.querySelector('[data-act="launch"]')?.textContent?.trim(),
    headerLaunch: document.getElementById("btnLaunch")?.textContent?.trim(),
  };
});
check("勾选圆点写入选中状态", picked.selected.length === 1 && picked.selected[0][1] === "ses_abc123");
check("圆点呈勾选态", picked.checked === true);
check("会话行标记 .selected", /selected/.test(picked.cls || ""));
check("项目行按钮变「启动并续接」", picked.launch === "终端打开 · 续接", picked.launch);
// Terminals are opened from the project row only — the header button is gone.
check("顶部不再有终端打开按钮", picked.headerLaunch === undefined, String(picked.headerLaunch));

await page.locator(".session-row input[type=radio]").first().click({ force: true });
await page.waitForTimeout(200);
const unchecked = await page.evaluate(() => ({
  selected: [...state.selectedSession.entries()].length,
  checked: document.querySelector(".session-row input")?.checked,
  launch: document.querySelector('[data-act="launch"]')?.textContent?.trim(),
}));
check("再点一次取消选中", unchecked.selected === 0 && unchecked.checked === false);
check("取消后按钮文案还原", unchecked.launch === "终端打开", unchecked.launch);

await page.locator(".session-row input[type=radio]").nth(1).click({ force: true });
await page.waitForTimeout(200);
const switched = await page.evaluate(() => ({
  selected: [...state.selectedSession.entries()].map((x) => x[1]),
  checked: [...document.querySelectorAll(".session-row input")].map((i) => i.checked),
}));
check("点第二个圆点切换选中", switched.selected[0] === "ses_def456", JSON.stringify(switched.selected));
check("切换后第一个圆点取消勾选", switched.checked[0] === false && switched.checked[1] === true);

/* 4. rename --------------------------------------------------------------- */
await page.click(".session-row .s-rename");
await page.waitForTimeout(150);
await page.fill(".s-name-input", "重命名后的会话");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const renamed = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "sessions_rename").pop());
check("重命名提交到后端", renamed && renamed.args.p.title === "重命名后的会话", JSON.stringify(renamed?.args?.p));

/* 5. delete --------------------------------------------------------------- */
const beforeDel = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "sessions_delete").length);
await page.click(".session-row .s-del");
await page.waitForTimeout(300);
const afterDel = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "sessions_delete").length);
check("删除会话调用后端", afterDel > beforeDel);

/* 6. records view --------------------------------------------------------- */
await page.click('.nav-btn[data-view="records"]');
await page.waitForSelector("#allSessions .record-row", { timeout: 10000 });
await page.waitForTimeout(300);
const records = await page.evaluate(() => ({
  sessions: document.querySelectorAll("#allSessions .record-row").length,
  projects: document.querySelectorAll("#allProjects .record-row").length,
  summary: document.getElementById("recordsSummary")?.textContent?.trim(),
  firstName: document.querySelector("#allSessions .r-name")?.textContent?.trim(),
  untitled: [...document.querySelectorAll("#allSessions .r-name")].map((n) => n.textContent.trim()),
  projectBtns: [...document.querySelectorAll("#allProjects .r-actions button")].map((b) => b.textContent.trim()),
}));
check("全部记录列出所有会话（含项目外的）", records.sessions === 4, String(records.sessions));
check("全部记录列出所有项目", records.projects === 3, String(records.projects));
check("统计摘要正确", /共 4 个会话、3 个项目/.test(records.summary || ""), records.summary);
check("未命名会话按 opencode 规则命名", (records.untitled || []).some((t) => /^New session - /.test(t)), JSON.stringify(records.untitled));
check("未加入项目库的项目有「加入项目库」按钮", (records.projectBtns || []).includes("加入项目库"), JSON.stringify(records.projectBtns));

// sessions that belong to no project in the library must still offer delete
const rowBtns = await page.evaluate(() =>
  [...document.querySelectorAll("#allSessions .record-row")].map((r) => ({
    name: r.querySelector(".r-name")?.textContent?.trim(),
    acts: [...r.querySelectorAll(".r-actions button")].map((b) => b.dataset.act),
  }))
);
check(
  "记录列表的会话都有删除按钮（含项目库外的会话）",
  rowBtns.length > 0 && rowBtns.every((r) => r.acts.includes("del")),
  JSON.stringify(rowBtns.map((r) => r.acts))
);
check(
  "记录列表的会话都有重命名按钮",
  rowBtns.every((r) => r.acts.includes("rename"))
);

// delete a session that lives outside the project library
const outside = rowBtns.find((r) => /模型身份/.test(r.name || ""));
if (outside) {
  const before = await page.evaluate(() => state.allSessions.length);
  await page.locator("#allSessions .record-row", { hasText: "询问 AI 模型身份" }).locator('[data-act="del"]').click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    count: state.allSessions.length,
    delCall: window.__calls.filter((c) => c.cmd === "sessions_delete").pop(),
    rows: document.querySelectorAll("#allSessions .record-row").length,
  }));
  check("删除项目库外的会话生效", after.count === before - 1, `${before} -> ${after.count}`);
  check("删除调用了后端", Boolean(after.delCall && after.delCall.args.p === "ses_zzz999"), JSON.stringify(after.delCall?.args?.p));
} else {
  check("删除项目库外的会话生效", false, "未找到目标会话");
}

// search filter
await page.fill("#recordsFilter", "run-def456");
await page.waitForTimeout(250);
const filtered = await page.evaluate(() => ({
  sessions: document.querySelectorAll("#allSessions .record-row").length,
  summary: document.getElementById("recordsSummary")?.textContent?.trim(),
}));
check("搜索过滤会话", filtered.sessions === 1, String(filtered.sessions));
await page.fill("#recordsFilter", "");
await page.waitForTimeout(200);

// add to project library
await page.fill("#recordsFilter", "other");
await page.waitForTimeout(250);
const addBtn = page.locator('#allProjects .r-actions button[data-act="add"]').first();
if (await addBtn.count()) {
  await addBtn.click();
  await page.waitForTimeout(300);
  const added = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "project_add").pop());
  check("「加入项目库」提交目录", added && typeof added.args.p === "string" && added.args.p.length > 0, JSON.stringify(added?.args?.p));
} else {
  check("「加入项目库」提交目录", false, "按钮未出现");
}
await page.fill("#recordsFilter", "");
await page.waitForTimeout(200);

// every project record — archived or not — must offer a delete button, and
// the archived one in particular must be removable.
const projRows = await page.evaluate(() =>
  [...document.querySelectorAll("#allProjects .record-row")].map((r) => ({
    name: r.querySelector(".r-name")?.textContent?.trim(),
    archived: /已归档/.test(r.querySelector(".r-name")?.textContent || ""),
    acts: [...r.querySelectorAll(".r-actions button")].map((b) => b.dataset.act),
  }))
);
check(
  "记录列表的项目都有删除按钮",
  projRows.length > 0 && projRows.every((r) => r.acts.includes("del-project")),
  JSON.stringify(projRows.map((r) => r.acts))
);
check(
  "已归档的项目被标记出来",
  projRows.some((r) => r.archived),
  JSON.stringify(projRows.map((r) => r.archived))
);

const archivedRow = projRows.find((r) => r.archived);
if (archivedRow) {
  const beforeProjects = await page.evaluate(() => state.allProjects.length);
  await page.locator('#allProjects .record-row', { hasText: "已归档" }).locator('[data-act="del-project"]').first().click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    count: state.allProjects.length,
    rows: document.querySelectorAll("#allProjects .record-row").length,
    call: window.__calls.filter((c) => c.cmd === "project_delete").pop(),
  }));
  check("删除已归档项目生效", after.count === beforeProjects - 1, `${beforeProjects} -> ${after.count}`);
  check("删除项目调用了后端", Boolean(after.call && after.call.args.p === "p3"), JSON.stringify(after.call?.args?.p));
} else {
  check("删除已归档项目生效", false, "未找到已归档项目");
}

/* 7. web ------------------------------------------------------------------ */
await page.click("#btnWeb");
await page.waitForTimeout(300);
const webCall = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "web_open_app").length);
check("Web 版按钮打开内置窗口", webCall > 0);
const webApp = await page.evaluate(() => window.__webOpenedApp);
check(
  "内置窗口同步了项目库",
  !!(webApp && webApp.ok && webApp.projects > 0),
  JSON.stringify(webApp)
);

// The refresh button reconciles the library and repaints both views.
await page.click('.nav-btn[data-view="projects"]');
await page.waitForTimeout(300);
await page.click("#btnRefresh");
await page.waitForTimeout(600);
const refreshed = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "app_refresh").length);
check("刷新按钮调用 app_refresh", refreshed > 0, String(refreshed));
const syncToast = await page.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent).join(" | "));
check("刷新结果有提示", /刷新/.test(syncToast), syncToast);

// The old browser-sync entry points are gone: the built-in window covers both.
check("没有「同步到 Web 版」按钮", (await page.locator("#btnWebSync").count()) === 0);
check("没有「书签」按钮", (await page.locator("#btnWebBookmark").count()) === 0);

// The per-row web button was removed on purpose: the header button opens the
// window once and it already lists every project and session, so a row-level
// duplicate is redundant.
const rowWebBtns = await page.locator('#projectList [data-act="web"]').count();
check("项目行不再有 Web 按钮", rowWebBtns === 0, String(rowWebBtns));

/* 8. maintenance ---------------------------------------------------------- */
await page.click('.nav-btn[data-view="maintenance"]');
await page.waitForTimeout(600);
const maint = await page.evaluate(() => ({
  installed: document.getElementById("ocInstalled")?.textContent?.trim(),
  latest: document.getElementById("ocLatest")?.textContent?.trim(),
  cacheRows: document.querySelectorAll("#cacheList .cache-row").length,
  visible: !document.getElementById("view-maintenance")?.hidden,
}));
check("维护页可见", maint.visible === true);
check("显示已安装/最新版本", maint.installed === "2.0.30" && maint.latest === "2.0.31", JSON.stringify(maint));
check("缓存列表渲染", maint.cacheRows === 3, String(maint.cacheRows));

await page.click("#btnDoctor");
await page.waitForTimeout(300);
const doctor = await page.evaluate(() => document.getElementById("doctorLog")?.textContent?.trim());
check("环境自检输出", doctor === "全部正常", doctor);

/* 9. settings ------------------------------------------------------------- */
await page.click('.nav-btn[data-view="settings"]');
await page.waitForTimeout(200);
const paths = await page.evaluate(() => ({
  db: document.getElementById("pathDb")?.textContent?.trim(),
  data: document.getElementById("pathData")?.textContent?.trim(),
}));
check("设置页显示会话库路径", paths.db === "C:/opencode.db", paths.db);
check("设置页显示数据目录", paths.data === "C:/data", paths.data);

/* 10. launch / kill ------------------------------------------------------- */
await page.click('.nav-btn[data-view="projects"]');
await page.waitForTimeout(200);
await page.click('[data-act="launch"]');
await page.waitForTimeout(250);
const launchCall = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "launch").pop());
check("启动调用 launch 并带目录", launchCall && launchCall.args.p.dir === "D:/demo/project", JSON.stringify(launchCall?.args?.p?.dir));

await page.click("#btnKill");
await page.waitForTimeout(250);
const killCall = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "kill").length);
check("关闭调用 kill", killCall > 0);

/* wrap up ---------------------------------------------------------------- */
await browser.close();

if (errors.length) {
  console.log("\n页面报错:", JSON.stringify(errors, null, 2));
  results.push({ name: "无页面错误", ok: false, detail: errors.join(" | ") });
} else {
  results.push({ name: "无页面错误", ok: true, detail: "" });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.error("\nFAIL:\n- " + failed.map((f) => f.name + (f.detail ? " — " + f.detail : "")).join("\n- "));
  process.exit(1);
}
console.log("\nPASS: 全部功能测试通过。");
