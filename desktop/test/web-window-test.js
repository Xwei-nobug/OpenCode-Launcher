"use strict";

/**
 * 验收：内置 Web 窗口是否真的把项目灌进了工作区面板。
 *
 * 驱动真实 Electron 窗口点「Web 版」，等内置窗口打开，再读它的
 * localStorage / 侧栏文本 —— 也就是用户实际看到的那份数据。
 */

const path = require("node:path");
const { _electron: electron } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const KEY = "opencode.global.dat:server";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 退化成纯 Node

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

(async () => {
  console.log("== built-in web window test ==");
  const app = await electron.launch({ args: [ROOT], env });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForTimeout(1500);

  // 书签脚本：不弹窗，只校验内容
  const bm = await win.evaluate(() => window.launcher.invoke("web:bookmarklet"));
  check("书签脚本可生成", bm && bm.ok === true && typeof bm.body === "string");
  check("书签包含同步函数", !!bm.body && bm.body.includes("__ocLauncherSeed"));
  check("书签会自取 /api/project", !!bm.body && bm.body.includes("/api/project"));

  // 窗口是在 IPC 处理过程中创建的，且创建瞬间 URL 还是 about:blank，
  // 所以不能靠事件谓词，直接轮询窗口列表。
  const before = Date.now();
  const res = await win.evaluate(() => window.launcher.invoke("web:open_app"));
  console.log("  open_app ->", JSON.stringify(res));
  check("后端返回成功", !!(res && res.ok), JSON.stringify(res));

  let webWin = null;
  while (Date.now() - before < 90000) {
    webWin = app.windows().find((w) => w !== win && w.url().includes("127.0.0.1")) || null;
    if (webWin) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  check("内置窗口已创建", !!webWin);
  if (!webWin) throw new Error("内置窗口未创建");
  await webWin.waitForLoadState("domcontentloaded");
  console.log(`  内置窗口已打开（${Date.now() - before} ms）url=${webWin.url().slice(0, 60)}`);

  // 等 seed + reload 完成
  await webWin.waitForTimeout(7000);

  const raw = await webWin.evaluate((k) => localStorage.getItem(k), KEY);
  let state = null;
  try {
    state = JSON.parse(raw || "null");
  } catch {
    state = null;
  }
  const list = (state && state.projects && state.projects.local) || [];
  check("内置窗口写入了工作区数据", list.length > 0, `list=${list.length}`);
  check("项目项带有 worktree", list.every((e) => typeof e.worktree === "string" && e.worktree));

  const mark = await webWin.evaluate(() => localStorage.getItem("opencode-launcher.synced"));
  let marked = [];
  try {
    marked = JSON.parse(mark || "[]");
  } catch {
    marked = [];
  }
  // 标记存的是「服务端目录」，列表已按归一化去重，所以比较去重后的数量。
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const listKeys = new Set(list.map((e) => norm(e.worktree)));
  const markedKeys = new Set(marked.map(norm));
  const missing = [...markedKeys].filter((k) => !listKeys.has(k));
  if (missing.length) console.log("  未进入列表的目录:", JSON.stringify(missing));
  check(
    "同步标记覆盖服务端目录",
    Array.isArray(marked) && marked.length > 0 && [...markedKeys].every((k) => listKeys.has(k)),
    `mark=${marked.length} markUniq=${markedKeys.size} list=${list.length}`
  );
  check("服务端重复目录已去重", list.length === listKeys.size, `list=${list.length} uniq=${listKeys.size}`);

  // 侧栏文本应出现项目名
  const side = await webWin.evaluate(() => (document.body.innerText || "").slice(0, 1200));
  const names = list
    .map((e) => path.basename(String(e.worktree).replace(/[\\/]+$/, "")))
    .filter(Boolean);
  const shown = names.filter((n) => side.includes(n));
  check("侧栏显示了项目名", shown.length > 0, `命中 ${shown.length}/${names.length}`);

  // 再点一次：应复用窗口而不是新开
  await win.click("#btnWeb");
  await win.waitForTimeout(3500);
  const windows = app.windows().filter((w) => w.url().includes("127.0.0.1"));
  check("再次点击复用窗口", windows.length === 1, `windows=${windows.length}`);

  // 关闭后重开：应能重新建窗并再次灌入（销毁重建这条路径最容易踩坑）
  await webWin.close();
  await win.waitForTimeout(1500);
  const t2 = Date.now();
  const reopened = await win.evaluate(() => window.launcher.invoke("web:open_app"));
  check("关闭后可重新打开", !!(reopened && reopened.ok && reopened.created === true), JSON.stringify(reopened));
  let webWin2 = null;
  while (Date.now() - t2 < 30000) {
    webWin2 = app.windows().find((w) => w !== win && w.url().includes("127.0.0.1")) || null;
    if (webWin2) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  check("重开后窗口可用", !!webWin2);
  if (webWin2) {
    await webWin2.waitForTimeout(5000);
    const raw2 = await webWin2.evaluate((k) => localStorage.getItem(k), KEY);
    let n2 = 0;
    try {
      n2 = (JSON.parse(raw2 || "null")?.projects?.local || []).length;
    } catch {}
    check("重开后项目仍在", n2 > 0, `list=${n2}`);
  }

  console.log(`\n${failures === 0 ? "WEB WINDOW TEST PASSED" : "WEB WINDOW TEST FAILED"}`);
  await app.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
