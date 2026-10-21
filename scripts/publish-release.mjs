// Publishes a GitHub release with one or more assets.
//
//   node scripts/publish-release.mjs <tag> [--notes <file>] <srcPath>[:<assetName>] ...
//
// The token comes from the local git credential store, so it never has to be
// pasted into a shell command. An asset that already exists on the release is
// replaced, so re-running after a rebuild is safe.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const OWNER = "Xwei-nobug";
const REPO = "OpenCode-Launcher";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

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

const TOKEN = token();

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-launcher-release",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function upload(url, file) {
  const data = readFileSync(file);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-launcher-release",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.length),
    },
    body: data,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload ${basename(file)} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/* -------------------------------------------------------------------- args --- */

const argv = process.argv.slice(2);
const tag = argv[0];
if (!tag || !/^v\d/.test(tag)) {
  console.error("用法：node scripts/publish-release.mjs <tag> [--notes <file>] <srcPath>[:<assetName>] ...");
  process.exit(1);
}
let notesFile = null;
const specs = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--notes") {
    notesFile = argv[++i];
    continue;
  }
  specs.push(argv[i]);
}
if (!specs.length) {
  console.error("没有指定任何资产。");
  process.exit(1);
}

const assets = specs.map((spec) => {
  const idx = spec.lastIndexOf(":");
  // A Windows drive letter (C:\...) is not a name separator.
  const hasName = idx > 1 && !/^[A-Za-z]:[\\/]/.test(spec.slice(0, idx + 1));
  const file = hasName ? spec.slice(0, idx) : spec;
  const name = hasName ? spec.slice(idx + 1) : basename(file);
  if (!existsSync(file)) throw new Error("文件不存在：" + file);
  return { file, name, size: statSync(file).size };
});

/* ------------------------------------------------------------------ release --- */

console.log(`== 发布 ${tag} ==`);
for (const a of assets) console.log(`  · ${a.name}  ${(a.size / 1048576).toFixed(2)} MB`);

let rel = null;
try {
  rel = await api("GET", `${API}/releases/tags/${tag}`);
  console.log("复用已有 release：", rel.html_url);
} catch {
  console.log("该 tag 尚无 release，先确保 tag 存在…");
  const head = await api("GET", `${API}/git/ref/heads/main`);
  try {
    await api("GET", `${API}/git/ref/tags/${tag}`);
    console.log("tag 已存在");
  } catch {
    await api("POST", `${API}/git/refs`, { ref: `refs/tags/${tag}`, sha: head.object.sha });
    console.log(`已创建 tag ${tag} -> ${head.object.sha.slice(0, 8)}`);
  }
  const body = notesFile ? readFileSync(notesFile, "utf8") : `opencode 启动器 ${tag}`;
  rel = await api("POST", `${API}/releases`, {
    tag_name: tag,
    name: `opencode 启动器 ${tag}`,
    body,
    draft: false,
    prerelease: false,
  });
  console.log("已创建 release：", rel.html_url);
}

if (notesFile) {
  rel = await api("PATCH", `${API}/releases/${rel.id}`, { body: readFileSync(notesFile, "utf8") });
  console.log("已更新 release 说明");
}

for (const a of assets) {
  const existing = (rel.assets || []).find((x) => x.name === a.name);
  if (existing) {
    console.log(`替换同名资产 ${a.name} …`);
    await api("DELETE", `${API}/releases/assets/${existing.id}`);
  }
  const up = await upload(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(a.name)}`,
    a.file
  );
  console.log(`  ✓ ${up.name}  ${(up.size / 1048576).toFixed(2)} MB  ${up.browser_download_url}`);
}

const final = await api("GET", `${API}/releases/tags/${tag}`);
console.log("\nrelease:", final.html_url);
console.log("资产:", (final.assets || []).map((a) => `${a.name} (${(a.size / 1048576).toFixed(2)} MB)`).join(", "));
