// Reproduces the "clicking the session radio does nothing" bug against the
// real renderer, with the Tauri runtime mocked.
//
//   node test/session-pick-test.mjs
//
// Exits non-zero when the pick interaction does not behave as designed:
// the radio must become checked, the row must be marked .selected, the
// project row's launch button must switch to "终端打开 · 续接", and no page error
// may be thrown.

import { chromium } from "../../desktop/node_modules/playwright-core/index.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, "..", "renderer");
const indexUrl = "file:///" + join(rendererDir, "index.html").replace(/\\/g, "/");

/* ---------------------------------------------------------------- mock IPC --- */

const mockTauri = () => {
  const sessions = [
    { id: "ses_abc123", title: "run-abc123", messages: 3, updated: Date.now(), model: "gpt" },
    { id: "ses_def456", title: "run-def456", messages: 7, updated: Date.now(), model: "gpt" },
  ];
  const dir = "D:/demo/project";
  const config = {
    projects: [{ path: dir, name: "project", added_at: 1 }],
    lastProject: dir,
    prefs: { terminal: "auto" },
  };
  const git = { ok: true, isRepo: true, branch: "main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, clean: true, files: [], total: 0 };
  const state = {
    app: { version: "1.1.0", electron: "Tauri/WebView2", node: "-", theme: "light", isDev: false },
    paths: { dataDir: "C:/data", config: "C:/config.json", log: "C:/log", db: "C:/opencode.db", ocLog: "C:/oclog" },
    config,
    opencode: { found: true, path: "C:/opencode.exe", current: "2.0.30", major: 2, npmPkg: "@opencode/cli", npm: "npm", running: false },
    terminals: { wt: true },
  };

  window.__TAURI__ = {
    core: {
      invoke(cmd) {
        switch (cmd) {
          case "state_get": return Promise.resolve(state);
          case "project_select": return Promise.resolve({ ok: true, dir, marker: "", git, sessions: { ok: true, sessions }, config });
          case "sessions_list": return Promise.resolve({ ok: true, sessions });
          case "project_git": return Promise.resolve(git);
          case "running_count": return Promise.resolve({ count: 0, sessions: [] });
          default: return Promise.resolve({ ok: true });
        }
      },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };
};

/* --------------------------------------------------------------- run test --- */

function findChromium() {
  const root = process.env.LOCALAPPDATA + "\\ms-playwright";
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith("chromium-")) continue;
    for (const rel of [
      "chrome-win\\chrome.exe",
      "chrome-win64\\chrome.exe",
      "chrome-linux\\chrome",
    ]) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

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

await page.addInitScript(mockTauri);
await page.goto(indexUrl);

// wait for the session rows to be rendered
await page.waitForSelector(".session-row", { timeout: 15000 });
await page.waitForTimeout(300);

const before = await page.evaluate(() => ({
  selected: [...state.selectedSession.entries()],
  rows: document.querySelectorAll(".session-row").length,
  launchLabel: document.querySelector('[data-act="launch"]')?.textContent?.trim(),
}));

// click the radio of the first session
const radio = page.locator(".session-row input[type=radio]").first();
await radio.click({ force: true });
await page.waitForTimeout(300);

const after = await page.evaluate(() => {
  const row = document.querySelector(".session-row");
  const input = row && row.querySelector("input[type=radio]");
  return {
    selected: [...state.selectedSession.entries()],
    rowClass: row ? row.className : null,
    radioChecked: input ? input.checked : null,
    launchLabel: document.querySelector('[data-act="launch"]')?.textContent?.trim(),
    headerLaunch: document.getElementById("btnLaunch")?.textContent?.trim(),
  };
});

// clicking the same radio again clears the selection
await radio.click({ force: true });
await page.waitForTimeout(200);
const toggled = await page.evaluate(() => {
  const row = document.querySelector(".session-row");
  const input = row && row.querySelector("input[type=radio]");
  return {
    selected: [...state.selectedSession.entries()],
    rowClass: row ? row.className : null,
    radioChecked: input ? input.checked : null,
    launchLabel: document.querySelector('[data-act="launch"]')?.textContent?.trim(),
  };
});

// picking the second radio switches the selection
const radio2 = page.locator(".session-row input[type=radio]").nth(1);
await radio2.click({ force: true });
await page.waitForTimeout(200);
const switched = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".session-row")];
  return {
    selected: [...state.selectedSession.entries()],
    checked: rows.map((r) => r.querySelector("input[type=radio]").checked),
  };
});

await browser.close();

console.log("点击前:  ", JSON.stringify(before));
console.log("点击后:  ", JSON.stringify(after));
console.log("再点一次:", JSON.stringify(toggled));
console.log("点第二个:", JSON.stringify(switched));
if (errors.length) console.log("页面报错:", JSON.stringify(errors, null, 2));

const problems = [];
if (after.selected.length === 0) problems.push("点击圆点后 state.selectedSession 仍为空（选中没有写进去）");
if (!after.radioChecked) problems.push("圆点没有被勾选");
if (!/selected/.test(after.rowClass || "")) problems.push("会话行没有 .selected 样式");
if (after.launchLabel !== "终端打开 · 续接") problems.push(`项目行启动按钮文案未更新：${after.launchLabel}`);
if (after.launchLabel !== "终端打开 · 续接") problems.push(`项目行启动按钮文案未更新：${after.launchLabel}`);
// The header launch button was removed; terminals come from the project row.
if (after.headerLaunch !== undefined) problems.push("顶部仍有终端打开按钮");
if (toggled.selected.length !== 0) problems.push("再点一次没有取消选中");
if (toggled.radioChecked) problems.push("再点一次后圆点仍是勾选态");
if (toggled.launchLabel !== "终端打开") problems.push(`取消后项目行按钮文案未还原：${toggled.launchLabel}`);
if (switched.selected.length !== 1 || switched.selected[0][1] !== "ses_def456")
  problems.push(`点第二个圆点没有切换选中：${JSON.stringify(switched.selected)}`);
if (!switched.checked[0] === false) problems.push("切换后第一个圆点仍处于勾选态");
if (errors.length) problems.push(`页面抛出 ${errors.length} 个错误`);

if (problems.length) {
  console.error("\nFAIL:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("\nPASS: 圆点勾选 / 取消 / 切换 与按钮文案联动，链路正常。");
