// Copies the freshly built installer out of src-tauri/target into ./dist with
// a stable, ASCII-only name:
//   dist/opencode-launcher-setup.exe    NSIS installer
//
// Only the installer is shipped — the portable single-file build (the bare
// opencode-launcher.exe) is deliberately dropped, so there is exactly one way
// to install and no stray half-installed copy lying around.
//
// Run automatically by `npm run dist`.

import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = join(root, "src-tauri", "target", "release");
const nsisDir = join(releaseDir, "bundle", "nsis");
const dist = join(root, "dist");

if (!existsSync(releaseDir)) {
  console.error("找不到编译产物目录：", releaseDir, "\n请先运行 tauri build。");
  process.exit(1);
}

mkdirSync(dist, { recursive: true });

// NSIS names the installer after productName+version (Chinese, with spaces);
// pick the newest one and rename to a clean ASCII filename.
const setups = readdirSync(nsisDir)
  .filter((n) => n.toLowerCase().endsWith("-setup.exe") || n.toLowerCase().endsWith("_setup.exe"))
  .map((n) => ({ n, t: statSync(join(nsisDir, n)).mtimeMs }))
  .sort((a, b) => b.t - a.t);

if (setups.length === 0) {
  console.error("未在", nsisDir, "找到安装器。");
  process.exit(1);
}

const target = join(dist, "opencode-launcher-setup.exe");
copyFileSync(join(nsisDir, setups[0].n), target);

// Drop the portable build and anything else left over from earlier runs.
for (const name of readdirSync(dist)) {
  const full = join(dist, name);
  if (full === target) continue;
  rmSync(full, { recursive: true, force: true });
}

const mb = (fsPath) => (statSync(fsPath).size / 1024 / 1024).toFixed(2) + " MB";
console.log("已归位到 dist/：");
console.log(`  opencode-launcher-setup.exe  ${mb(target)}`);
