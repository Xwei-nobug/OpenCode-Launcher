"use strict";

/**
 * Measures how long the project tree takes to react to an expand click and
 * how long the session list IPC takes — the two things that made expanding
 * feel sticky. Run before/after an optimisation to compare.
 */

const path = require("node:path");
const { _electron: electron } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const EXE = process.env.LAUNCHER_EXE || "";

(async () => {
  const app = await electron.launch(
    EXE ? { executablePath: EXE, args: ["--no-sandbox"], env, timeout: 40000 } : { args: [".", "--no-sandbox"], cwd: ROOT, env, timeout: 40000 }
  );
  const win = await app.firstWindow();
  await win.waitForSelector("#projectList .project-node", { timeout: 20000 });
  await win.waitForTimeout(1500);

  // ---- renderer-side timings ----
  const result = await win.evaluate(async () => {
    const perf = performance;
    const waitFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const nodes = [...document.querySelectorAll("#projectList .project-node")];
    const out = [];

    for (const node of nodes) {
      const chev = node.querySelector(".chev");
      const wasOpen = node.classList.contains("open");
      // collapse first so the measured click is always an expand
      if (wasOpen) {
        chev.click();
        await waitFrame();
      }
      const t0 = perf.now();
      chev.click();
      const tClick = perf.now() - t0;
      await waitFrame();
      const tPaint = perf.now() - t0;
      out.push({ path: node.dataset.path.slice(-24), clickMs: +tClick.toFixed(2), paintMs: +tPaint.toFixed(2) });
    }
    return out;
  });

  // ---- IPC latency for the session read ----
  const ipc = await win.evaluate(async () => {
    const dir = state.currentDir;
    const t0 = performance.now();
    await window.launcher.invoke("sessions:list", dir);
    return +(performance.now() - t0).toFixed(1);
  });

  const ipcGit = await win.evaluate(async () => {
    const dir = state.currentDir;
    const t0 = performance.now();
    await window.launcher.invoke("project:git", dir);
    return +(performance.now() - t0).toFixed(1);
  });

  const ipcSelect = await win.evaluate(async () => {
    const dir = state.currentDir;
    const t0 = performance.now();
    await window.launcher.invoke("project:select", dir);
    return +(performance.now() - t0).toFixed(1);
  });

  console.log("expand click (renderer):");
  for (const r of result) console.log(`  ${r.path}  click=${r.clickMs}ms  paint=${r.paintMs}ms`);
  console.log(`sessions:list   ${ipc} ms`);
  console.log(`project:git     ${ipcGit} ms`);
  console.log(`project:select  ${ipcSelect} ms`);

  await app.close();
})().catch((e) => {
  console.error("ERR:", e);
  process.exit(1);
});
