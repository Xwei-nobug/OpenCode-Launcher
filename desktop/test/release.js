"use strict";

/**
 * Publishes the GitHub release for the desktop launcher: creates (or reuses)
 * the release for the current tag and uploads the NSIS installer.
 *
 * The token is read from the machine's git credential store, so it never has
 * to be pasted into a shell command.
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

const OWNER = "Xwei-nobug";
const REPO = "OpenCode-Launcher";
const TAG = process.argv[2] || "v1.0.3";
const ASSET = process.argv[3] || path.join(__dirname, "..", "dist", `opencode-launcher-setup-${TAG.replace(/^v/, "")}.exe`);

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

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opencode-launcher-release",
          ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
        },
        timeout: 60000,
      },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(s ? JSON.parse(s) : {});
            } catch {
              resolve({ raw: s });
            }
          } else {
            reject(new Error(`${method} ${url} -> ${res.statusCode}: ${s.slice(0, 400)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}

const NOTES = `## opencode 启动器 ${TAG}

给 opencode 一个像样的桌面入口。选项目、管会话、一键启动与关闭、维护 opencode 本体——不用记命令，不用开一堆终端。

### 功能

- **项目**：一键打开项目文件夹，或直接在项目目录启动；最近项目库；自动识别 Git 仓库（分支、领先 / 落后、改动统计）
- **会话**：展开项目查看全部会话（标题 / 消息数 / 更新时间 / 模型）；**单选会话后启动即续接**，不选则开启新会话；支持重命名与删除，双击直接续接
- **启动与关闭**：每个会话在独立、可见的终端窗口中启动（Windows Terminal / 命令提示符 / PowerShell）；「关闭 opencode」一键结束所有 opencode 进程，连同终端窗口一并关闭
- **维护**：版本查看、安装 / 修复、更新到最新版、卸载；缓存占用分类清理；环境自检；应用内卸载

### 安装

1. 下载 \`opencode-launcher-setup-${TAG.replace(/^v/, "")}.exe\`
2. 双击运行，选择安装位置，下一步完成
3. 打开后添加一个项目目录，点「启动项目」即可

> 安装包自带运行环境，无需预先安装 Node.js。首次使用若提示未安装 opencode，点「安装 / 修复」即可。
`;

(async () => {
  console.log("== release", TAG, "==");

  // reuse an existing release for this tag, otherwise create one
  let rel = null;
  try {
    rel = await api("GET", `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log("existing release:", rel.html_url);
  } catch {
    console.log("no release yet, creating…");
  }
  if (!rel) {
    rel = await api("POST", `https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG,
      name: `opencode 启动器 ${TAG}`,
      body: NOTES,
      draft: false,
      prerelease: false,
    });
    console.log("created:", rel.html_url);
  }

  if (!fs.existsSync(ASSET)) throw new Error("安装包不存在：" + ASSET);
  const size = fs.statSync(ASSET).size;
  console.log(`asset: ${path.basename(ASSET)} (${(size / 1048576).toFixed(1)} MB)`);
  const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(path.basename(ASSET))}`;

  await new Promise((resolve, reject) => {
    const data = fs.readFileSync(ASSET);
    const u = new URL(uploadUrl);
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opencode-launcher-release",
          "Content-Type": "application/octet-stream",
          "Content-Length": data.length,
        },
        timeout: 600000,
      },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const j = JSON.parse(s);
            console.log("uploaded:", j.name, j.size, "bytes");
            console.log("download:", j.browser_download_url);
            resolve();
          } else reject(new Error(`upload -> ${res.statusCode}: ${s.slice(0, 400)}`));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("upload timeout")));
    req.write(data);
    req.end();
  });

  const final = await api("GET", `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  console.log("release:", final.html_url);
  console.log("assets:", (final.assets || []).map((a) => `${a.name} (${(a.size / 1048576).toFixed(1)} MB)`).join(", "));
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
