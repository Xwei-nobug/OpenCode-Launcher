// 打包后清理：dist/ 只保留 NSIS 安装包。
//
// electron-builder 即使在 nsis 目标下也会留下 win-unpacked/（安装包的暂存
// 目录）以及一些中间文件；它们不是交付物，留着只会让人误以为是「免安装版」，
// 也让 dist 体积翻倍。这里只保留 artifactName 生成的 setup.exe。
//
// Run automatically by `npm run dist`.

const fs = require("node:fs");
const path = require("node:path");

const dist = path.join(__dirname, "..", "dist");
if (!fs.existsSync(dist)) {
  console.error("dist/ 不存在，请先运行 electron-builder。");
  process.exit(1);
}

const entries = fs.readdirSync(dist);
const setups = entries.filter((n) => /^opencode-launcher-setup-.*\.exe$/i.test(n));
if (setups.length === 0) {
  console.error("dist/ 里没有找到安装包（opencode-launcher-setup-*.exe）。");
  process.exit(1);
}

// 只留最新的一个安装包，其余（旧版本、win-unpacked、中间产物）全部删除。
setups.sort((a, b) => fs.statSync(path.join(dist, b)).mtimeMs - fs.statSync(path.join(dist, a)).mtimeMs);
const keep = setups[0];

for (const name of entries) {
  if (name === keep) continue;
  fs.rmSync(path.join(dist, name), { recursive: true, force: true });
}

const size = (fs.statSync(path.join(dist, keep)).size / 1024 / 1024).toFixed(2);
console.log(`已清理 dist/，只保留安装包：${keep}  ${size} MB`);
