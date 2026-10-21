/**
 * shared/web-seed.js 的合并规则单测。
 * 用内存版 localStorage 跑真实的种子脚本，覆盖 增 / 改 / 删 / 保留用户项目。
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "shared", "web-seed.js"), "utf8");
const KEY = "opencode.global.dat:server";
const MARK = "opencode-launcher.synced";

/** 跑一次种子脚本，返回结果 + 完整存储快照（含标记键，便于链式复用）。 */
function run(initial, dirs) {
  const store = new Map(Object.entries(initial || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const ctx = { localStorage, JSON, Array, String, Object, console };
  vm.createContext(ctx);
  vm.runInContext(`${SRC}\n;globalThis.__seed = __ocLauncherSeed;`, ctx);
  const result = ctx.__seed({ dirs });
  const raw = localStorage.getItem(KEY);
  return {
    result,
    saved: raw ? JSON.parse(raw) : null,
    entries: Object.fromEntries(store),
  };
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
  }
}

/* 1. 空状态 + 两个服务端项目 -> 全部新增 */
{
  const { result, saved, entries } = run({}, ["D:\\a", "D:\\b"]);
  check("空状态会新增全部项目", result.added === 2 && result.total === 2, JSON.stringify(result));
  check("新增后写入 localStorage", saved && saved.projects.local.length === 2);
  check("新增项默认展开", saved.projects.local.every((e) => e.expanded === true));
  check("lastProject 指向第一项", saved.lastProject.local === "D:\\a");
  check("changed 为真", result.changed === true);
  check("写入同步标记", JSON.parse(entries[MARK]).length === 2);
}

/* 2. 已是最新 -> 不重写，changed=false */
{
  const first = run({}, ["D:\\a"]);
  const { result } = run(first.entries, ["D:\\a"]);
  check("幂等：再跑一次 changed=false", result.changed === false, JSON.stringify(result));
  check("幂等：added=0", result.added === 0);
}

/* 3. 新增项目追加，已有项目保留展开状态 */
{
  const first = run({}, ["D:\\a"]);
  const state = JSON.parse(first.entries[KEY]);
  state.projects.local[0].expanded = false; // 用户折叠了
  const { result, saved } = run({ ...first.entries, [KEY]: JSON.stringify(state) }, ["D:\\a", "D:\\b"]);
  check("增量：只新增缺失的一个", result.added === 1, JSON.stringify(result));
  check("保留已有项目的折叠状态", saved.projects.local[0].expanded === false);
}

/* 4. 服务端删除 -> 启动器加过的被移除 */
{
  const seeded = run({}, ["D:\\a", "D:\\b"]);
  const { result, saved } = run(seeded.entries, ["D:\\a"]);
  check("服务端删除后本地也移除", result.removed === 1 && result.total === 1, JSON.stringify(result));
  check("移除后只剩 D:\\a", saved.projects.local.length === 1 && saved.projects.local[0].worktree === "D:\\a");
}

/* 5. 用户自己在 web 里加的项目不被误删 */
{
  const seeded = run({}, ["D:\\a"]);
  const state = JSON.parse(seeded.entries[KEY]);
  state.projects.local.push({ worktree: "E:\\user-own", expanded: true });
  const { result, saved } = run({ ...seeded.entries, [KEY]: JSON.stringify(state) }, ["D:\\a"]);
  check("用户手动项目被保留", saved.projects.local.some((e) => e.worktree === "E:\\user-own"));
  check("用户手动项目不算新增也不算删除", result.added === 0 && result.removed === 0, JSON.stringify(result));
}

/* 6. 大小写 / 分隔符差异去重 */
{
  const seeded = run({}, ["D:/Work/Proj"]);
  const { result, saved } = run(seeded.entries, ["d:\\work\\proj\\"]);
  check("路径归一化后不重复", saved.projects.local.length === 1, JSON.stringify(saved.projects.local));
  check("归一化不算新增", result.added === 0);
  check("显示服务端返回的写法", saved.projects.local[0].worktree === "d:\\work\\proj\\");
}

/* 7. lastProject 失效时回填 */
{
  const seeded = run({}, ["D:\\a", "D:\\b"]);
  const state = JSON.parse(seeded.entries[KEY]);
  state.lastProject.local = "Z:\\gone";
  const { saved } = run({ ...seeded.entries, [KEY]: JSON.stringify(state) }, ["D:\\a", "D:\\b"]);
  check("lastProject 失效后回填有效项", saved.lastProject.local === "D:\\a");
}

/* 8. 清空项目列表 */
{
  const seeded = run({}, ["D:\\a"]);
  const { saved } = run(seeded.entries, []);
  check("空目标列表会清空 launcher 项目", saved.projects.local.length === 0, JSON.stringify(saved.projects.local));
  check("没有项目时移除 lastProject", saved.lastProject.local === undefined);
}

/* 9. 损坏的 localStorage 不应抛错 */
{
  const { result } = run({ [KEY]: "{not json" }, ["D:\\a"]);
  check("损坏 JSON 能自愈", result.ok === true && result.added === 1, JSON.stringify(result));
}

/* 10. 保留其它 store 字段（不破坏 web 端自己的状态） */
{
  const seeded = run({}, ["D:\\a"]);
  const state = JSON.parse(seeded.entries[KEY]);
  state.hidden = { local: { "D:\\a": true } };
  state.recentlyClosed = { local: ["D:\\old"] };
  const { saved } = run({ ...seeded.entries, [KEY]: JSON.stringify(state) }, ["D:\\a"]);
  check("hidden 字段未被破坏", saved.hidden && saved.hidden.local["D:\\a"] === true);
  check("recentlyClosed 字段未被破坏", Array.isArray(saved.recentlyClosed.local));
}

console.log(`\n${fail === 0 ? "ALL SEED CHECKS PASSED" : "SEED CHECKS FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
