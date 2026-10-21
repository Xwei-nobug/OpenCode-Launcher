"use strict";

/**
 * End-to-end UI test: drives the real Electron window with Playwright.
 *
 * Covers the flows the app exists for: project list, project switching,
 * session listing, launch (a real terminal opens), kill-all, maintenance
 * status, cache analysis and the settings pane. Screenshots are written next
 * to this file for visual review.
 */

const path = require("node:path");
const fs = require("node:fs");
const { _electron: electron } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

// The harness exports ELECTRON_RUN_AS_NODE=1, which turns Electron into plain
// Node and breaks every GUI launch — strip it for the child.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

const shot = async (win, name) => {
  await win.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`  shot  ${name}.png`);
};

(async () => {
  console.log("== UI test ==");
  // LAUNCHER_EXE drives an installed build; without it the dev tree is used.
  const exe = process.env.LAUNCHER_EXE;
  const opts = exe
    ? { executablePath: exe, args: ["--no-sandbox"], env, timeout: 40000 }
    : { args: [".", "--no-sandbox"], cwd: ROOT, env, timeout: 40000 };
  const app = await electron.launch(opts);

  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForSelector("#projectList .project-node", { timeout: 20000 });

  // ---- 1. window + first paint ----
  const title = await win.title();
  check("window title", title.includes("opencode"), title);
  const views = await win.$$eval(".view", (els) => els.filter((e) => !e.hidden).length);
  check("exactly one view visible", views === 1, `visible views: ${views}`);
  await shot(win, "01-projects");

  // ---- 2. project tree ----
  const nodes = await win.$$("#projectList .project-node");
  check("project tree rendered", nodes.length >= 1, `nodes=${nodes.length}`);
  const hero = await win.textContent("#heroName");
  check("hero shows a project", Boolean(hero && hero.trim()) && hero !== "尚未选择项目", hero);
  const expandedCount = await win.$$eval("#projectList .project-node.open", (els) => els.length);
  check("a project is expanded by default", expandedCount >= 1, `open=${expandedCount}`);
  await shot(win, "02-project-hero");

  // ---- 3. sessions live inside the project row ----
  let sawSessions = false;
  let sawDelete = false;
  let anyEmptyText = "";
  for (let i = 0; i < nodes.length; i++) {
    const row = (await win.$$("#projectList .project-row"))[i];
    await row.click();
    await win.waitForTimeout(2200); // select + session read
    const openNow = await win.$$eval("#projectList .project-node.open", (els) => els.length);
    check(`project ${i + 1} expands in place`, openNow >= 1, `open=${openNow}`);
    const rows = await win.$$("#projectList .session-row");
    if (rows.length > 0) {
      sawSessions = true;
      const dels = await win.$$("#projectList .session-row .s-del");
      sawDelete = dels.length === rows.length;
      await shot(win, "03-project-expanded");
      break;
    }
    anyEmptyText = await win.textContent("#projectList .session-box");
  }
  check("sessions listed under a project", sawSessions, `rows=0 hint=${(anyEmptyText || "").trim().slice(0, 60)}`);
  check("every session row has a delete button", sawDelete);

  // ---- 4. count badge appears once sessions are known ----
  const badges = await win.$$eval("#projectList .p-count", (els) => els.map((e) => e.textContent));
  check("session count badge rendered", badges.some((b) => /个会话/.test(b)), JSON.stringify(badges));
  await shot(win, "04-counts");

  // ---- 4b. inline rename round trip (restores the original title) ----
  let renameOk = false;
  const rows = await win.$$("#projectList .session-row");
  if (rows.length) {
    const original = await rows[0].$eval(".s-name", (e) => e.textContent);
    const probe = `重命名测试-${Date.now() % 1000}`;
    await rows[0].$eval(".s-rename", (e) => e.click());
    const input = await win.waitForSelector("#projectList .s-name-input", { timeout: 5000 });
    await input.fill("");
    await input.type(probe);
    await input.press("Enter");

    // The rename goes through the opencode service (which may need to start),
    // so poll instead of assuming a fixed latency.
    let names = [];
    for (let i = 0; i < 40; i++) {
      await win.waitForTimeout(600);
      names = await win.$$eval("#projectList .session-row .s-name", (els) => els.map((e) => e.textContent));
      if (names.includes(probe)) break;
    }
    renameOk = names.includes(probe);
    check("rename applies in the UI", renameOk, JSON.stringify(names));
    await shot(win, "04b-renamed");

    // put the original title back through the same UI path
    if (renameOk) {
      const rowHandles = await win.$$("#projectList .session-row");
      for (const r of rowHandles) {
        const t = await r.$eval(".s-name", (e) => e.textContent);
        if (t !== probe) continue;
        await r.$eval(".s-rename", (e) => e.click());
        const inp = await win.waitForSelector("#projectList .s-name-input", { timeout: 5000 });
        await inp.fill("");
        await inp.type(original);
        await inp.press("Enter");
        break;
      }
      let restored = [];
      for (let i = 0; i < 40; i++) {
        await win.waitForTimeout(600);
        restored = await win.$$eval("#projectList .session-row .s-name", (els) => els.map((e) => e.textContent));
        if (restored.includes(original)) break;
      }
      check("rename restored", restored.includes(original), JSON.stringify(restored));
    }
  }

  // Let the post-rename background refresh settle before touching rows again —
  // that refresh re-renders the whole list and detaches live element handles.
  await win.waitForTimeout(2000);

  // ---- 5. radio-select a session, then launch it from the project row ----
  const radioLoc = win.locator("#projectList .session-row input[type=radio]").first();
  if ((await win.locator("#projectList .session-row input[type=radio]").count()) > 0) {
    await radioLoc.click();
    await win.waitForTimeout(700);
    const selected = await win.$$eval("#projectList .session-row.selected", (els) => els.length);
    check("radio selects exactly one session", selected === 1, `selected=${selected}`);
    const labels = await win.$$eval("#projectList .project-row [data-act=launch]", (els) => els.map((e) => e.textContent));
    check("launch button switches to resume", labels.includes("启动并续接"), JSON.stringify(labels));
    await shot(win, "05-selected");

    const beforeChip = await win.textContent("#runningText");
    await win.evaluate(() => {
      const sel = document.querySelector("#projectList .session-row.selected");
      const node = sel && sel.closest(".project-node");
      const btn = node && node.querySelector("[data-act=launch]");
      if (btn) btn.click();
    });
    await win.waitForTimeout(2500);
    const toastText = await win.$$eval("#toasts .toast", (els) => els.map((e) => e.textContent).join(" | "));
    check("launch resumes the selected session", /续接/.test(toastText), toastText);
    await win.waitForTimeout(8000);
    const chipRunning = await win.textContent("#runningText");
    check("running chip shows a session", /运行中/.test(chipRunning), `${beforeChip} -> ${chipRunning}`);
    await shot(win, "05-launched");
  } else {
    check("radio selects exactly one session", false, "no session rows to pick");
  }

  await win.click("#btnKill");
  await win.waitForTimeout(6000);
  const chipAfter = await win.textContent("#runningText");
  check("kill brings the chip back", /未运行/.test(chipAfter), chipAfter);
  await shot(win, "06-killed");

  // ---- 5b. clicking the selected radio again clears the choice ----
  const againLoc = win.locator("#projectList .session-row input[type=radio]").first();
  if ((await win.locator("#projectList .session-row input[type=radio]").count()) > 0) {
    await againLoc.click();
    await win.waitForTimeout(700);
    const cleared = await win.$$eval("#projectList .session-row.selected", (els) => els.length);
    check("clicking the radio again clears the pick", cleared === 0, `selected=${cleared}`);
    const back = await win.$$eval("#projectList .project-row [data-act=launch]", (els) => els.map((e) => e.textContent));
    check("launch button back to plain launch", back.includes("启动项目"), JSON.stringify(back));
    await shot(win, "06b-deselected");
  }

  // ---- 6. maintenance: cache + doctor ----
  await win.click('.nav-btn[data-view="maintenance"]');
  await win.waitForTimeout(600);
  await win.click("#btnCacheRefresh");
  await win.waitForTimeout(6000);
  const cacheRows = (await win.$$("#cacheList .cache-row")).length;
  check("cache list renders", cacheRows > 0, `rows=${cacheRows}`);
  await shot(win, "07-maintenance");

  await win.click("#btnDoctor");
  await win.waitForTimeout(12000);
  const doc = await win.textContent("#doctorLog");
  check("doctor produced output", /OK|!!/.test(doc || ""), (doc || "").slice(0, 80));
  await shot(win, "08-doctor");

  // ---- 7. 全部记录: every session and project opencode knows about ----
  await win.click('.nav-btn[data-view="records"]');
  await win.waitForSelector("#allSessions .record-row", { timeout: 15000 });
  await win.waitForTimeout(800);
  const rec = await win.evaluate(() => ({
    sessions: document.querySelectorAll("#allSessions .record-row").length,
    projects: document.querySelectorAll("#allProjects .record-row").length,
    summary: document.getElementById("recordsSummary")?.textContent?.trim(),
    hasDelete: [...document.querySelectorAll("#allSessions .record-row")].every((r) =>
      r.querySelector('[data-act="del"]')
    ),
    hasRename: [...document.querySelectorAll("#allSessions .record-row")].every((r) =>
      r.querySelector('[data-act="rename"]')
    ),
    projectHasDelete: [...document.querySelectorAll("#allProjects .record-row")].every((r) =>
      r.querySelector('[data-act="del-project"]')
    ),
    archivedProjects: [...document.querySelectorAll("#allProjects .record-row")].filter((r) =>
      /已归档/.test(r.querySelector(".r-name")?.textContent || "")
    ).length,
  }));
  check("records view lists sessions", rec.sessions > 0, `n=${rec.sessions}`);
  check("records view lists projects", rec.projects > 0, `n=${rec.projects}`);
  check("records summary rendered", /会话/.test(rec.summary || ""), rec.summary);
  check("every listed session has a delete button", rec.hasDelete);
  check("every listed session has a rename button", rec.hasRename);
  check("every listed project has a delete button", rec.projectHasDelete);

  // Sessions that live outside the project library must be listed too.
  const libKeys = await win.evaluate(() => {
    const cfg = window.state ? state.config : null;
    return (cfg?.projects || []).map((p) => p.path.toLowerCase().replace(/\//g, "\\"));
  });
  const dirs = await win.evaluate(() =>
    [...document.querySelectorAll("#allSessions .record-row .r-path")].map((e) =>
      e.getAttribute("title").toLowerCase().replace(/\//g, "\\")
    )
  );
  const outside = dirs.filter((d) => !libKeys.includes(d));
  check("sessions outside the project library are listed", outside.length > 0, `outside=${outside.length}`);
  await shot(win, "10-records");

  // search filter
  await win.fill("#recordsFilter", "zzz-no-such-session");
  await win.waitForTimeout(400);
  const filtered = await win.$$eval("#allSessions .record-row", (els) => els.length);
  check("records search filters the list", filtered === 0, `rows=${filtered}`);
  await win.fill("#recordsFilter", "");
  await win.waitForTimeout(300);

  // ---- 8. settings ----
  await win.click('.nav-btn[data-view="settings"]');
  await win.waitForTimeout(400);
  const prefsTerminal = await win.inputValue("#prefTerminal");
  check("terminal pref loaded", Boolean(prefsTerminal), prefsTerminal);
  await shot(win, "11-settings");

  // ---- 9. no renderer errors ----
  const errors = [];
  win.on("pageerror", (e) => errors.push(String(e)));
  await win.click('.nav-btn[data-view="projects"]');
  await win.waitForTimeout(600);
  check("no renderer errors", errors.length === 0, errors.join(";"));

  await app.close();
  console.log(failures === 0 ? "\nALL UI CHECKS PASSED" : `\n${failures} UI CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("UI TEST CRASHED:", e);
  process.exit(2);
});
