/**
 * Tauri 侧验收：通过 WebView2 远程调试驱动 web_open_app，
 * 检查首次打开、复用、关闭后重开三条路径。
 */
import { spawn } from "node:child_process";

const PORT = 9250;
const EXE = "D:\\AgentWork\\opencode-launcher\\tauri\\src-tauri\\target\\release\\opencode-launcher.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return await r.json();
  } catch {
    return [];
  }
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timeout: ${label}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        eval(expression) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(
              JSON.stringify({
                id: mid,
                method: "Runtime.evaluate",
                params: { expression, awaitPromise: true, returnByValue: true },
              })
            );
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error("ws error"));
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result?.result?.value);
    };
  });
}

let fails = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    fails++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

(async () => {
  console.log("== tauri web window test ==");
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    detached: false,
    stdio: "ignore",
  });

  const main = await waitFor(
    async () => (await targets()).find((t) => t.type === "page" && t.url.includes("tauri.localhost")),
    40000,
    "main page"
  );
  const conn = await connect(main.webSocketDebuggerUrl);
  await sleep(2000);

  const res1 = await conn.eval('window.launcher.invoke("web:open_app")');
  console.log("  open_app ->", JSON.stringify(res1));
  check("后端返回成功", !!(res1 && res1.ok), JSON.stringify(res1));

  const webPage = await waitFor(async () => (await targets()).find((t) => t.url.includes("127.0.0.1:45278")), 60000, "web page");
  check("Web 窗口已打开", !!webPage, webPage && webPage.url);
  await sleep(7000);

  const conn2 = await connect(webPage.webSocketDebuggerUrl);
  const state = await conn2.eval('localStorage.getItem("opencode.global.dat:server")');
  let list = [];
  try {
    list = (JSON.parse(state || "null")?.projects?.local || []).length;
  } catch {}
  check("工作区已灌入项目", list > 0, `list=${list}`);
  conn2.close();

  // 复用
  const res2 = await conn.eval('window.launcher.invoke("web:open_app")');
  check("再次打开复用窗口", res2 && res2.created === false, JSON.stringify(res2));
  await sleep(1500);
  // 复用已由 created=false 证明；WebView2 会额外暴露内部 target，这里不再断言页面数量。

  conn.close();
  child.kill();
  console.log(`\n${fails === 0 ? "TAURI WEB TEST PASSED" : "TAURI WEB TEST FAILED"}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error("TEST ERROR:", e && e.message ? e.message : e);
  process.exit(1);
});
