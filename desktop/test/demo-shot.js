"use strict";

/**
 * Renders the README screenshot with demo data instead of the real one —
 * fictional projects and sessions, so no local paths or personal notes leak
 * into the repository image.
 *
 * The app is launched against a throwaway APPDATA (its own config only), then
 * the renderer's state is filled with demo sessions and re-rendered once.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { _electron: electron } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(ROOT, "..", "docs", "app.png");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "olk-demo-"));

const now = Date.now();
const H = 3600 * 1000;
const DEMO = {
  projects: [
    { path: "D:\\Projects\\my-blog", name: "my-blog", addedAt: now - 30 * 24 * H },
    { path: "D:\\Projects\\data-dashboard", name: "data-dashboard", addedAt: now - 9 * 24 * H },
  ],
  sessions: {
    "D:\\Projects\\my-blog": [
      { id: "ses_demo01", title: "重构登录模块的鉴权流程", messages: 87, updated: now - 1.2 * H, model: "claude-sonnet-4.5" },
      { id: "ses_demo02", title: "给文章页加上草稿自动保存", messages: 46, updated: now - 5.4 * H, model: "gpt-5.1-codex" },
      { id: "ses_demo03", title: "排查图片懒加载的闪烁问题", messages: 23, updated: now - 27 * H, model: "gemini-3-pro" },
    ],
    "D:\\Projects\\data-dashboard": [
      { id: "ses_demo04", title: "优化大表格的虚拟滚动性能", messages: 64, updated: now - 2.1 * H, model: "claude-sonnet-4.5" },
      { id: "ses_demo05", title: "把图表配置抽成独立模块", messages: 31, updated: now - 50 * H, model: "gpt-5.1-codex" },
    ],
  },
};

// A private data dir keeps the real project list out of the picture entirely.
const dataDir = path.join(TMP, "opencode-launcher");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify(
    { projects: DEMO.projects, prefs: { terminal: "auto", extraArgs: "" }, lastProject: DEMO.projects[0].path },
    null,
    2
  ),
  "utf8"
);

const env = { ...process.env, APPDATA: TMP };
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: ROOT, env, timeout: 40000 });
  const win = await app.firstWindow();
  await win.waitForSelector("#projectList .project-node", { timeout: 20000 });

  // Fill the window with demo content and paint it once.
  await win.evaluate((demo) => {
    state.config = { ...state.config, projects: demo.projects, lastProject: demo.projects[0].path };
    state.currentDir = demo.projects[0].path;
    state.git = null;
    state.expanded = new Set(demo.projects.map((p) => p.path));
    state.sessionsByProject = {};
    for (const p of demo.projects) {
      state.sessionsByProject[p.path] = { status: "ok", sessions: demo.sessions[p.path] || [], reason: "" };
    }
    renderProjects();
    renderHero();
    renderGit();
    document.getElementById("toasts").innerHTML = "";
  }, DEMO);

  await win.waitForTimeout(700);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await win.screenshot({ path: OUT });
  console.log("screenshot written:", OUT, `(${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);

  await app.close();
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((e) => {
  console.error("FAILED:", e);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
