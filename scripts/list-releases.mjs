// List GitHub releases + assets for the repo, using the token from the local
// git credential store (never printed).
import { spawnSync } from "node:child_process";

const OWNER = "Xwei-nobug";
const REPO = "OpenCode-Launcher";

function token() {
  const r = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
  });
  const m = /password=(.+)/.exec(r.stdout || "");
  if (!m) throw new Error("无法从凭据管理器读取 GitHub token");
  return m[1].trim();
}

const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=10`, {
  headers: {
    Authorization: `Bearer ${token()}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "opencode-launcher-release",
  },
});
console.log("status:", res.status);
const list = await res.json();
if (!Array.isArray(list)) {
  console.log(JSON.stringify(list).slice(0, 400));
  process.exit(1);
}
for (const r of list) {
  console.log(`\n${r.tag_name}  draft=${r.draft} prerelease=${r.prerelease}  ${r.html_url}`);
  console.log(`  published: ${r.published_at}`);
  for (const a of r.assets || []) {
    console.log(`   - ${a.name}  ${(a.size / 1048576).toFixed(2)} MB  (${a.download_count} 次下载)`);
  }
}
