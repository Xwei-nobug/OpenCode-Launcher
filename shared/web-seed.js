/* opencode-launcher — web workspace seeding.
 *
 * The web UI's workspace panel is not backed by the server's project table; it
 * reads a browser-local list (`opencode.global.dat:server` -> `projects.local`).
 * Nothing outside the page can write that key, so both backends inject this
 * function into the web page and call it there.
 *
 * Electron reads this file at runtime, Tauri bakes it in with include_str!, so
 * the merge rules below stay identical in both builds. It only defines a
 * function — never runs on its own.
 *
 * Merge rules:
 *   add     - a server project that the panel does not list yet
 *   update  - path normalisation, duplicate removal, `expanded` preserved
 *   remove  - an entry the launcher added before that the server no longer has
 * Entries the user added by hand in the web UI are never touched.
 */
function __ocLauncherSeed(seed) {
  var KEY = "opencode.global.dat:server";
  var MARK = "opencode-launcher.synced";

  function norm(p) {
    return String(p == null ? "" : p)
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  }
  function read(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || "");
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  var before = localStorage.getItem(KEY) || "";
  var state = read(KEY, {});
  if (!state || typeof state !== "object") state = {};
  if (!state.projects || typeof state.projects !== "object") state.projects = {};
  if (!state.lastProject || typeof state.lastProject !== "object") state.lastProject = {};

  var list = Array.isArray(state.projects.local) ? state.projects.local : [];

  // Directories the server knows about, de-duplicated and normalised. The
  // first spelling wins so the panel shows the path opencode itself reports.
  // A root-only entry ("/") is the global pseudo-project and is skipped: its
  // normalised key is empty.
  var wanted = [];
  var want = {};
  var dirs = (seed && seed.dirs) || [];
  for (var i = 0; i < dirs.length; i++) {
    var k = norm(dirs[i]);
    if (!k || want[k]) continue;
    want[k] = dirs[i];
    wanted.push(k);
  }

  // What the launcher wrote last time. Only those entries may be removed —
  // anything else belongs to the user.
  var prev = read(MARK, []);
  if (!Array.isArray(prev)) prev = [];
  var mine = {};
  for (var j = 0; j < prev.length; j++) {
    var pk = norm(prev[j]);
    if (pk) mine[pk] = true;
  }

  var expanded = {};
  for (var a = 0; a < list.length; a++) {
    var e = list[a];
    var ek = norm(e && e.worktree);
    if (ek && expanded[ek] === undefined) expanded[ek] = e.expanded !== false;
  }

  var removed = 0;
  var kept = [];
  for (var b = 0; b < list.length; b++) {
    var item = list[b];
    var nk = norm(item && item.worktree);
    if (!nk) continue;
    if (want[nk]) continue; // rebuilt below, keeps server order
    if (mine[nk]) {
      removed++; // the launcher added it and the server dropped it
      continue;
    }
    if (kept.some(function (x) { return norm(x.worktree) === nk; })) continue;
    kept.push({ worktree: item.worktree, expanded: item.expanded !== false });
  }

  var added = 0;
  var merged = [];
  for (var c = 0; c < wanted.length; c++) {
    var key = wanted[c];
    if (expanded[key] === undefined) added++;
    merged.push({ worktree: want[key], expanded: expanded[key] === undefined ? true : expanded[key] });
  }
  merged = merged.concat(kept);

  state.projects.local = merged;
  var last = state.lastProject.local;
  var lastValid = false;
  for (var d = 0; d < merged.length; d++) {
    if (norm(merged[d].worktree) === norm(last)) {
      lastValid = true;
      break;
    }
  }
  if (!lastValid) {
    if (merged.length) state.lastProject.local = merged[0].worktree;
    else delete state.lastProject.local;
  }

  var after = JSON.stringify(state);
  var changed = after !== before;
  if (changed) localStorage.setItem(KEY, after);
  // Remember exactly what the launcher put there this time — the next run uses
  // it to remove entries the server has since dropped, without touching
  // projects the user added by hand.
  localStorage.setItem(
    MARK,
    JSON.stringify(
      wanted.map(function (k) {
        return want[k];
      })
    )
  );

  return { ok: true, added: added, removed: removed, total: merged.length, changed: changed };
}
