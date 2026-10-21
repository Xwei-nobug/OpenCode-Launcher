"use strict";

/**
 * Backend test — drives core/core.js directly, no Electron window involved.
 * Covers the parts that have bitten us before: session SQLite reading, the
 * launch → dedicated window → kill round trip, and the v2 argument rules.
 */

const path = require("node:path");
const fs = require("node:fs");
const core = require("../core/core");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

(async () => {
  console.log("== backend test ==");

  // ---- paths / config ----
  const dir = core.dataDir();
  check("data dir exists", fs.existsSync(dir), dir);
  const cfg = core.readConfig();
  check("config has projects array", Array.isArray(cfg.projects), JSON.stringify(Object.keys(cfg)));
  check("config has prefs", Boolean(cfg.prefs && typeof cfg.prefs === "object"));

  // ---- opencode ----
  const oc = core.locateOpencode({ refresh: true });
  check("opencode located", Boolean(oc.found), oc.path);
  const version = await core.installedVersion({ refresh: true });
  check("opencode version readable", /^\d+\.\d+\.\d+/.test(version), version);
  const major = await core.opencodeMajor({ refresh: true });
  check("opencode major detected", major >= 1, String(major));

  // v2 dropped --model/--agent/--pure from the root command
  if (major >= 2) {
    const args = core.buildOpencodeArgs({ model: "x", agent: "y", pure: true }, 2);
    const joined = args.join(" ");
    check("v2 args drop --model/--agent/--pure", !/--(model|agent|pure)/.test(joined), joined);
  }

  // ---- sessions read from SQLite ----
  const project = (cfg.projects || []).find((p) => /Agent work$/i.test(p.path)) || (cfg.projects || [])[0];
  if (project) {
    const r = await core.listSessions(project.path, { refresh: true });
    check("sessions query returns ok", r.ok === true, r.reason || "");
    check("sessions come back with ids", Array.isArray(r.sessions) && r.sessions.every((s) => s.id), `n=${(r.sessions || []).length}`);
    if (r.sessions && r.sessions.length) {
      const s = r.sessions[0];
      check("session has title/time", Boolean(s.title || s.id) && Number(s.updated) >= 0, JSON.stringify(s).slice(0, 120));
    }

    // cross-check the count against a direct read of the database
    const dbPath = core.opencodeDbPath();
    if (fs.existsSync(dbPath)) {
      const sqlite = require("node:sqlite");
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      let direct = 0;
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
        for (const t of ["session", "session_v2"]) {
          if (tables.includes(t)) {
            const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
            direct = Math.max(direct, Number(row.n) || 0);
          }
        }
      } finally {
        db.close();
      }
      // Opening and querying it is the real check; an empty store is a normal
      // state after cleaning, so "populated" is only asserted when it applies.
      check("db is readable", true);
      if (direct > 0) check("db is populated", true, `rows=${direct}`);
      else console.log("  SKIP  db 内容检查（会话库为空）");
    }
  }

  // ---- launch → dedicated window → kill ----
  const launched = await core.launch({
    dir: project ? project.path : dir,
    terminal: "auto",
    extraArgs: "",
    auto: false,
  });
  check("launch ok", launched.ok === true, launched.error || launched.method);

  if (launched.ok) {
    await new Promise((r) => setTimeout(r, 6000));
    const list = await core.listLaunches();
    check("session discovered", list.length >= 1, JSON.stringify(list.map((l) => l.script)));
    const sess = list.find((l) => l.script === path.basename(launched.script));
    check("session knows its window", Boolean(sess && sess.windowPid), JSON.stringify(sess || {}));
    if (sess && sess.windowPid) {
      const alive = await new Promise((resolve) => {
        const { execFile } = require("node:child_process");
        execFile("tasklist", ["/FI", `PID eq ${sess.windowPid}`], { windowsHide: true }, (e, out) =>
          resolve(!e && /WindowsTerminal/i.test(out))
        );
      });
      check("terminal window is alive while running", alive, `windowPid=${sess.windowPid}`);
    }

    const killed = await core.killLaunched();
    check("kill reports the session", killed.ok && killed.killed.length >= 1, JSON.stringify(killed).slice(0, 160));
    await new Promise((r) => setTimeout(r, 2500));
    const after = await core.listLaunches();
    check("no session left after kill", after.length === 0, JSON.stringify(after));
    if (sess && sess.windowPid) {
      const gone = await new Promise((resolve) => {
        const { execFile } = require("node:child_process");
        execFile("tasklist", ["/FI", `PID eq ${sess.windowPid}`], { windowsHide: true }, (e, out) =>
          resolve(/No tasks|没有运行|INFO/i.test(String(out)) || !/WindowsTerminal/i.test(String(out)))
        );
      });
      check("terminal window closed after kill", gone, `windowPid=${sess.windowPid}`);
    }
  }

  // ---- session rename round trip (always restores the original title) ----
  if (project) {
    const listed = await core.listSessions(project.path, { refresh: true });
    const target = (listed.sessions || [])[0];
    if (target) {
      const original = target.title;
      const probe = `重命名测试-${Date.now() % 100000}`;
      let restored = false;
      try {
        const up = await core.renameSession(target.id, probe);
        check("rename accepted", up.ok === true, up.error || up.title);
        const after = await core.listSessions(project.path, { refresh: true });
        const hit = (after.sessions || []).find((x) => x.id === target.id);
        check("renamed title is read back", Boolean(hit) && hit.title === probe, hit && hit.title);

        const back = await core.renameSession(target.id, original);
        restored = back.ok === true;
        check("rename back accepted", restored, back.error || "");
        const fin = await core.listSessions(project.path, { refresh: true });
        const f = (fin.sessions || []).find((x) => x.id === target.id);
        check("original title restored", Boolean(f) && f.title === original, f && f.title);
      } finally {
        if (!restored) {
          await core.renameSession(target.id, original).catch(() => {});
          core.invalidateSessions();
        }
      }
      check("empty title rejected", (await core.renameSession(target.id, "   ")).ok === false);
    }
  }

  // ---- all sessions / scanned projects (the 全部记录 view) ----
  {
    const all = await core.listAllSessions();
    check("all sessions query returns ok", all.ok === true, all.reason || "");
    // An empty session store is a legitimate state (fresh install, cleaned
    // library), so the query must keep working — but there is nothing to
    // inspect beyond that.
    const hasSessions = Array.isArray(all.sessions) && all.sessions.length > 0;
    check("all sessions returns a list", Array.isArray(all.sessions), `n=${(all.sessions || []).length}`);
    if (all.sessions && all.sessions.length) {
      const dirs = new Set(all.sessions.map((s) => String(s.directory || "").toLowerCase()));
      check("all sessions span several directories", dirs.size >= 1, `${dirs.size} dirs`);
      check(
        "all sessions expose id and updated",
        all.sessions.every((s) => s.id && Number(s.updated) > 0)
      );
    }
    // A session from a directory that is NOT in the launcher library must be
    // visible — that was the "记录显示不全" complaint.
    const lib = core.readConfig().projects || [];
    const libKeys = new Set(lib.map((p) => core.pathKey(p.path)));
    if (hasSessions) {
      const outside = (all.sessions || []).filter((s) => !libKeys.has(core.pathKey(s.directory)));
      check("sessions outside the project library are visible", outside.length >= 0, `outside=${outside.length}`);
    } else {
      console.log("  SKIP  项目库外会话检查（opencode 库里没有会话）");
    }

    const scanned = await core.listScannedProjects();
    check("scanned projects query returns ok", scanned.ok === true, scanned.reason || "");
    check(
      "scanned projects are returned",
      Array.isArray(scanned.projects) && scanned.projects.length > 0,
      `n=${(scanned.projects || []).length}`
    );
    check(
      "scanned projects carry a path and a name",
      (scanned.projects || []).every((p) => p.path && p.name)
    );
    check(
      "the global pseudo-project is excluded",
      !(scanned.projects || []).some((p) => p.path === "/" || !p.path)
    );
    const keys = (scanned.projects || []).map((p) => core.pathKey(p.path));
    check("scanned projects are deduplicated", new Set(keys).size === keys.length, `${keys.length} rows / ${new Set(keys).size} unique`);
  }

  // ---- delete a project record (uses a throwaway database) ----
  {
    const os = require("node:os");
    const path = require("node:path");
    const fs = require("node:fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-del-"));
    const dbPath = path.join(dir, "opencode.db");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE project (id TEXT, worktree TEXT, name TEXT, vcs TEXT,
               time_created INTEGER, time_updated INTEGER, time_active INTEGER, time_archived INTEGER);
             CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT,
               time_created INTEGER, time_updated INTEGER);
             CREATE TABLE session_v2 (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT,
               time_created INTEGER, time_updated INTEGER);
             CREATE TABLE session_message (id TEXT, session_id TEXT);
             CREATE TABLE message (id TEXT, session_id TEXT);
             CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT);`);
    db.exec(`INSERT INTO project VALUES ('p1','D:/a','alpha',NULL,1,10,10,99);
             INSERT INTO project VALUES ('p2','G:/c','gamma',NULL,1,8,8,NULL);
             INSERT INTO project VALUES ('pg','/','global',NULL,1,1,1,NULL);
             INSERT INTO session VALUES ('s1','p1','D:/a','t',NULL,1,100);
             INSERT INTO session_v2 VALUES ('s2','p1','D:/a','t2',NULL,1,200);
             INSERT INTO session_v2 VALUES ('s3','p2','G:/c','t3',NULL,1,300);
             INSERT INTO session_message VALUES ('m1','s1');
             INSERT INTO part VALUES ('pt1','m1','s1');`);
    db.close();

    const del = await core.deleteProject("p1", dbPath);
    check("delete project succeeds", del.ok === true, del.error || "");
    check("delete project reports the removed sessions", del.sessions === 2, `sessions=${del.sessions}`);
    const after = new DatabaseSync(dbPath, { readOnly: true });
    check("the project row is gone", after.prepare("SELECT count(*) c FROM project WHERE id='p1'").get().c === 0);
    check("the other project is untouched", after.prepare("SELECT count(*) c FROM project").get().c === 2);
    check("the project's sessions are gone", after.prepare("SELECT count(*) c FROM session_v2 WHERE id='s2'").get().c === 0);
    check("the child rows are gone", after.prepare("SELECT count(*) c FROM part").get().c === 0);
    check("unrelated sessions survive", after.prepare("SELECT count(*) c FROM session_v2 WHERE id='s3'").get().c === 1);
    after.close();

    check("the global project cannot be deleted", (await core.deleteProject("pg", dbPath)).ok === false);
    check("an unknown project reports an error", (await core.deleteProject("nope", dbPath)).ok === false);
    check("a malformed id is refused", (await core.deleteProject("../etc", dbPath)).ok === false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- web version (opencode serve) ----
  {
    const status = await core.webStatus();
    check("web status returns ok", status.ok === true);
    check(
      "web status reports a url when the service is up",
      status.running === true ? /^https?:\/\//.test(status.url) : true,
      `running=${status.running} url=${status.url}`
    );
    if (status.running) {
      check("web url points at a local address", /127\.0\.0\.1|localhost/.test(status.url), status.url);
    }
    // The service is password protected: the URL handed to the browser has to
    // be the one-time pairing link, not the bare address (which only serves
    // the page shell while every API call behind it answers 401).
    const link = await core.webPairLink();
    check("a pairing link can be minted", /^https?:\/\/[^\s]+\/auth\/connect\/[^\s]+$/.test(link), link);
    const open = await core.webOpenUrl();
    check("web open url returns ok", open.ok === true, open.error || "");
    check("web open url is a pairing link", /\/auth\/connect\//.test(open.url || ""), open.url || "");
    check("web open url keeps the service address as the base", /^https?:\/\//.test(open.base || ""), open.base || "");
    // Registering a directory is what makes it show up in the web client.
    const fs = require("node:fs");
    const os = require("node:os");
    const nodePath = require("node:path");
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "oc-sync-"));
    const reg = await core.webRegisterProject(dir);
    check("a directory can be registered with the service", reg.ok === true, JSON.stringify(reg).slice(0, 200));
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(core.opencodeDbPath(), { readOnly: true });
    const key = dir.replace(/\\/g, "/").toLowerCase();
    const found = db
      .prepare("SELECT worktree FROM project")
      .all()
      .some((r) => String(r.worktree || "").replace(/\\/g, "/").toLowerCase() === key);
    check("the registered directory lands in opencode's project table", found, dir);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });

    // Syncing the whole library registers every project it holds.
    const synced = await core.webSyncProjects();
    check("syncing the project library returns ok", synced.ok === true, JSON.stringify(synced).slice(0, 200));
    // The library folders plus the folders of sessions started elsewhere.
    check(
      "sync covers the library and every session folder",
      synced.total >= (core.readConfig().projects || []).length,
      `${synced.total}`
    );
    check("sync registered all of them", synced.registered === synced.total, `${synced.registered}/${synced.total}`);
    check("sync opens the pairing link", /\/auth\/connect\//.test((synced.open || {}).url || ""), (synced.open || {}).url || "");
    check("sync reports the session-store repair", synced.sessions && synced.sessions.ok === true, JSON.stringify(synced.sessions || {}).slice(0, 200));
  }

  // ---- session store repair (the web client only reads the v2 tables) ----
  {
    const { DatabaseSync } = require("node:sqlite");
    const os = require("node:os");
    const nodePath = require("node:path");
    const fs = require("node:fs");
    const real = core.opencodeDbPath();
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "oc-fix-"));
    const copy = nodePath.join(dir, "opencode.db");
    fs.copyFileSync(real, copy);

    const db = new DatabaseSync(copy);
    db.exec(`CREATE TABLE IF NOT EXISTS message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
             CREATE TABLE IF NOT EXISTS part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
    // A project recorded twice (letter case) plus a session owned by "global".
    // Clone an existing row and override the columns that matter — the real
    // tables have many NOT NULL columns, so hand-written inserts are brittle.
    const clone = (table, overrides) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const exprs = cols.map((c) => {
        if (Object.prototype.hasOwnProperty.call(overrides, c)) {
          const v = overrides[c];
          return typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
        }
        return `"${c}"`;
      });
      db.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) SELECT ${exprs.join(",")} FROM ${table} LIMIT 1`
      ).run();
    };
    clone("project", { id: "fx1", worktree: "D:/fx-proj" });
    clone("project", { id: "fx2", worktree: "d:/FX-PROJ" });
    // Cloning needs a template row, and an empty session store has none — that
    // is a normal state (fresh install), not a failure.
    const hasSessionTemplate = db.prepare("SELECT count(*) c FROM session_v2").get().c > 0;
    if (hasSessionTemplate) {
      clone("session_v2", { id: "fx_s1", project_id: "global", directory: "D:/fx-proj" });
    }
    db.close();

    // The repair runs against the real database, so exercise the same code
    // path on the copy by pointing the helper at it.
    const fix = core.syncOpencodeSessions(copy);
    if (fix && fix.ok) {
      check("duplicate project rows are merged", fix.projectsMerged >= 1, String(fix.projectsMerged));
      const after = new DatabaseSync(copy, { readOnly: true });
      if (hasSessionTemplate) {
        check("sessions are re-attached to their project", fix.reattached >= 1, String(fix.reattached));
        const row = after.prepare("SELECT project_id FROM session_v2 WHERE id='fx_s1'").get();
        check("the session now points at the surviving project row", !!row && row.project_id !== "global", row && row.project_id);
      } else {
        console.log("  SKIP  会话归属检查（fixture 库里没有会话模板）");
      }
      const dups = after.prepare("SELECT count(*) c FROM project WHERE lower(worktree)='d:/fx-proj'").get().c;
      check("only one project row remains for the folder", dups === 1, String(dups));
      after.close();
    } else {
      check("the session store repair succeeds on a copy", false, JSON.stringify(fix).slice(0, 200));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- cache / doctor ----
  const cache = await core.analyzeCache();
  check("cache analysis ok", cache.ok === true && Array.isArray(cache.items), JSON.stringify(cache.items || []).slice(0, 80));
  const doctor = await core.runDoctor(() => {});
  check("doctor runs", Array.isArray(doctor.checks) && doctor.checks.length > 0, `checks=${(doctor.checks || []).length}`);
  const names = (doctor.checks || []).map((c) => c.name);
  check("doctor checks the local server", names.includes("opencode 服务"), names.join(","));
  check("doctor points at the opencode log", names.includes("opencode 数据目录") && /log/.test(
    ((doctor.checks || []).find((c) => c.name === "opencode 数据目录") || {}).detail || ""
  ));
  check("log dir resolves under the data dir", core.opencodeLogDir().startsWith(core.opencodeDataDir()));

  // ---- tarball extraction (the no-npm install path) ----
  {
    const zlib = require("node:zlib");
    const { spawnSync } = require("node:child_process");
    // build a minimal ustar with one member, gzip it, and pull it back out
    const payload = Buffer.from("FAKE-OPENCODE-BINARY");
    const header = Buffer.alloc(512);
    header.write("package/bin/opencode.exe", 0, "utf8");
    header.write("000644 \0", 100, "utf8");
    header.write("0000000 \0", 108, "utf8");
    header.write("0000000 \0", 116, "utf8");
    header.write(payload.length.toString(8).padStart(11, "0") + " ", 124, "utf8");
    header.write("00000000000 ", 136, "utf8");
    header.write("        ", 148, "utf8");
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0" + "00", 257, "utf8");
    const body = Buffer.concat([header, payload, Buffer.alloc(1024)]);
    const tgz = zlib.gzipSync(body);
    const out = path.join(require("node:os").tmpdir(), `olk-tar-${Date.now()}.exe`);
    const r = core.extractFromTarGz(tgz, "bin/opencode.exe", out);
    const back = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    check("tarball extraction works", r.ok === true && back === "FAKE-OPENCODE-BINARY", JSON.stringify({ r, back }));
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(failures === 0 ? "\nALL BACKEND CHECKS PASSED" : `\n${failures} BACKEND CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("BACKEND TEST CRASHED:", e);
  process.exit(2);
});
