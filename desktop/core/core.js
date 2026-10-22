"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const zlib = require("node:zlib");
const { execFile, spawn, spawnSync } = require("node:child_process");

const APP_DIR_NAME = "opencode-launcher";
// opencode changed npm package name at v2: the v1 line ships as `opencode-ai`
// (its `latest` tag is frozen at the last v1 release, 1.19.0) and the v2 line
// as `@opencode/cli`. Every npm-touching path must pick the package that
// matches the installed line — installing `opencode-ai@latest` on a v2 machine
// silently *downgrades* opencode.
const REGISTRY = "opencode-ai";
const REGISTRY_V2 = "@opencode/cli";
// The v2 package installs both names for the same binary so the two major
// lines can coexist on one machine (`opencode` = v1, `opencode2` = v2).
const OPENCODE_V2_BIN = "opencode2";

/**
 * Product version, taken from package.json so the window, the log and the
 * installer can never disagree.
 */
const BUILD_ID = (() => {
  try {
    return String(require("../package.json").version || "1.0.0");
  } catch {
    return "1.0.0";
  }
})();

/* ---------------------------------------------------------------- paths --- */

function dataDir() {
  const base =
    process.env.APPDATA ||
    (os.homedir() ? path.join(os.homedir(), "AppData", "Roaming") : process.cwd());
  return path.join(base, APP_DIR_NAME);
}

/**
 * Drop launcher-generated working files left behind by previous runs.
 *
 * `run-*.cmd` scripts are in use while their terminal pane lives, so they only
 * go after `maxAgeMs`. One-off probe scripts (`panes-*.ps1` from session
 * discovery, `install-*.ps1`, `npmview-*.ps1`, …) and leftovers of the older
 * single-file launcher (`elevate-*.ps1`, `run-*.ps1`, `instance.json`,
 * `setup-instance.json`, `ui-profiles/`) are never read again and go after an
 * hour, so an occasionally locked file cannot pile up run after run.
 */
function cleanupRunScripts(maxAgeMs = 6 * 60 * 60 * 1000) {
  const HOUR = 60 * 60 * 1000;
  const dir = dataDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const isRunScript = (n) => /^run-\d+-\d+\.cmd$/.test(n);
  const isTemp = (n) =>
    /^(panes|install|npmview|live|kill|elevate|run)-\d+(-\d+)?\.ps1$/.test(n) ||
    n === "instance.json" ||
    n === "setup-instance.json";
  for (const name of names) {
    const p = path.join(dir, name);
    let age = -1;
    try {
      age = Date.now() - fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    const expired = isRunScript(name) ? age > maxAgeMs : isTemp(name) || name === "ui-profiles" ? age > HOUR : false;
    if (!expired) continue;
    try {
      fs.rmSync(p, { recursive: name === "ui-profiles", force: true });
    } catch {
      /* locked — next start tries again */
    }
  }
}

function configPath() {
  return path.join(dataDir(), "config.json");
}

function logPath() {
  return path.join(dataDir(), "launcher.log");
}

const DEFAULT_CONFIG = {
  projects: [],
  lastProject: "",
  prefs: {
    continueSession: false,
    prompt: "",
    extraArgs: "",
    terminal: "auto", // auto | wt | cmd
  },
};

/* -------------------------------------------------------- path comparison --- */

/**
 * Canonical form of a path, for identity comparisons only — never for display
 * or for passing to a subprocess.
 *
 * The native folder picker, the manual path box and previously saved entries can
 * all spell the same directory differently: `D:\Code`, `d:\code`, `D:/Code`,
 * `D:\Code\`. Comparing raw strings makes every variant a separate project, so
 * the library fills with duplicates and the "active" highlight never matches.
 */
function pathKey(p) {
  return String(p || "")
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

/**
 * Store a path in one canonical spelling.
 *
 * Keeps the on-disk form (so it stays valid for subprocesses) but drops
 * redundant trailing separators, and repairs the case if the directory actually
 * exists so the UI shows the real casing rather than whatever the user typed.
 */
function canonicalPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  let out = raw.replace(/\//g, "\\");
  out = out.replace(/\\+$/, "") || out; // never strip a bare drive root like "D:\"
  try {
    // ask the OS for the true casing; falls back silently for missing paths
    const real = fs.realpathSync.native ? fs.realpathSync.native(out) : fs.realpathSync(out);
    out = real.replace(/\//g, "\\");
  } catch {
    /* keep the user's spelling */
  }
  return out;
}

/* --------------------------------------------------------------- logging --- */

function log(msg) {
  try {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logPath(), line, "utf8");
    // keep log bounded at ~2MB
    const st = fs.statSync(logPath());
    if (st.size > 2 * 1024 * 1024) {
      const all = fs.readFileSync(logPath(), "utf8");
      fs.writeFileSync(logPath(), all.slice(-1024 * 1024), "utf8");
    }
  } catch {
    /* logging must never throw */
  }
}

/**
 * Back-compat alias. `shell: true` is accepted and ignored for the known-safe
 * reason documented on runCmd: we always escape argv ourselves.
 */
function exec(cmd, args, opts = {}) {
  const { shell, ...rest } = opts || {};
  if (shell && process.platform !== "win32") {
    // on POSIX the previous behaviour was still correct, keep it
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { ...rest, shell: true, windowsHide: true, env: { ...process.env, ...(rest.env || {}) } },
        (err, stdout, stderr) =>
          resolve({
            code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
            ok: !err,
            stdout: String(stdout || "").trim(),
            stderr: String(stderr || "").trim(),
          })
      );
    });
  }
  return runCmd(cmd, args, rest);
}

/* ----------------------------------------------------------------- config --- */

/** Collapse project entries that differ only in path spelling. Keeps the first. */
function dedupeProjects(list) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const k = pathKey(p && p.path);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      prefs: { ...DEFAULT_CONFIG.prefs, ...(parsed.prefs || {}) },
      // older versions stored one entry per spelling; collapse on read
      projects: dedupeProjects(parsed.projects),
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function writeConfig(cfg) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  // dedupe on the way out too, so no code path can persist spelling duplicates
  const clean = { ...cfg, projects: dedupeProjects(cfg.projects) };
  const tmp = path.join(dir, `config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf8");
  fs.renameSync(tmp, configPath());
  return clean;
}

/* ------------------------------------------------------------- exec utils --- */

/**
 * Run a command, preferring a direct spawn.
 *
 * On Windows a bare `shell: true` plus argv is both a DeprecationWarning
 * (DEP0190) and an injection surface, because the args get concatenated into
 * a `cmd /c` string.
 *
 * Node cannot spawn batch shims (opencode.CMD, npm.cmd) directly, and in a SEA
 * build even `.exe` targets can fail this way. That failure surfaces two ways:
 * as an `err` in the callback, or as a *synchronous* throw from execFile — so
 * both paths have to be covered or the retry never happens.
 */
function runCmd(cmd, args, opts = {}) {
  const { timeout = 30000, cwd, env, windowsHide = true } = opts;
  return new Promise((resolve) => {
    const finish = (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        ok: !err,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    };
    const base = {
      timeout,
      cwd,
      windowsHide,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...(env || {}) },
    };
    const needsShell = (e) =>
      process.platform === "win32" && e && ["EINVAL", "UNKNOWN", "ENOEXEC"].includes(e.code);

    // Retry through cmd.exe, passing argv entries separately: Node applies the
    // standard C-runtime quoting, which correctly protects spaces, CJK and cmd
    // metacharacters (& | % ^). Building one quoted command line by hand is
    // what breaks — cmd's /c strips the outer quotes then chokes on the rest.
    const viaCmd = (err) => {
      if (!needsShell(err)) return finish(err, "", "");
      try {
        execFile(
          process.env.ComSpec || "cmd.exe",
          ["/d", "/c", cmd, ...args],
          base,
          (e2, o2, s2) => finish(e2, o2, s2)
        );
      } catch (e3) {
        finish(err || e3, "", "");
      }
    };

    try {
      execFile(cmd, args, base, (err, stdout, stderr) => {
        if (needsShell(err)) return viaCmd(err);
        finish(err, stdout, stderr);
      });
    } catch (e) {
      viaCmd(e);
    }
  });
}

/** Run a shell command string, streaming output through onLine. */
function execShell(command, { cwd, timeout = 600000, onLine, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        windowsHide,
        env: process.env,
      });
    } catch (e) {
      // a synchronous throw here would otherwise leave the promise pending
      // forever, which reads as a hung "update" or "launch"
      resolve({ code: 1, ok: false, stdout: "", stderr: String(e && e.message) });
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeout);

    const handle = (buf) => {
      const text = buf.toString();
      out += text;
      if (onLine) onLine(text);
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", (b) => {
      err += b.toString();
      if (onLine) onLine(b.toString());
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, ok: false, stdout: out, stderr: err + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, ok: code === 0, stdout: out, stderr: err });
    });
  });
}

/**
 * Spawn a GUI process directly (no shell wrapper) and report whether it was
 * created. Used for the terminal window because the shell route hides it (the
 * wrapper console's `windowsHide` leaves the terminal minimized) and mangles
 * quoting. SEA builds can make spawn throw synchronously on .exe targets, so
 * both the synchronous throw and the async 'error' are handled; success is the
 * 'spawn' event, or simply no error within a short grace period.
 */
function spawnDetached(exe, args, { graceMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: true, pid: child.pid }), graceMs);
    timer.unref();
    child.on("error", (e) => done({ ok: false, error: String((e && e.message) || e) }));
    child.on("spawn", () => done({ ok: true, pid: child.pid }));
    child.unref();
  });
}

/* ------------------------------------------------------- opencode locating --- */

let cachedOpencode = null;

/** Resolve the opencode executable path without spawning a shell. */
function findExecutableOnPath(name) {
  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  const dirs = (process.env.PATH || "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of [exts[0] || ".EXE", ...exts]) {
      const p = path.join(dir, name + ext);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return "";
}

function locateOpencode({ refresh = false } = {}) {
  if (cachedOpencode && !refresh) return cachedOpencode;
  let exe = findExecutableOnPath("opencode");
  // v2 installs `opencode` and `opencode2` as two shims for the same binary so
  // the v1 and v2 lines can coexist; when the v2 package is the one installed,
  // prefer the unambiguous `opencode2` entry point.
  if (!exe || hasV2Package(path.dirname(exe))) {
    const alt = findExecutableOnPath(OPENCODE_V2_BIN);
    if (alt) exe = alt;
  }
  // The installer can drop a standalone opencode.exe next to the launcher exe
  // (that is how a machine with no Node.js at all gets opencode). It wins over
  // anything on PATH: the launcher then always runs the copy it shipped with.
  const own = path.join(path.dirname(process.execPath), "opencode.exe");
  try {
    if (fs.statSync(own).isFile()) exe = own;
  } catch {
    /* not an install with a bundled opencode */
  }
  if (!exe) {
    // common global npm locations
    const guesses = [
      process.env.APPDATA && path.join(process.env.APPDATA, "npm", "opencode.cmd"),
      process.env.APPDATA && path.join(process.env.APPDATA, "npm", "opencode"),
      process.env.APPDATA && path.join(process.env.APPDATA, "npm", "opencode2.cmd"),
      process.env.APPDATA && path.join(process.env.APPDATA, "npm", "opencode2"),
      "/usr/local/bin/opencode",
      "/usr/local/bin/opencode2",
      path.join(os.homedir() || "", ".opencode", "bin", "opencode"),
      path.join(os.homedir() || "", ".opencode", "bin", "opencode2"),
      path.join(os.homedir() || "", ".bun", "bin", "opencode"),
    ].filter(Boolean);
    for (const g of guesses) {
      try {
        if (fs.statSync(g).isFile()) {
          exe = g;
          break;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  cachedOpencode = { path: exe, found: Boolean(exe) };
  return cachedOpencode;
}

/** All plausible npm executables, best-guess first. */
function npmCandidates() {
  const list = [];
  const push = (p) => {
    if (p && !list.includes(p)) list.push(p);
  };
  push(findExecutableOnPath("npm"));
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, "npm", "npm.cmd"));
  for (const base of ["C:\\Program Files\\nodejs", "D:\\nodejs", "C:\\nodejs"]) {
    push(path.join(base, "npm.cmd"));
  }
  return list;
}

/**
 * Pick the npm whose global prefix owns the opencode install directory.
 *
 * This matters on Windows: several node distributions (nvm, WorkBuddy's bundled
 * runtime, system node) can each have their own npm on PATH, and running
 * `npm i -g` with the wrong one installs opencode somewhere the launcher and
 * the user's shell cannot find. So we verify the prefix instead of trusting
 * PATH order, and fall back to PATH order only when nothing matches.
 */
let npmChoice = null;

async function resolveNpm() {
  if (npmChoice) return npmChoice;
  const oc = locateOpencode();
  const installDir = oc.found ? path.dirname(oc.path).toLowerCase() : "";

  for (const npm of npmCandidates()) {
    const r = await exec(npm, ["prefix", "-g"], { shell: true, timeout: 20000 });
    if (!r.ok) continue;
    const prefix = r.stdout.split(/\r?\n/).pop().trim().toLowerCase().replace(/[\\/]$/, "");
    if (!prefix) continue;
    if (installDir && prefix === installDir) {
      npmChoice = npm;
      log(`npm resolved by prefix match: ${npm} -> ${prefix}`);
      return npmChoice;
    }
  }

  npmChoice = npmCandidates()[0] || "npm";
  log(`npm fallback (no prefix match, installDir=${installDir}): ${npmChoice}`);
  return npmChoice;
}

function locateNpm() {
  return npmCandidates()[0] || "npm";
}

/* ------------------------------------------------------- opencode v1 vs v2 --- */

/** Is the v2 package (`@opencode/cli`) installed in this npm global dir? */
function hasV2Package(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, "node_modules", REGISTRY_V2, "package.json"));
  } catch {
    return false;
  }
}

/** Is the v1 package (`opencode-ai`) installed in this npm global dir? */
function hasV1Package(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, "node_modules", REGISTRY, "package.json"));
  } catch {
    return false;
  }
}

/** Every directory that could hold a global npm install of opencode. */
function opencodeInstallDirs() {
  const dirs = [];
  const push = (p) => {
    if (p && !dirs.some((d) => d.toLowerCase() === p.toLowerCase())) dirs.push(p);
  };
  const oc = locateOpencode();
  if (oc.found) push(path.dirname(oc.path));
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, "npm"));
  for (const base of ["C:\\Program Files\\nodejs", "D:\\nodejs", "C:\\nodejs"]) push(base);
  return dirs;
}

/**
 * Which npm package line this machine runs: `@opencode/cli` (v2) or
 * `opencode-ai` (v1).
 *
 * Order matters. The package directory is authoritative — it is what npm will
 * replace on the next install. The installed version is only a fallback for
 * installs that did not come from npm (curl script into ~/.opencode/bin). When
 * nothing is installed at all we default to the v2 line, because that is the
 * current major and what a fresh install should get.
 */
function opencodeNpmPkg() {
  for (const dir of opencodeInstallDirs()) {
    if (hasV2Package(dir)) return REGISTRY_V2;
  }
  for (const dir of opencodeInstallDirs()) {
    if (hasV1Package(dir)) return REGISTRY;
  }
  if (/^1\./.test(cachedVersion || "")) return REGISTRY;
  return REGISTRY_V2;
}

/** Was opencode installed into an npm global prefix (vs curl/bun/brew)? */
function opencodeInstalledViaNpm() {
  const oc = locateOpencode();
  if (!oc.found) return false;
  try {
    return fs.existsSync(path.join(path.dirname(oc.path), "node_modules"));
  } catch {
    return false;
  }
}

let cachedMajor = null;

/**
 * Major version of the installed opencode (1 or 2).
 *
 * Cached because `launch` and the UI preview both need it and the underlying
 * `opencode --version` costs a process spawn. Defaults to 1 when the version
 * cannot be read at all — the v1 argument set is the historical behaviour and
 * opencode being unreadable here means `launch` has already bailed out.
 */
async function opencodeMajor({ refresh = false } = {}) {
  if (cachedMajor !== null && !refresh) return cachedMajor;
  const v = await installedVersion({ refresh });
  const m = String(v).match(/^(\d+)\./);
  cachedMajor = m ? parseInt(m[1], 10) : 1;
  return cachedMajor;
}

/** Drop cached version/major after anything that can change the install. */
function invalidateOpencodeCache() {
  cachedOpencode = null;
  cachedVersion = null;
  cachedMajor = null;
}

let cachedVersion = null;

async function installedVersion({ refresh = false } = {}) {
  if (cachedVersion && !refresh) return cachedVersion;
  const oc = locateOpencode({ refresh });
  if (!oc.found) return "";
  const r = await opencodeExec(["--version"], { timeout: 20000 });
  if (r.ok && r.stdout) {
    const m = r.stdout.match(/\d+\.\d+\.\d+[\w.\-+]*/);
    if (m) {
      cachedVersion = m[0];
      return cachedVersion;
    }
  }
  // fallback: read the global package.json next to the shim
  try {
    const base = path.dirname(oc.path);
    const pj = path.join(base, "node_modules", REGISTRY, "package.json");
    if (fs.existsSync(pj)) {
      cachedVersion = JSON.parse(fs.readFileSync(pj, "utf8")).version || "";
      return cachedVersion;
    }
  } catch {
    /* ignore */
  }
  return "";
}

/* --------------------------------------------------------------- quoting --- */

/**
 * Quote a value for embedding in a command line that a *shell* will re-parse.
 *
 * This is for the strings we build by hand (the command typed into the new
 * terminal window, `explorer.exe "<dir>"`), not for execFile argv — Node
 * already quotes argv correctly, and double-quoting there actively breaks
 * cmd's /c. For those hand-built lines a plain double-quoted token is right.
 */
function quoteForShell(s) {
  const v = String(s);
  if (v === "") return '""';
  if (v.includes('"')) return `"${v.replace(/"/g, '""')}"`;
  return `"${v}"`;
}

/**
 * Build the opencode argument list from UI options.
 *
 * Returns raw tokens, unquoted — quoting is a rendering concern handled by
 * renderArgLine(). Keeping the two apart means callers can log or display the
 * real tokens without a layer of stray quotes leaking into the values.
 *
 * `major` is the installed opencode major version. v2 removed `--model`,
 * `--agent` and `--pure` from the root command ("Unrecognized flag") and
 * offers no replacement flag: the normal TUI resolves its model from the
 * session, the agent, the config `model` key, or a recent model. So on v2
 * those selections are simply not passed — the user picks the model inside
 * opencode (`/model`), which is the v2-native workflow.
 */
function buildOpencodeArgs(opts = {}, major = 1) {
  const args = [];
  if (major >= 2) {
    if (opts.session) args.push("--session", String(opts.session));
    if (opts.continueSession) args.push("--continue");
    if (opts.prompt) args.push("--prompt", String(opts.prompt));
    if (opts.auto) args.push("--auto");
    if (opts.logLevel) args.push("--log-level", String(opts.logLevel));
    // NOTE: opts.extraArgs is intentionally not appended here — it is a
    // user-typed fragment, not a single token. renderArgLine() appends it
    // verbatim so that `--log-level DEBUG` stays two arguments.
    return args;
  }
  if (opts.continueSession) args.push("--continue");
  if (opts.session) args.push("--session", String(opts.session));
  if (opts.model) args.push("--model", String(opts.model));
  if (opts.agent) args.push("--agent", String(opts.agent));
  if (opts.prompt) args.push("--prompt", String(opts.prompt));
  if (opts.auto) args.push("--auto");
  if (opts.pure) args.push("--pure");
  if (opts.logLevel) args.push("--log-level", String(opts.logLevel));
  // NOTE: opts.extraArgs is intentionally not appended here — it is a
  // user-typed fragment, not a single token. renderArgLine() appends it
  // verbatim so that `--log-level DEBUG` stays two arguments.
  return args;
}

/**
 * Render raw tokens as a command line for a shell to re-parse.
 *
 * Each token is quoted only when it needs it, and `extraArgs` — which the user
 * types as a ready-made fragment such as `--log-level DEBUG` — is appended
 * verbatim rather than quoted as a single token, otherwise its spaces would
 * turn into one bogus argument.
 */
function renderArgLine(tokens, extraFragment) {
  const parts = tokens.map((t) => (/[\s"^&|<>()%]/.test(t) ? quoteForShell(t) : t));
  if (extraFragment) parts.push(String(extraFragment));
  return parts.join(" ");
}

/* -------------------------------------------------------------- launching --- */

/**
 * Locate Windows Terminal.
 *
 * `wt.exe` in WindowsApps is an App Execution Alias: a virtual reparse point that
 * `fs.statSync` reports as ENOENT even though the shell resolves it fine. So we
 * cannot probe the filesystem — we ask the shell with `where` instead, and cache
 * the answer (a miss would otherwise cost a subprocess spawn on every launch).
 */
let wtCache = null;

async function resolveWindowsTerminal() {
  if (wtCache !== null) return wtCache;
  const r = await exec("cmd.exe", ["/c", "where", "wt"], { timeout: 8000 });
  const line = `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /wt(\.exe)?$/i.test(l));
  wtCache = line || "";
  if (wtCache) log(`windows terminal: ${wtCache}`);
  return wtCache;
}

/** Synchronous best-effort check, used only for display hints. */
function hasWindowsTerminal() {
  if (wtCache) return wtCache;
  const local = process.env.LOCALAPPDATA;
  const direct =
    local && path.join(local, "Microsoft", "WindowsApps", "wt.exe");
  // existsSync is unreliable for aliases, so only trust a positive real-file hit
  if (direct) {
    try {
      if (fs.statSync(direct).isFile() && fs.statSync(direct).size > 0) return direct;
    } catch {
      /* alias — expected */
    }
  }
  return process.env.WT_PATH || "";
}

/* ---------------------------------------------------------- PowerShell 7 --- */

let psHostCache = null;

/**
 * The best PowerShell available on this machine, as { exe, major }.
 *
 * Prefers PowerShell 7 (pwsh.exe) and falls back to Windows PowerShell 5.1
 * (powershell.exe), which is present on every Windows. Used to run install /
 * version-check scripts off cmd.exe. `exe` is "" only when neither exists.
 */
async function resolvePowerShellHost() {
  if (psHostCache !== null) return psHostCache;

  const exists = (p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };
  const candidates = [];

  /* 1a. whatever `pwsh` resolves to on PATH (system install, scoop shim, …) */
  try {
    const r = await exec("cmd.exe", ["/c", "where", "pwsh"], { timeout: 8000 });
    for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) {
      const t = l.trim();
      if (t && /pwsh(\.exe)?$/i.test(t) && exists(t)) candidates.push(t);
    }
  } catch {
    /* not on PATH in this process environment */
  }

  /* 1b. well-known side-by-side / scoop locations */
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  try {
    for (const d of fs.readdirSync(path.join(pf, "PowerShell"))) {
      candidates.push(path.join(pf, "PowerShell", d, "pwsh.exe"));
    }
  } catch {
    /* no PowerShell directory at all */
  }
  candidates.push(path.join(pf, "PowerShell", "7", "pwsh.exe"));
  candidates.push(path.join(pf, "PowerShell", "7-preview", "pwsh.exe"));
  const home = process.env["USERPROFILE"] || process.env["HOME"] || "";
  if (home) {
    candidates.push(path.join(home, "scoop", "apps", "pwsh", "current", "pwsh.exe"));
    candidates.push(path.join(home, "scoop", "shims", "pwsh.exe"));
  }

  for (const c of candidates) {
    if (exists(c)) {
      psHostCache = { exe: c, major: 7 };
      log(`powershell host: 7 (${c})`);
      return psHostCache;
    }
  }

  /* 1c. last resort: ask the always-present Windows PowerShell where pwsh is */
  const winPs = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  if (exists(winPs)) {
    try {
      const r = await exec(
        winPs,
        ["-NoProfile", "-Command", "(Get-Command pwsh -ErrorAction SilentlyContinue).Source"],
        { timeout: 8000 }
      );
      const src = `${r.stdout}`
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && /pwsh(\.exe)?$/i.test(s));
      if (src && exists(src)) {
        psHostCache = { exe: src, major: 7 };
        log(`powershell host: 7 via Get-Command (${src})`);
        return psHostCache;
      }
    } catch {
      /* Get-Command failed or pwsh not installed */
    }
  }

  /* 2. Windows PowerShell 5.1 — always present with Windows */
  if (exists(winPs)) {
    psHostCache = { exe: winPs, major: 5 };
    log(`powershell host: 5 (${winPs})`);
    return psHostCache;
  }

  psHostCache = { exe: "", major: 0 };
  return psHostCache;
}

/**
 * Track opencode sessions this launcher has started, so they can all be ended
 * on demand (the "关闭 opencode" button). Sessions deliberately OUTLIVE the
 * launcher: exiting the launcher (closing the UI window, Ctrl+C) leaves them
 * running, and only the kill button ends them.
 *
 * opencode is launched through a generated `run-<pid>-<ts>.cmd` script that a
 * terminal pane executes with `cmd /k`. Because the terminal is detached
 * (wt / start / Start-Process), the launcher never holds opencode's PID — but
 * the pane's `cmd /k <script>` command line is a stable handle on the whole
 * tree (cmd → opencode → tool processes). Each session gets its own terminal
 * window (`wt -w new`, spawned directly), and closing a session closes that
 * window whole; a session someone re-homed into a pre-existing window only
 * ever gets its pane (tab) killed — that window is never touched.
 *
 * The in-memory map below only adds metadata (project dir, terminal type).
 * LIVENESS IS DISCOVERED FROM THE PANES, not from this map, so a session
 * started by a *previous* launcher instance is still found — and can still be
 * killed — after a restart. See discoverSessions().
 */
const launches = new Map();
let launchSeq = 0;

function registerLaunch(scriptPath, dir, terminal) {
  const id = ++launchSeq;
  launches.set(id, { id, scriptPath, dir, terminal, startedAt: Date.now() });
  return id;
}

/**
 * Find every live opencode session this launcher started — across restarts.
 *
 * A session is a `run-*.cmd` script in our data dir being executed by a
 * terminal PANE. The pane match is deliberately narrow:
 *
 *   - the command line must START with `cmd /k` (a pane), and
 *   - it must reference a script inside OUR data dir.
 *
 * The second rule keeps out anything the user ran by hand; the first keeps out
 * the transient `cmd /c "wt … cmd /k <script>"` that `execShell` spawns to
 * dispatch the terminal. That transient lives ~15s, carries the same script
 * path, and has the whole terminal window in its descendant tree — matching it
 * would close every tab the user has open. opencode's own background service
 * (`opencode.exe serve --service`) is not a pane and is never matched either:
 * it is a system process this launcher neither started nor owns, which keeps
 * the count, the "running" banner and the kill button on one source of truth.
 *
 * Returns { sessions, probeOk }. On a probe failure, sessions falls back to the
 * in-memory map (so the banner never lies) but callers that kill must refuse
 * rather than act on unverified data.
 */
async function discoverSessions() {
  const meta = new Map();
  for (const info of launches.values()) {
    meta.set(path.basename(info.scriptPath), {
      dir: info.dir,
      terminal: info.terminal,
      startedAt: info.startedAt,
      tracked: true,
    });
  }
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$dir = '${dataDir().replace(/'/g, "''")}'`,
    "$all = Get-CimInstance Win32_Process",
    "$panes = $all | Where-Object {",
    "    $_.CommandLine -and",
    "    $_.CommandLine -match '^\\s*\"?cmd(\\.exe)?\"?\\s+/k\\s' -and",
    "    $_.CommandLine.Contains($dir) -and",
    "    $_.CommandLine -match 'run-\\d+-\\d+\\.cmd'",
    "  }",
    "foreach ($p in $panes) {",
    "  $m = [regex]::Match($p.CommandLine, 'run-\\d+-\\d+\\.cmd')",
    "  if (-not $m.Success) { continue }",
    "  $base = $m.Value",
    "  # Walk up to the terminal window hosting this pane — but only when that",
    "  # window was itself launched for THIS script (a dedicated session",
    "  # window). A window the user already had open carries no script in its",
    "  # command line and must never be touched; only its pane (tab) may close.",
    "  $win = 0",
    "  $cur = $p",
    "  for ($i = 0; $i -lt 6 -and $cur; $i++) {",
    "    if ($cur.ProcessId -eq $cur.ParentProcessId) { break }",
    "    $parent = $all | Where-Object { $_.ProcessId -eq $cur.ParentProcessId } | Select-Object -First 1",
    "    if (-not $parent) { break }",
    "    if ($parent.Name -eq 'WindowsTerminal.exe' -and $parent.CommandLine -and $parent.CommandLine.Contains($base)) { $win = $parent.ProcessId; break }",
    "    $cur = $parent",
    "  }",
    "  Write-Output ($base + '|' + $p.ProcessId + '|' + $win)",
    "}",
  ].join("\r\n");
  const ps1 = path.join(dataDir(), `panes-${process.pid}-${Date.now()}.ps1`);
  try {
    fs.mkdirSync(path.dirname(ps1), { recursive: true });
  } catch {
    /* ignore */
  }
  fs.writeFileSync(ps1, "\uFEFF" + ps, "utf8");
  const panes = new Map();
  const windowPids = new Map();
  let probeOk = true;
  try {
    const r = await execShell(`powershell.exe -NoProfile -File "${ps1}"`, { timeout: 30000, windowsHide: true });
    for (const line of String(r.stdout || "").split(/\r?\n/)) {
      const t = line.trim();
      const parts = t.split("|");
      if (parts.length < 2) continue;
      const base = parts[0].trim();
      const pid = Number(parts[1]);
      if (!/^run-\d+-\d+\.cmd$/.test(base) || !pid) continue;
      if (!panes.has(base)) panes.set(base, []);
      panes.get(base).push(pid);
      const win = Number(parts[2]);
      if (win) windowPids.set(base, win);
    }
  } catch {
    probeOk = false;
  } finally {
    try { fs.rmSync(ps1, { force: true }); } catch { /* ignore */ }
  }
  if (!probeOk) {
    return {
      probeOk: false,
      sessions: [...launches.values()].map((l) => ({
        script: path.basename(l.scriptPath),
        scriptPath: l.scriptPath,
        pids: [],
        windowPid: 0,
        dir: l.dir,
        terminal: l.terminal,
        startedAt: l.startedAt,
        tracked: true,
      })),
    };
  }
  const sessions = [];
  for (const [base, pids] of panes) {
    const m = meta.get(base) || { dir: "", terminal: "", startedAt: 0, tracked: false };
    sessions.push({
      script: base,
      scriptPath: path.join(dataDir(), base),
      pids,
      windowPid: windowPids.get(base) || 0,
      dir: m.dir,
      terminal: m.terminal,
      startedAt: m.startedAt,
      tracked: m.tracked,
    });
  }
  // Prune tracked entries whose pane is gone, so the map cannot grow forever
  // and the count can never show a stale "1" after the user closes a terminal.
  for (const info of [...launches.values()]) {
    if (!panes.has(path.basename(info.scriptPath))) launches.delete(info.id);
  }
  return { probeOk: true, sessions };
}

function listLaunches() {
  return discoverSessions().then(({ sessions }) =>
    sessions.map((l) => ({
      script: l.script,
      dir: l.dir,
      terminal: l.terminal,
      startedAt: l.startedAt,
      pids: l.pids,
      windowPid: l.windowPid,
    }))
  );
}

/** True when at least one launcher-started opencode session is still alive. */
function isLaunchedRunning() {
  return discoverSessions().then(({ sessions }) => sessions.length > 0);
}

/**
 * End every opencode process on the machine ("关闭 opencode").
 *
 * Step 1 tree-kills every launcher-started session pane (`taskkill /T` on the
 * pane: cmd → opencode → tool children), which closes each session's terminal
 * tab without touching the window that hosts it. Step 2 then sweeps the whole
 * machine with `taskkill /IM opencode.exe /F /T`: sessions the user started by
 * hand, orphans from earlier runs, and opencode's own background service — the
 * button means "all of opencode, now", so nothing is filtered by who started
 * it. (The "running" banner stays launcher-scoped on purpose; only the kill is
 * machine-wide.) Step 3 re-scans so the report can tell "killed" from "still
 * running" instead of trusting exit codes.
 */
async function killLaunched() {
  const first = await discoverSessions();
  if (!first.probeOk) {
    return { ok: false, killed: [], stale: [], errors: [{ error: "会话探测失败，请重试" }], swept: 0 };
  }
  const res = { ok: true, killed: [], stale: [], errors: [], swept: 0 };
  // 1) Close each session. A dedicated terminal window (one we spawned for
  //    this session) is killed whole — that takes the pane, the TUI and any
  //    tool processes with it and leaves no terminal behind. A session living
  //    in a window the user already had open gets only its pane (tab) killed;
  //    that window is never touched.
  for (const s of first.sessions) {
    if (s.windowPid) {
      try {
        await runCmd("taskkill", ["/PID", String(s.windowPid), "/F", "/T"], { timeout: 20000 });
      } catch {
        /* the pane kill and the re-scan below decide the verdict */
      }
    }
    for (const pid of s.pids) {
      try {
        await runCmd("taskkill", ["/PID", String(pid), "/F", "/T"], { timeout: 20000 });
      } catch {
        /* the re-scan below decides the verdict */
      }
    }
    try { fs.rmSync(s.scriptPath, { force: true }); } catch { /* ignore */ }
  }
  // 2) Sweep: force-close EVERY opencode process on the machine.
  for (const img of ["opencode.exe", "opencode2.exe"]) {
    try {
      const r = await runCmd("taskkill", ["/IM", img, "/F", "/T"], { timeout: 30000 });
      // One success line per killed process (localized); 128 = "no such
      // process", the expected nothing-left-to-do case.
      if (r.code === 0) {
        res.swept += (String(r.stdout || "").match(/已终止进程|SUCCESS/g) || []).length || 1;
      }
    } catch {
      /* the re-scan below reports anything that survived */
    }
  }
  // 3) Classify what happened to each discovered session.
  const after = await discoverSessions();
  const still = new Set(after.sessions.map((s) => s.script));
  for (const s of first.sessions) {
    if (still.has(s.script)) {
      res.errors.push({ script: s.script, dir: s.dir, error: "会话仍在运行" });
    } else {
      res.killed.push({ script: s.script, dir: s.dir, terminal: s.terminal });
    }
  }
  res.ok = res.errors.length === 0;
  return res;
}

/**
 * Launch opencode in a detached terminal window.
 * Returns { ok, method, command, error }.
 */
async function launch(opts) {
  const dir = opts.dir;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: `目录不存在：${dir}` };
    }
  } catch (e) {
    return { ok: false, error: `无法访问目录：${String(e)}` };
  }

  const oc = locateOpencode();
  if (!oc.found) {
    return { ok: false, error: "未找到 opencode，请先点击「安装 / 修复」" };
  }

  // The argument set depends on the installed major version (v2 dropped
  // --model/--agent/--pure from the root command), so resolve it before
  // building the command line.
  const major = await opencodeMajor();
  const args = buildOpencodeArgs(opts, major);
  // `opencode` here is just the program name for display; the script uses the
  // resolved executable path, so the name must not be baked into the arg line.
  const inner = renderArgLine(args, opts.extraArgs).trim();
  const title = `opencode · ${path.basename(dir) || dir}`;
  const prefer = opts.terminal || "auto";

  // Nested quoting through `wt ... cmd /k "..."` and `start ... cmd /k "..."`
  // is the most fragile part of this whole flow: cmd does not honour
  // backslash escapes, so a model name, a prompt with quotes, or a path with
  // spaces silently corrupts the command. Writing the command to a small .cmd
  // file and launching that removes every layer of quoting — the file is
  // parsed by cmd directly, with no intermediate shell.
  const scriptPath = path.join(dataDir(), `run-${process.pid}-${Date.now()}.cmd`);
  const ocCmd = oc.found ? oc.path : "opencode";
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      "@echo off",
      "chcp 65001 >nul",
      `cd /d "${dir}"`,
      `${ocCmd} ${inner}`,
      "",
    ].join("\r\n"),
    "utf8"
  );

  const methods = [];
  const wt = hasWindowsTerminal() || (prefer !== "cmd" ? await resolveWindowsTerminal() : "");

  if ((prefer === "wt" || prefer === "auto") && wt) {
    // Preferred: spawn wt DIRECTLY — no `cmd /c` wrapper — with a dedicated
    // window (`-w new`). Two reasons this beats the shell route: the wrapper's
    // hidden console (execShell's windowsHide) leaves the terminal minimized
    // where the user can't see it, and its quoting layer corrupts paths. A
    // dedicated window per session is also what lets "关闭 opencode" close the
    // terminal outright instead of leaving a zombie tab behind.
    methods.push({
      name: "Windows Terminal",
      direct: true,
      exe: wt,
      args: ["-w", "new", "-d", dir, "--title", title, "cmd", "/k", scriptPath],
    });
    // Fallback: the same window through the shell, for builds where the direct
    // spawn is rejected (SEA can make spawn throw on .exe targets).
    methods.push({
      name: "Windows Terminal",
      cmd: `"${wt}" -d "${dir}" --title "${title}" cmd /k "${scriptPath}"`,
    });
  } else if (prefer === "wt") {
    fs.rmSync(scriptPath, { force: true });
    return { ok: false, error: "未检测到 Windows Terminal，请改用「自动选择」或「命令提示符」" };
  }
  if (prefer === "cmd" || prefer === "auto" || methods.length === 0) {
    methods.push({
      name: "命令提示符",
      cmd: `cmd.exe /c start "opencode" /D "${dir}" cmd /k "${scriptPath}"`,
    });
    methods.push({
      name: "PowerShell",
      cmd: `powershell.exe -NoProfile -Command "Start-Process cmd -ArgumentList '/k','${scriptPath.replace(
        /'/g,
        "''"
      )}' -WorkingDirectory '${dir.replace(/'/g, "''")}'"`,
    });
  }

  for (const m of methods) {
    if (m.direct) {
      const r = await spawnDetached(m.exe, m.args);
      if (r.ok) {
        log(`launch dir=${dir} method=${m.name} (direct) args=${inner} script=${scriptPath}`);
        registerLaunch(scriptPath, dir, m.name);
        return { ok: true, method: m.name, command: m.args.join(" "), args, script: scriptPath };
      }
      log(`launch method failed (${m.name}, direct): ${r.error}`);
      continue;
    }
    const r = await execShell(m.cmd, { timeout: 15000 });
    // start/wt return quickly; a zero exit means the window was dispatched
    if (r.code === 0) {
      log(`launch dir=${dir} method=${m.name} args=${inner} script=${scriptPath}`);
      registerLaunch(scriptPath, dir, m.name);
      return { ok: true, method: m.name, command: m.cmd, args, script: scriptPath };
    }
    log(`launch method failed (${m.name}): code=${r.code} ${r.stderr || r.stdout}`);
  }
  fs.rmSync(scriptPath, { force: true });
  const last = methods[methods.length - 1];
  return {
    ok: false,
    error: `启动失败：${last ? last.stderr || last.stdout || "未知错误" : "无可用终端"}`,
  };
}


const PROJECT_MARKERS = [
  "opencode.json",
  "opencode.jsonc",
  "AGENTS.md",
  ".git",
  "package.json",
  "go.mod",
  "pyproject.toml",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "requirements.txt",
  "composer.json",
  "Makefile",
];

function isProjectDir(dir) {
  for (const m of PROJECT_MARKERS) {
    try {
      if (fs.existsSync(path.join(dir, m))) return m;
    } catch {
      /* ignore */
    }
  }
  return "";
}


/* ------------------------------------------------------------- git status --- */

async function gitStatus(dir) {
  const git = findExecutableOnPath("git");
  if (!git) return { ok: false, isRepo: false, reason: "未找到 git" };
  const r = await exec(git, ["-C", dir, "status", "--porcelain=v1", "--branch", "-z"], {
    timeout: 15000,
  });
  if (!r.ok) {
    return { ok: false, isRepo: false, reason: r.stderr || "不是 Git 仓库" };
  }
  const raw = r.stdout;
  const nul = raw.indexOf("\u0000");
  const header = nul === -1 ? raw : raw.slice(0, nul);
  const body = nul === -1 ? "" : raw.slice(nul + 1);
  const branchLine = header.split("\n").find((l) => l.startsWith("## ")) || "";
  const branch = branchLine.replace(/^##\s*/, "").split("...")[0].trim();
  const ahead = /\[.*?\+(\d+)/.exec(branchLine);
  const behind = /\[.*?-(\d+)/.exec(branchLine);
  const files = body.split("\u0000").filter(Boolean);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const sample = [];
  for (const line of files) {
    const x = line[0];
    const y = line[1];
    const name = line.slice(3).replace(/^"|"$/g, "");
    if (x === "?" && y === "?") untracked++;
    else {
      if (x !== " ") staged++;
      if (y !== " ") unstaged++;
    }
    if (sample.length < 8) sample.push({ name, status: x === "?" && y === "?" ? "?" : `${x}${y}` });
  }
  return {
    ok: true,
    isRepo: true,
    branch,
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    staged,
    unstaged,
    untracked,
    clean: staged + unstaged + untracked === 0,
    files: sample,
  };
}

/* --------------------------------------------------------- opencode extras --- */

/**
 * Invoke opencode using its resolved absolute path.
 *
 * A bare "opencode" cannot be spawned on Windows: opencode ships as opencode.CMD,
 * and Node's execFile will not resolve a PATHEXT-less bare name for a batch shim
 * (it fails with EINVAL/ENOENT, and after we dropped `shell: true` there is no
 * longer a shell to fall back to). Always go through the resolved path.
 */
async function opencodeExec(args, opts = {}) {
  const oc = locateOpencode({ refresh: opts.refresh });
  if (!oc.found) {
    return { ok: false, code: 1, stdout: "", stderr: "未找到 opencode" };
  }
  return exec(oc.path, args, opts);
}

/* ------------------------------------------------------------------ sessions --- */

/**
 * Read opencode's sessions.
 *
 * opencode keeps every session in one global SQLite database
 * (`~/.local/share/opencode/opencode.db`, WAL mode) — the config directory holds
 * no session data. v2 removed the `opencode db "<SQL>" --format json` entry
 * point (the whole `db` subcommand is gone), so the database is now read
 * directly with Node's built-in `node:sqlite` module — no dependency, no
 * subprocess. The layout differs per version and is discovered at runtime:
 * v1 uses `session` + `message`; early v2 keeps both generations side by side
 * (new rows only in `session_v2` / `session_message`); a fresh 2.0.30 install
 * creates `session_v2` + `session_message` ONLY. `opencode session list` is a
 * human-readable table that only covers the *current* directory and no JSON
 * or filter flags, so it stays useless here.
 *
 * Sessions are grouped by `session.directory` (an absolute, forward-slash path).
 * Do NOT try `project_id` — on this machine every session has project_id
 * 'global', and the `workspace` / `project_directory` tables are empty.
 */
function sessionSql(table, minimal = false) {
  if (minimal) {
    return (
      "SELECT s.id, s.slug, s.directory, s.title, s.agent, s.time_created, s.time_updated " +
      `FROM ${table} s ORDER BY s.time_updated DESC LIMIT 1000`
    );
  }
  return (
    "SELECT s.id, s.slug, s.directory, s.title, s.agent, s.model, s.cost, " +
    "s.tokens_input, s.tokens_output, s.time_created, s.time_updated, " +
    "(SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count " +
    `FROM ${table} s ` +
    "WHERE s.time_archived IS NULL " +
    "ORDER BY s.time_updated DESC LIMIT 1000"
  );
}

/**
 * Tables that can hold sessions, best first.
 *
 * v2 added `session_v2` next to `session`: new sessions are written to
 * `session_v2` ONLY, and opencode 2.0.30 stopped creating the legacy
 * `session` table altogether (a fresh install has `session_v2` alone).
 * Both are read and merged — picking just the first table that exists used
 * to hide every v2-only session on databases that still had the legacy one.
 */
const SESSION_TABLES = ["session", "session_v2"];

/**
 * Tables that can hold messages, best first.
 *
 * v2 projects messages into `session_message`; v1 (and databases migrated
 * from it) keep them in `message`. A migrated database has both, with
 * `session_message` as the superset.
 */
const MESSAGE_TABLES = ["session_message", "message"];

/** Where opencode keeps its database (honours XDG_DATA_HOME like opencode does). */
function opencodeDbPath() {
  const home = os.homedir() || "";
  const xdg = process.env.XDG_DATA_HOME;
  const dataDir = xdg ? path.join(xdg, "opencode") : path.join(home, ".local", "share", "opencode");
  return path.join(dataDir, "opencode.db");
}

/* ----------------------------------------------------- opencode cache mgmt --- */

/**
 * Directory opencode keeps its data in (session DB, logs, caches).
 *
 * Mirrors opencode's own resolution: honour XDG_DATA_HOME, else
 * ~/.local/share/opencode. The launcher's session reader lives in the same
 * directory (opencode.db), so this is the single source of truth for "where
 * does opencode keep its stuff" — the cache panel surfaces it because opencode
 * does not expose it anywhere in its own UI.
 */
function opencodeDataDir() {
  const home = os.homedir() || "";
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(home, ".local", "share", "opencode");
}

/**
 * Where opencode keeps its own logs. When the TUI reports a server error
 * (a 5xx while sending a message), the real reason — provider auth, a failed
 * migration, a crash — is written here, not in the launcher's log.
 */
function opencodeLogDir() {
  return path.join(opencodeDataDir(), "log");
}

/** Recursive byte size of a file or directory (0 on any error). */
function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      let total = 0;
      for (const e of fs.readdirSync(p)) total += sizeOf(path.join(p, e));
      return total;
    }
    return st.size;
  } catch {
    return 0;
  }
}

/** True when an opencode process is alive (so its DB/WAL are live). */
function isOpencodeRunning() {
  try {
    const r = require("node:child_process").spawnSync("tasklist", ["/nh", "/fo", "csv"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    return /opencode2?\.exe/i.test((r.stdout || "") + (r.stderr || ""));
  } catch {
    return false;
  }
}

/**
 * Categories the cache panel can show and clean. `db` is the session database
 * itself — it is deliberately NOT clearable here (deleting sessions is a
 * per-session choice in the Sessions panel); only its side caches are. `wal` is
 * clearable but risky while opencode runs (it holds uncheckpointed writes).
 */
const CACHE_KINDS = [
  { key: "db", name: "会话数据库", type: "file", file: "opencode.db", clearable: false,
    note: "全部会话的 SQLite 数据库；删除请使用左侧「会话」面板逐条删除" },
  { key: "wal", name: "WAL 预写日志", type: "files", files: ["opencode.db-wal", "opencode.db-shm"], clearable: true, risky: true,
    note: "数据库的事务日志；opencode 未运行时可清理以回收空间" },
  { key: "log", name: "运行日志", type: "dir", dir: "log", clearable: true,
    note: "opencode 的运行日志" },
  { key: "repos", name: "仓库缓存", type: "dir", dir: "repos", clearable: true,
    note: "克隆的仓库缓存；清理后首次使用会重新克隆" },
  { key: "shell", name: "Shell 历史", type: "dir", dir: "shell", clearable: true,
    note: "会话内的 shell 命令历史" },
  { key: "tool", name: "工具输出", type: "dir", dir: "tool-output", clearable: true,
    note: "工具调用的输出缓存" },
];

/** Inventory opencode's data directory: path, size breakdown, run state. */
async function analyzeCache() {
  const dir = opencodeDataDir();
  if (!fs.existsSync(dir)) {
    return { ok: true, path: dir, exists: false, running: false, items: [], total: 0 };
  }
  const running = await isLaunchedRunning();
  const items = [];
  let total = 0;
  for (const k of CACHE_KINDS) {
    let size = 0;
    let present = false;
    if (k.type === "file") {
      const p = path.join(dir, k.file);
      present = fs.existsSync(p);
      size = present ? sizeOf(p) : 0;
    } else if (k.type === "files") {
      for (const f of k.files || []) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) { present = true; size += sizeOf(p); }
      }
    } else {
      const p = path.join(dir, k.dir);
      present = fs.existsSync(p);
      size = present ? sizeOf(p) : 0;
    }
    total += size;
    items.push({
      key: k.key,
      name: k.name,
      note: k.note,
      size,
      present,
      clearable: k.clearable && present && (k.risky ? !running : true),
      risky: Boolean(k.risky) && present,
    });
  }
  // surface anything opencode adds that we did not enumerate
  let other = 0;
  try {
    for (const e of fs.readdirSync(dir)) {
      const known = CACHE_KINDS.some((k) =>
        (k.type === "file" && k.file === e) ||
        (k.type === "files" && (k.files || []).includes(e)) ||
        (k.type === "dir" && k.dir === e));
      if (!known) other += sizeOf(path.join(dir, e));
    }
  } catch { /* ignore */ }
  if (other > 0) {
    items.push({ key: "other", name: "其他文件", note: "未分类的文件", size: other, present: true, clearable: false, risky: false });
    total += other;
  }
  return { ok: true, path: dir, exists: true, running, items, total };
}

/** Remove the selected cache categories. `db` is never touched here. */
async function clearCache(targets) {
  const dir = opencodeDataDir();
  const wanted = new Set(Array.isArray(targets) ? targets : []);
  const cleared = [];
  const skipped = [];
  const running = await isLaunchedRunning();
  for (const k of CACHE_KINDS) {
    if (!wanted.has(k.key)) continue;
    if (!k.clearable) { skipped.push({ key: k.key, reason: "该类别不支持清理" }); continue; }
    if (k.risky && running) { skipped.push({ key: k.key, reason: "opencode 正在运行" }); continue; }
    try {
      if (k.type === "file") {
        const p = path.join(dir, k.file);
        if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); cleared.push(k.key); }
      } else if (k.type === "files") {
        for (const f of k.files || []) {
          const p = path.join(dir, f);
          if (fs.existsSync(p)) fs.rmSync(p, { force: true });
        }
        cleared.push(k.key);
      } else {
        const p = path.join(dir, k.dir);
        if (fs.existsSync(p)) {
          for (const e of fs.readdirSync(p)) {
            fs.rmSync(path.join(p, e), { recursive: true, force: true });
          }
          cleared.push(k.key);
        }
      }
    } catch (e) {
      skipped.push({ key: k.key, reason: String((e && e.message) || e) });
    }
  }
  return { ok: cleared.length > 0, cleared, skipped };
}

let sqliteModule; // undefined = not tried yet, null = unavailable
function getSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    // Electron 38 bundles Node 22.22, where node:sqlite is available without a
    // flag (it only prints an experimental warning). If a future runtime drops
    // it, sessions fall back to the `opencode db` CLI below.
    // eslint-disable-next-line global-require
    sqliteModule = require("node:sqlite");
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

const SESSION_TTL = 10 * 1000;
const SESSION_CACHE_MAX = 24;
const sessionCache = new Map(); // pathKey -> { at, sessions }
const sessionInflight = new Map(); // pathKey -> Promise (concurrency dedupe)

/** `opencode db` prints JSON, but tolerate any banner text around it. */
function parseDbJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* may be wrapped in extra output */
  }
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

/** The `model` column is a JSON string like {"providerID":..,"modelID":..}. */
function sessionModel(raw) {
  if (!raw) return "";
  if (typeof raw === "object") return String(raw.modelID || raw.model || raw.id || "");
  const t = String(raw).trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return t;
  try {
    const j = JSON.parse(t);
    if (j && typeof j === "object") {
      return String(j.modelID || j.model || j.id || j.name || t);
    }
    return String(j);
  } catch {
    return t;
  }
}

const sessionNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

function normalizeSession(row) {
  const r = row || {};
  return {
    id: String(r.id || ""),
    slug: String(r.slug || ""),
    directory: String(r.directory || ""),
    // Keep the title empty when opencode has none — the renderer then shows
    // the same "New session - <date>" label opencode itself uses.
    title: String(r.title || ""),
    agent: String(r.agent || ""),
    model: sessionModel(r.model),
    cost: sessionNum(r.cost),
    tokensIn: sessionNum(r.tokens_input),
    tokensOut: sessionNum(r.tokens_output),
    created: sessionNum(r.time_created),
    updated: sessionNum(r.time_updated),
    messages: sessionNum(r.message_count),
  };
}

/**
 * Read sessions straight from the SQLite file.
 *
 * Returns null when this runtime has no `node:sqlite` (the caller then falls
 * back to the CLI), or `{ok, sessions}` / `{ok:false, reason, sessions:[]}`.
 * A missing database file is a definitive answer, not a fallback trigger.
 */
function querySessionsSqlite(key) {
  const sqlite = getSqlite();
  if (!sqlite || !sqlite.DatabaseSync) return null;

  const dbPath = opencodeDbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `未找到 opencode 数据库：${dbPath}`, sessions: [] };
  }

  let db = null;
  try {
    // Read-only keeps us clear of the WAL lock held by the running opencode
    // service. If a read-only handle cannot be opened (some hardened setups),
    // retry read-write — the file exists, so this cannot create anything.
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    } catch {
      db = new sqlite.DatabaseSync(dbPath);
    }
    // Merge every session table this database has. A database can carry the
    // legacy `session` (frozen v1 rows), the live `session_v2`, or both; the
    // same id can appear in each, so the row with the newer time_updated
    // wins (ties go to the later table, which is the live one).
    const merged = new Map(); // id -> row
    let readable = false;
    for (const table of SESSION_TABLES) {
      const rows = readSessionRows(db, table);
      if (rows === null) continue; // not a session table in this database
      readable = true;
      for (const row of rows) {
        const id = String((row && row.id) || "");
        if (!id) continue;
        const prev = merged.get(id);
        if (!prev || sessionNum(row.time_updated) >= sessionNum(prev.time_updated)) merged.set(id, row);
      }
    }
    if (!readable) {
      // The database exists but holds no recognisable session table at all —
      // the only case where "upgrade opencode" is genuinely the right advice.
      return { ok: false, reason: "opencode 会话表结构不匹配，请升级 opencode", sessions: [] };
    }
    return { ok: true, sessions: filterSessions([...merged.values()], key) };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 300);
    log(`listSessions sqlite failed db=${dbPath}: ${why}`);
    return { ok: false, reason: "读取会话失败：" + why, sessions: [] };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Rename a session.
 *
 * The official way is the server API — `PATCH /session/:id` with `{title}` —
 * reached through `opencode api session.update`, which talks to the background
 * service (starting it when it is not running) and writes the title together
 * with time_updated. Going through the service keeps any open TUI in sync with
 * the database; a raw UPDATE could be clobbered by the service's next write.
 *
 * If the CLI route fails (an older build without `api`, or a broken install),
 * fall back to a direct SQLite update of every session table that holds the id
 * — the merged reader takes the row with the newer time_updated, so updating
 * all of them keeps the title consistent.
 */
async function renameSession(id, title) {
  const sid = String(id || "").trim();
  const next = String(title == null ? "" : title).replace(/\s+/g, " ").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(sid)) return { ok: false, error: "会话 ID 无效" };
  if (!next) return { ok: false, error: "标题不能为空" };
  if (next.length > 200) return { ok: false, error: "标题最多 200 个字符" };

  const r = await opencodeExec(
    ["api", "session.update", "--param", `sessionID=${sid}`, "-d", JSON.stringify({ title: next })],
    { timeout: 60000 }
  );
  invalidateSessions();
  const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
  if (r.ok && !/^\s*(usage|opencode\s+api)/im.test(out)) {
    log(`session renamed ${sid} -> ${next}`);
    return { ok: true, id: sid, title: next };
  }
  log(`session rename via api failed ${sid}: ${out.slice(0, 300)}; trying sqlite`);

  try {
    const sqlite = getSqlite();
    if (!sqlite) throw new Error("当前运行时不支持 SQLite");
    const db = new sqlite.DatabaseSync(opencodeDbPath());
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
      let changed = 0;
      for (const t of ["session_v2", "session"]) {
        if (!tables.includes(t)) continue;
        const res = db.prepare(`UPDATE ${t} SET title = ? WHERE id = ?`).run(next, sid);
        changed += Number(res && res.changes) || 0;
      }
      if (!changed) return { ok: false, error: "未找到该会话，可能已被删除" };
    } finally {
      db.close();
    }
    invalidateSessions();
    log(`session renamed via sqlite ${sid} -> ${next}`);
    return { ok: true, id: sid, title: next };
  } catch (e) {
    const why = String((e && e.message) || e);
    log(`session rename failed ${sid}: ${why}`);
    return {
      ok: false,
      error: /EBUSY|database is locked|SQLITE_BUSY/i.test(why)
        ? "会话库被占用，请稍后重试"
        : `重命名失败：${why.slice(0, 160)}`,
    };
  }
}

/** Does a table with this name exist? sqlite_master is the only authority. */
function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch {
    return false;
  }
}

/** Column names of a table, or null when the table does not exist. */
function tableColumns(db, name) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${name})`).all();
    return rows.length ? new Set(rows.map((r) => r.name)) : null;
  } catch {
    return null;
  }
}

/**
 * Message-count expression for whichever message tables exist.
 *
 * MAX over the existing tables: a v1-migrated database holds the same
 * messages in both (the counts agree), a v2-only session lives in
 * `session_message` alone, a v1-only session in `message` alone. No message
 * table at all (a fresh opencode 2.0.30 install) -> the count is simply 0.
 */
function messageCountSql(db) {
  const present = MESSAGE_TABLES.filter((t) => tableExists(db, t));
  if (!present.length) return "0 AS message_count";
  const counts = present.map((t) => `SELECT COUNT(*) AS c FROM ${t} WHERE session_id = s.id`);
  return `(SELECT MAX(c) FROM (${counts.join(" UNION ALL ")})) AS message_count`;
}

/**
 * Rows from one candidate session table, or null when this database has no
 * such table (or nothing shaped like one).
 *
 * The query is built from the live schema (PRAGMA table_info) rather than a
 * fixed column list, so v1 and v2 databases both work. Never decide anything
 * from exception text: the old code regexed "no such table" out of the error
 * and could not tell a missing session table from a missing *referenced*
 * table — which is exactly how a fresh opencode 2.0.30 database (no legacy
 * `message` table) got misreported as "table structure mismatch".
 */
function readSessionRows(db, table) {
  const cols = tableColumns(db, table);
  if (!cols) return null;
  // Without these the table cannot be filtered, ordered or identified.
  for (const req of ["id", "directory", "time_updated"]) {
    if (!cols.has(req)) return null;
  }
  const optional = [
    "id",
    "slug",
    "directory",
    "title",
    "agent",
    "model",
    "cost",
    "tokens_input",
    "tokens_output",
    "time_created",
    "time_updated",
  ];
  const select = optional.filter((c) => cols.has(c)).map((c) => `s.${c}`);
  const where = cols.has("time_archived") ? "WHERE s.time_archived IS NULL " : "";
  const sql =
    `SELECT ${select.join(", ")}, ${messageCountSql(db)} ` +
    `FROM ${table} s ${where}` +
    "ORDER BY s.time_updated DESC LIMIT 1000";
  try {
    return db.prepare(sql).all();
  } catch (e) {
    // The schema said this should work; if it still fails, skip the table
    // instead of aborting the merge — another table may be readable.
    log(`readSessionRows ${table} failed: ${String((e && e.message) || e).slice(0, 200)}`);
    return null;
  }
}

/**
 * Normalize + keep only the sessions that belong to this exact directory.
 *
 * Filtering happens in JS rather than in SQL: the directory comes from the user
 * (pasted, from the native picker, or restored config), and interpolating it
 * would mean reasoning about SQLite string escaping *and* cmd.exe quote
 * handling on the CLI fallback path. Matching here also reuses pathKey(), so a
 * session matches exactly when the project library would treat it as the same
 * folder.
 */
function filterSessions(rows, key) {
  const list = Array.isArray(rows) ? rows : [rows];
  return list
    .map(normalizeSession)
    .filter((s) => s.id && pathKey(s.directory) === key)
    .sort((a, b) => b.updated - a.updated);
}

async function querySessions(key, dir) {
  const oc = locateOpencode();
  if (!oc.found) return { ok: false, reason: "未找到 opencode，无法读取会话", sessions: [] };

  const direct = querySessionsSqlite(key);
  if (direct) return direct;

  // No node:sqlite (ancient runtime): the v1 CLI still answers, and is the
  // only option left.
  const r = await opencodeExec(["db", sessionSql("session"), "--format", "json"], { timeout: 25000 });
  let rows = r.ok ? parseDbJson(r.stdout) : null;

  if (!rows) {
    const r2 = await opencodeExec(["db", sessionSql("session", true), "--format", "json"], {
      timeout: 25000,
    });
    rows = r2.ok ? parseDbJson(r2.stdout) : null;
    if (!rows) {
      const why = String(r.stderr || r.stdout || r2.stderr || r2.stdout || "未知错误")
        .trim()
        .slice(0, 300);
      log(`listSessions failed dir=${dir}: ${why}`);
      return { ok: false, reason: "读取会话失败：" + why, sessions: [] };
    }
  }
  return { ok: true, sessions: filterSessions(rows, key) };
}

/**
 * Every session opencode has, across all directories.
 *
 * `listSessions` filters by one project directory, so anything the user
 * started inside opencode itself (in a folder the launcher never recorded)
 * was invisible in the UI. This returns the unfiltered set.
 */
async function listAllSessions() {
  const sqlite = getSqlite();
  if (!sqlite || !sqlite.DatabaseSync) {
    return { ok: false, reason: "当前运行时不支持 SQLite", sessions: [] };
  }
  const dbPath = opencodeDbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `未找到 opencode 数据库：${dbPath}`, sessions: [] };
  }
  let db = null;
  try {
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    } catch {
      db = new sqlite.DatabaseSync(dbPath);
    }
    const merged = new Map();
    let readable = false;
    for (const table of SESSION_TABLES) {
      const rows = readSessionRows(db, table);
      if (rows === null) continue;
      readable = true;
      for (const row of rows) {
        const id = String((row && row.id) || "");
        if (!id) continue;
        const prev = merged.get(id);
        if (!prev || sessionNum(row.time_updated) >= sessionNum(prev.time_updated)) merged.set(id, row);
      }
    }
    if (!readable) {
      return { ok: false, reason: "opencode 会话表结构不匹配，请升级 opencode", sessions: [] };
    }
    const sessions = [...merged.values()]
      .map(normalizeSession)
      .filter((s) => s.id)
      .sort((a, b) => b.updated - a.updated);
    return { ok: true, sessions };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 300);
    log(`listAllSessions failed db=${dbPath}: ${why}`);
    return { ok: false, reason: "读取会话失败：" + why, sessions: [] };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Every project opencode itself knows about — the `project` table is the
 * authoritative list of worktrees that were ever opened in the TUI.
 */
async function listScannedProjects() {
  const sqlite = getSqlite();
  if (!sqlite || !sqlite.DatabaseSync) {
    return { ok: false, reason: "当前运行时不支持 SQLite", projects: [] };
  }
  const dbPath = opencodeDbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `未找到 opencode 数据库：${dbPath}`, projects: [] };
  }
  let db = null;
  try {
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    } catch {
      db = new sqlite.DatabaseSync(dbPath);
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
    if (!tables.includes("project")) return { ok: true, projects: [] };
    const cols = tableColumns(db, "project");
    const want = ["id", "worktree", "name", "vcs", "time_created", "time_updated", "time_active", "time_archived"];
    const select = want.filter((c) => cols.has(c));
    const rows = db.prepare(`SELECT ${select.join(", ")} FROM project`).all();
    const byKey = new Map();
    for (const row of rows) {
      const worktree = String((row && row.worktree) || "");
      if (!worktree || worktree === "/") continue; // "global" is not a folder
      // opencode records whatever directory it was started from as a project —
      // `C:\Users\Wei` when the launcher itself was launched from home, a temp
      // folder otherwise. Those rows look exactly like user-added projects, so
      // they are dropped here rather than shown as phantom entries.
      if (isScratchPath(pathKey(worktree))) continue;
      const p = {
        id: String(row.id || ""),
        path: worktree,
        name:
          String(row.name || "") ||
          path.basename(worktree) ||
          worktree,
        vcs: String(row.vcs || ""),
        archived: row.time_archived != null,
        active: sessionNum(row.time_active),
        updated: sessionNum(row.time_updated),
        exists: fs.existsSync(worktree) && fs.statSync(worktree).isDirectory(),
      };
      const key = pathKey(worktree);
      const prev = byKey.get(key);
      // The same folder can be recorded twice with different letter case.
      if (!prev || (prev.archived && !p.archived)) byKey.set(key, p);
    }
    const projects = [...byKey.values()].sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return b.updated - a.updated;
    });
    return { ok: true, projects };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 300);
    log(`listScannedProjects failed db=${dbPath}: ${why}`);
    return { ok: false, reason: "读取项目失败：" + why, projects: [] };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Delete a project record from opencode's own `project` table.
 *
 * opencode has no CLI/API for removing a project, so the row has to go from
 * the database directly. Two things make that safe here:
 *
 * - the row is matched by **id** (never by path), and the global pseudo
 *   project (`worktree === "/"`) is refused outright — it holds every session
 *   that has no real directory;
 * - the session tables are cleaned explicitly instead of relying on the
 *   `ON DELETE CASCADE` foreign key, because SQLite only enforces foreign
 *   keys when `PRAGMA foreign_keys = ON` is set on the very connection that
 *   performs the delete, and opencode's own connections do not guarantee it.
 *
 * Only the records are removed — nothing on disk is touched.
 */
async function deleteProject(id, dbPathOverride) {
  const pid = String(id || "").trim();
  if (!pid || pid.length > 128 || !/^[A-Za-z0-9_-]+$/.test(pid)) {
    return { ok: false, error: "项目 ID 无效" };
  }
  const sqlite = getSqlite();
  if (!sqlite || !sqlite.DatabaseSync) {
    return { ok: false, error: "当前运行时不支持 SQLite" };
  }
  const dbPath = dbPathOverride || opencodeDbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: "未找到 opencode 数据库" };
  }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
    if (!tables.includes("project")) return { ok: false, error: "opencode 数据库缺少 project 表" };
    const hit = db.prepare("SELECT id, worktree FROM project WHERE id = ?").get(pid);
    if (!hit) return { ok: false, error: "项目不存在，可能已被删除" };
    const worktree = String(hit.worktree || "");
    if (!worktree || worktree === "/") return { ok: false, error: "不能删除全局项目" };

    let sessions = 0;
    const key = pathKey(worktree);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["session", "session_v2"]) {
        if (!tables.includes(table)) continue;
        const ids = db
          .prepare(
            `SELECT id FROM ${table} WHERE project_id = ?1
             OR lower(replace(directory, char(92), '/')) = lower(replace(?2, char(92), '/'))`
          )
          .all(pid, worktree)
          .map((r) => String(r.id));
        for (const sid of ids) {
          // part -> message -> session, session_message -> session_v2
          if (tables.includes("part")) db.prepare("DELETE FROM part WHERE session_id = ?").run(sid);
          if (tables.includes("message")) db.prepare("DELETE FROM message WHERE session_id = ?").run(sid);
          if (tables.includes("session_message")) db.prepare("DELETE FROM session_message WHERE session_id = ?").run(sid);
          db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(sid);
          sessions += 1;
        }
      }
      db.prepare("DELETE FROM project WHERE id = ?").run(pid);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
    log(`deleteProject ${pid} (${key}) removed ${sessions} sessions`);
    return { ok: true, id: pid, path: worktree, sessions };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 300);
    log(`deleteProject failed id=${pid}: ${why}`);
    return { ok: false, error: "删除失败：" + why };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Last URL the service reported, so a liveness check costs one HTTP request
 * instead of spawning `opencode service status` every time.
 */
let cachedWebUrl = "";

/**
 * URL of the running opencode background service, if any.
 */
async function webServiceUrl() {
  const oc = locateOpencode();
  if (!oc.found) return "";
  const r = await opencodeExec(["service", "status"], { timeout: 15000 });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const m = out.match(/https?:\/\/[^\s"']+/);
  const url = m ? m[0].replace(/\/+$/, "") : "";
  cachedWebUrl = url;
  return url;
}

/**
 * Is the service actually answering?
 *
 * "The built-in window is open" is not the same as "opencode is running": if
 * the service dies while the window stays open, the page turns into a dead
 * shell and every request fails with `Failed to fetch`. Ask over HTTP instead
 * of trusting the window, with a short timeout so the status chip stays snappy.
 */
async function webAlive() {
  const url = cachedWebUrl || (await webServiceUrl());
  if (!url) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    // The service is password protected: the app shell answers 200 and the
    // bare API answers 401. Anything that came back means it is listening.
    return res.status > 0;
  } catch {
    cachedWebUrl = "";
    return false;
  }
}

/**
 * Start the background service (it also serves the web UI) and return its URL.
 */
async function webStart() {
  const existing = await webServiceUrl();
  if (existing) return { ok: true, url: existing, started: false };
  const oc = locateOpencode();
  if (!oc.found) return { ok: false, error: "未找到 opencode，请先点击「安装 / 修复」" };
  const r = await opencodeExec(["service", "start"], { timeout: 30000 });
  for (let i = 0; i < 20; i++) {
    const url = await webServiceUrl();
    if (url) return { ok: true, url, started: true };
    await new Promise((res) => setTimeout(res, 250));
  }
  const detail = `${r.stdout || ""}\n${r.stderr || ""}`.trim().slice(0, 300);
  return { ok: false, error: "opencode 后台服务启动失败", detail };
}

async function webStatus() {
  const url = await webServiceUrl();
  return { ok: true, url, running: Boolean(url) };
}

/**
 * A one-time sign-in link for the web UI.
 *
 * The background service is password protected: opening its bare root URL
 * only returns the page shell, and every API call behind it answers 401 —
 * the browser ends up on an unauthenticated page. `opencode pair` prints a
 * single-use `/auth/connect/...` link that, when opened in a browser, signs
 * the session in with a cookie and then loads the real web UI. (v1 had an
 * `opencode web` command; v2 replaced it with `pair`.)
 */
async function webPairLink() {
  const oc = locateOpencode();
  if (!oc.found) return "";
  const r = await opencodeExec(["pair"], { timeout: 15000 });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const m = out.match(/https?:\/\/[^\s"']*\/auth\/connect\/[^\s"']+/);
  return m ? m[0] : "";
}

/**
 * Everything needed to open the web UI: make sure the service is up, then
 * mint a pairing link. The link — not the bare service address — is what the
 * browser has to be given.
 */
async function webOpenUrl() {
  const started = await webStart();
  if (!started.ok) return started;
  const link = await webPairLink();
  if (!link) {
    return {
      ok: false,
      error: "无法生成 Web 版登录链接",
      detail: "opencode pair 没有输出可用链接，可手动运行 opencode pair 后打开提示的地址",
    };
  }
  return { ok: true, url: link, base: started.url, started: started.started };
}

/**
 * Shared background-service password, used for HTTP basic auth on /api/*.
 *
 * opencode keeps it in `<state>/opencode/service.json` (newer builds also
 * carry `url` and `pid` there) with `<config>/opencode/service.json` as the
 * older fallback. Both are resolved the same way on every machine — nothing
 * here is tied to this one.
 */
function opencodeServicePassword() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "state", "opencode", "service.json"),
    path.join(home, ".config", "opencode", "service.json"),
  ];
  for (const p of candidates) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"));
      if (v && typeof v.password === "string" && v.password) return v.password;
    } catch {
      /* try the next one */
    }
  }
  return "";
}

const API_TIMEOUT_MS = 15000;

/**
 * GET a JSON endpoint on the opencode service.
 *
 * The service is only password protected when opencode generated a password,
 * so the first attempt is unauthenticated and a 401 triggers a retry with
 * basic auth — a machine without a service password still works.
 */
async function serviceGet(endpoint, password) {
  const attempt = async (auth) => {
    const headers = {};
    if (auth) {
      headers.Authorization = `Basic ${Buffer.from(`opencode:${auth}`).toString("base64")}`;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, { headers, signal: ctl.signal });
      const text = await res.text();
      return { status: res.status, text };
    } finally {
      clearTimeout(timer);
    }
  };
  let r = await attempt(null);
  if (r.status === 401 && password) {
    r = await attempt(password);
  }
  return r;
}

/**
 * Register a directory with the running opencode service.
 *
 * The web UI's own "add project" flow does exactly this: a GET on
 * `/api/location` with the directory makes the server create the project
 * record. Doing it from the launcher means the folder (and every session
 * under it) shows up in the web UI without the user having to fight the web
 * file picker at all.
 */
async function webRegisterProject(dir) {
  const target = String(dir || "").trim();
  if (!target) return { ok: false, error: "目录为空" };
  const base = (await webServiceUrl()) || (await webStart()).url;
  if (!base) return { ok: false, error: "opencode 服务未运行" };
  const pw = opencodeServicePassword();
  const url = `${base}/api/location?location%5Bdirectory%5D=${encodeURIComponent(target)}`;
  try {
    const r = await serviceGet(url, pw);
    const unauthorized = /UnauthorizedError|Authentication required/.test(r.text);
    // A missing directory still leaves the project registered.
    const missing = /LocationNotFoundError/.test(r.text);
    return {
      ok: !unauthorized,
      dir: target,
      missing,
      status: r.status,
      detail: r.text.slice(0, 300),
    };
  } catch (e) {
    return { ok: false, dir: target, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/**
 * Make opencode's own session store match what the launcher shows.
 *
 * The web client only reads the v2 tables (`session_v2` + `session_message`),
 * so sessions can exist in the database yet be invisible there. Three things
 * are repaired, all of them additive or corrective:
 *
 * 1. **Ownership** — a session stores the id of the project it belongs to.
 *    Sessions created before their folder was known carry `project_id =
 *    "global"`, which makes the web client file them under the root instead
 *    of under the project. The id is re-derived from the session's own
 *    directory.
 * 2. **Duplicates** — the same folder can be recorded twice ("D:/x" and
 *    "d:/X"), which shows up as two identical projects in the web client.
 *    The stale one is merged into the survivor and its sessions are
 *    re-pointed first.
 * 3. **Legacy sessions** — sessions that only exist in the old `session` /
 *    `message` / `part` tables are copied into the v2 tables (the v2 row is
 *    a superset of the v1 one), with their messages converted to the v2
 *    `session_message` shape. Nothing is deleted.
 *
 * The database is backed up with `VACUUM INTO` before anything is written,
 * and every change runs inside one transaction.
 */
function syncOpencodeSessions(dbPathOverride) {
  const sqlite = getSqlite();
  if (!sqlite || !sqlite.DatabaseSync) {
    return { ok: false, error: "当前运行时不支持 SQLite" };
  }
  const dbPath = dbPathOverride || opencodeDbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: "未找到 opencode 数据库" };
  }
  let db = null;
  const stats = { projectsMerged: 0, reattached: 0, migrated: 0, messages: 0, backup: "" };
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 8000");
    db.exec("PRAGMA foreign_keys = ON");

    // ---- backup before touching anything ---------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backup = `${dbPath}.bak-${stamp}`;
    try {
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      stats.backup = backup;
    } catch {
      // A backup is a safety net, not a precondition — but say so.
      log(`syncOpencodeSessions: backup failed (${backup})`);
    }

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
    if (!tables.includes("project")) return { ok: false, error: "opencode 数据库缺少 project 表" };
    const cols = (t) => (tables.includes(t) ? db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) : []);
    const sessionCols = cols("session");
    const v2Cols = cols("session_v2");
    const hasV2 = tables.includes("session_v2") && v2Cols.length > 0;

    db.exec("BEGIN IMMEDIATE");
    try {
      // ---- 1. merge duplicate project rows ------------------------
      const projRows = db.prepare("SELECT id, worktree, time_archived, time_updated FROM project").all();
      const groups = new Map();
      for (const p of projRows) {
        if (!p.worktree || p.worktree === "/") continue;
        const k = pathKey(p.worktree);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      }
      for (const [, list] of groups) {
        if (list.length < 2) continue;
        // Keep the newest, unarchived row.
        list.sort(
          (a, b) =>
            (a.time_archived ? 1 : 0) - (b.time_archived ? 1 : 0) ||
            Number(b.time_updated || 0) - Number(a.time_updated || 0)
        );
        const keep = list[0];
        for (const dup of list.slice(1)) {
          for (const t of ["session", "session_v2"]) {
            if (!tables.includes(t)) continue;
            db.prepare(`UPDATE ${t} SET project_id = ? WHERE project_id = ?`).run(keep.id, dup.id);
          }
          db.prepare("DELETE FROM project WHERE id = ?").run(dup.id);
          stats.projectsMerged += 1;
        }
      }

      // ---- 2. re-attach sessions to their project ------------------
      const byKey = new Map();
      for (const p of db.prepare("SELECT id, worktree FROM project").all()) {
        if (!p.worktree || p.worktree === "/") continue;
        const k = pathKey(p.worktree);
        if (!byKey.has(k)) byKey.set(k, p.id);
      }
      for (const t of ["session", "session_v2"]) {
        if (!tables.includes(t)) continue;
        for (const s of db.prepare(`SELECT id, project_id, directory FROM ${t}`).all()) {
          const target = byKey.get(pathKey(s.directory));
          if (!target || s.project_id === target) continue;
          db.prepare(`UPDATE ${t} SET project_id = ? WHERE id = ?`).run(target, s.id);
          stats.reattached += 1;
        }
      }

      // ---- 3. copy legacy sessions into the v2 tables --------------
      if (hasV2 && tables.includes("session") && sessionCols.length) {
        const shared = v2Cols.filter((c) => sessionCols.includes(c));
        for (const s of db.prepare("SELECT * FROM session").all()) {
          if (db.prepare("SELECT count(*) c FROM session_v2 WHERE id = ?").get(s.id).c > 0) continue;
          const values = shared.map((c) => s[c]);
          db.prepare(
            `INSERT INTO session_v2 (${shared.join(",")}) VALUES (${shared.map(() => "?").join(",")})`
          ).run(...values);
          stats.migrated += 1;
          stats.messages += migrateSessionMessages(db, s, tables);
        }
      }

      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
    log(
      `syncOpencodeSessions merged=${stats.projectsMerged} reattached=${stats.reattached} ` +
        `migrated=${stats.migrated} messages=${stats.messages} backup=${stats.backup}`
    );
    return { ok: true, ...stats };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 300);
    log(`syncOpencodeSessions failed: ${why}`);
    return { ok: false, error: "同步失败：" + why };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Convert one legacy session's messages into v2 `session_message` rows.
 *
 * v1 keeps a `message` row per turn with the payload split across `part`
 * rows; v2 keeps one `session_message` row per turn with the parts inlined
 * as `content`. The shapes are close enough to translate field by field.
 */
function migrateSessionMessages(db, session, tables) {
  if (!tables.includes("session_message") || !tables.includes("message") || !tables.includes("part")) {
    return 0;
  }
  const msgs = db
    .prepare("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id")
    .all(session.id);
  let seq = 0;
  let written = 0;
  for (const m of msgs) {
    let meta = {};
    try {
      meta = JSON.parse(m.data || "{}");
    } catch {
      meta = {};
    }
    const parts = db
      .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id")
      .all(m.id)
      .map((p) => {
        try {
          return JSON.parse(p.data || "{}");
        } catch {
          return {};
        }
      });
    const role = String(meta.role || "user");
    let data;
    if (role === "assistant") {
      const content = [];
      for (const p of parts) {
        if (p.type === "text" || p.type === "reasoning") {
          content.push({ type: p.type, text: String(p.text || "") });
        } else if (p.type === "tool") {
          content.push({ type: "tool", id: p.callID || p.callId || "", name: p.tool || p.name || "", state: p.state || {} });
        }
        // step-start / step-finish have no v2 equivalent.
      }
      data = {
        agent: meta.agent || "build",
        model: {
          providerID: meta.providerID || "opencode",
          id: meta.modelID || meta.model?.id || "",
          variant: meta.model?.variant || "default",
        },
        content,
      };
      if (meta.cost != null) data.cost = meta.cost;
      if (meta.tokens != null) data.tokens = meta.tokens;
    } else {
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => String(p.text || ""))
        .join("\n");
      data = { text };
    }
    const time = meta.time && meta.time.created ? meta.time.created : Number(m.time_created || 0);
    const payload = { ...data, time: { created: time } };
    db.prepare(
      "INSERT OR REPLACE INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)"
    ).run(
      `msgv2_${m.id}`,
      session.id,
      role === "assistant" ? "assistant" : "user",
      seq,
      Number(m.time_created || 0),
      Number(m.time_updated || 0),
      JSON.stringify(payload)
    );
    seq += 1;
    written += 1;
  }
  return written;
}

/**
 * Register every project in the launcher's library with the service, repair
 * opencode's session store so the web client can see the same sessions, then
 * open the web UI — one click syncs the whole list.
 */
async function webSyncProjects() {
  const cfg = readConfig();
  const dirs = (cfg.projects || []).map((p) => p.path).filter(Boolean);
  if (!dirs.length) return { ok: false, error: "项目库是空的" };
  // Sessions that were started outside the library live in folders the
  // service has never heard of — their project row has to exist before the
  // ownership can be repaired, so register those folders as well.
  const known = new Set(dirs.map((d) => pathKey(d)));
  const all = await listAllSessions().catch(() => ({ sessions: [] }));
  for (const s of all.sessions || []) {
    const dir = String(s.directory || "");
    if (!dir || known.has(pathKey(dir))) continue;
    known.add(pathKey(dir));
    dirs.push(dir);
  }
  const results = [];
  for (const dir of dirs) {
    results.push(await webRegisterProject(dir));
  }
  // The web client reads the v2 tables only — repair ownership and legacy
  // rows before opening it, otherwise the sessions stay invisible there.
  const sessions = syncOpencodeSessions();
  const open = await webOpenUrl();
  return {
    ok: open.ok,
    total: dirs.length,
    registered: results.filter((r) => r.ok).length,
    missing: results.filter((r) => r.missing).map((r) => r.dir),
    sessions,
    open,
  };
}

/**
 * Register one directory with the service, repair the session store, then
 * open the web UI (pairing link) in the browser.
 */
async function webOpenProject(dir) {
  const reg = await webRegisterProject(dir);
  const sessions = syncOpencodeSessions();
  const open = await webOpenUrl();
  return { ok: open.ok, register: reg, sessions, open };
}

/**
 * The seeding routine that runs *inside* the web page.
 *
 * Kept in `shared/web-seed.js` because the Tauri build bakes the same file in
 * with `include_str!` — one implementation, two backends, no drift.
 */
function webSeedSource() {
  // Dev runs from the repo; packaged builds get the file via extraResources.
  const candidates = [
    path.join(__dirname, "..", "..", "shared", "web-seed.js"),
    path.join(process.resourcesPath || "", "shared", "web-seed.js"),
  ];
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      /* try the next location */
    }
  }
  return "";
}

/**
 * Script that seeds the workspace panel, then reloads once if anything moved.
 *
 * The web client reads its project list at startup, so writing localStorage
 * alone would not repaint the sidebar — the reload is what makes it visible.
 */
function webSeedScript(dirs) {
  const src = webSeedSource();
  if (!src) return "";
  const payload = JSON.stringify({ dirs: Array.isArray(dirs) ? dirs : [] });
  return `(function(){${src}\nvar r=__ocLauncherSeed(${payload});if(r&&r.changed){location.reload();}return r;})()`;
}

/**
 * Body of the "sync" bookmarklet.
 *
 * Runs in the web page itself, so it simply asks the service for the project
 * list — same origin, already authenticated by the pairing cookie.
 */
function webBookmarkletBody() {
  const src = webSeedSource();
  if (!src) return "";
  return (
    `(function(){${src}\n` +
    `fetch("/api/project").then(function(r){return r.json();}).then(function(j){` +
    `var a=Array.isArray(j)?j:(j.data||[]);` +
    `var dirs=a.map(function(p){return p&&(p.canonical||p.worktree||p.directory);}).filter(Boolean);` +
    `var r=__ocLauncherSeed({dirs:dirs});` +
    `if(r.changed){location.reload();}else{alert("项目已是最新（"+r.total+" 个）");}` +
    `}).catch(function(e){alert("同步失败："+e);});})()`
  );
}

/**
 * Project directories the service knows about — exactly what the settings
 * page lists, so the workspace panel can be made to match it.
 */
async function webProjectDirs() {
  const base = (await webServiceUrl()) || (await webStart()).url;
  if (!base) return [];
  const r = await serviceGet(`${base}/api/project`, opencodeServicePassword());
  try {
    const j = JSON.parse(r.text);
    const arr = Array.isArray(j) ? j : j.data || [];
    return arr
      .map((p) => p && (p.canonical || p.worktree || p.directory))
      .filter((d) => d && d !== "/" && d !== "\\"); // "/" is the global pseudo-project
  } catch {
    return [];
  }
}

/**
 * Directories the workspace panel should list — exactly the launcher's own
 * project library.
 *
 * The library is the single source of truth: removing a project there must
 * also remove it from the web panel, which the seed's mark-and-sweep step
 * handles (anything the launcher added last time but no longer seeds gets
 * dropped). Merging the service's project table in would resurrect projects
 * the user already deleted, so it is deliberately left out.
 */
async function webSeedDirs() {
  const cfg = readConfig();
  const seen = new Set();
  const out = [];
  for (const p of cfg.projects || []) {
    const dir = p && p.path;
    const k = pathKey(dir);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(dir);
  }
  return out;
}

/**
 * Folders the service registers but nobody picked as a project.
 *
 * opencode creates a `project` row for the directory it happened to start in
 * (that is the user's home folder when the background service starts), and the
 * launcher's own sync used to leave temp dirs behind. Neither is a project.
 */
function isScratchPath(key) {
  const k = String(key || "");
  if (!k) return true;
  // A bare drive root (`c:`) is never a project either.
  if (/^[a-z]:$/.test(k)) return true;
  const home = pathKey(os.homedir());
  const tmp = pathKey(os.tmpdir());
  if (home && k === home) return true;
  if (tmp && (k === tmp || k.startsWith(tmp + "\\"))) return true;
  return false;
}

/** Rows of the service's own project table, global pseudo-project excluded. */
function readServiceProjects(dbPathOverride) {
  const sqlite = getSqlite();
  if (!sqlite || !sqlite.DatabaseSync) return { ok: false, rows: [] };
  const dbPath = dbPathOverride || opencodeDbPath();
  if (!fs.existsSync(dbPath)) return { ok: false, rows: [] };
  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT id, worktree, name, time_updated FROM project")
      .all()
      .filter((r) => r && r.worktree && r.worktree !== "/");
    return { ok: true, rows };
  } catch (e) {
    log(`readServiceProjects failed: ${String((e && e.message) || e)}`);
    return { ok: false, rows: [] };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Make sure the service has a project row for `dir`.
 *
 * `/api/location` registers the folder in memory and hands back the id the
 * service itself computed, but opencode only *persists* a row for folders it
 * considers real projects — a folder the user just added to the launcher often
 * gets none. Writing the row here, reusing that id so both sides agree, is what
 * makes the library authoritative: every library folder then exists for the web
 * UI and the terminal, whatever opencode decided on its own.
 */
async function ensureServiceProject(dir) {
  const target = String(dir || "").trim();
  if (!target) return { ok: false, error: "目录为空" };
  const key = pathKey(target);

  const svc = readServiceProjects();
  if (svc.ok && svc.rows.some((r) => pathKey(r.worktree) === key)) {
    return { ok: true, existed: true, dir: target };
  }

  // Missing directory still deserves a row: the user may plug the drive in later.
  const reg = await webRegisterProject(target).catch(() => ({ ok: false }));
  if (!reg || !reg.ok) return { ok: false, dir: target, error: (reg && reg.error) || "登记失败" };

  let id = "";
  try {
    id = String(((JSON.parse(reg.detail || "{}") || {}).project || {}).id || "");
  } catch {
    /* fall through to the missing-id error below */
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    return { ok: false, dir: target, error: "服务未返回项目 ID" };
  }

  const sqlite = getSqlite();
  if (!sqlite || !sqlite.DatabaseSync) return { ok: false, dir: target, error: "当前运行时不支持 SQLite" };
  const dbPath = opencodeDbPath();
  if (!fs.existsSync(dbPath)) return { ok: false, dir: target, error: "未找到 opencode 数据库" };

  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 8000");
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated, time_active)
       VALUES (?, ?, '[]', ?, ?, ?)`
    ).run(id, target.replace(/\\/g, "/"), now, now, now);
    return { ok: true, existed: false, dir: target, id };
  } catch (e) {
    return { ok: false, dir: target, error: String((e && e.message) || e).slice(0, 200) };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Two-way reconciliation between the launcher library and the service.
 *
 * The library is what the user manages; the service's table is what the web UI
 * and the terminal see. Both sides are kept in step so a change made anywhere
 * shows up everywhere:
 *
 *   service only  -> added to the library (a project created in web/terminal)
 *   library only  -> registered with the service, or dropped from the library
 *                    when it was already synced before (deleted elsewhere)
 *   both          -> the service's `name` wins, since renames happen there
 *
 * `lastSyncAt` (persisted in the config) is what tells "brand new library
 * entry" apart from "existed last time, now missing on the service" — without
 * it every fresh entry would look deleted and every deletion would look new.
 */
async function syncProjectRegistry() {
  const cfg = readConfig();
  const now = Date.now();

  const svc = readServiceProjects();
  if (!svc.ok) return { ok: false, error: "读取 opencode 项目失败" };

  const lib = Array.isArray(cfg.projects) ? cfg.projects : [];
  const libKeys = new Map(lib.map((p) => [pathKey(p.path), p]));
  const svcRows = svc.rows.filter((r) => !isScratchPath(pathKey(r.worktree)));
  const svcKeys = new Map(svcRows.map((r) => [pathKey(r.worktree), r]));

  // What the service held at the end of the previous pass. That snapshot — not
  // a timestamp — is what tells "the user just added this" apart from "this
  // used to exist and someone deleted it": a path in the snapshot that is now
  // gone means it was deleted over there.
  const prev = new Set((Array.isArray(cfg.syncedPaths) ? cfg.syncedPaths : []).map(pathKey));

  const added = [];
  const registered = [];
  const dropped = [];
  const renamed = [];

  // --- service -> library ------------------------------------------------
  for (const [k, r] of svcKeys) {
    if (libKeys.has(k)) continue;
    const entry = {
      path: r.worktree,
      name: String(r.name || "").trim() || path.basename(r.worktree) || r.worktree,
      addedAt: now,
    };
    lib.unshift(entry);
    libKeys.set(k, entry);
    added.push(entry.path);
  }

  // --- library -> service, and deletions seen on the service side --------
  for (const p of [...lib]) {
    const k = pathKey(p.path);
    if (!k || svcKeys.has(k)) continue;
    if (prev.has(k)) {
      // It was there last time and is gone now: deleted in the web UI or the
      // terminal. Follow it, otherwise the row springs back on every pass.
      cfg.projects = cfg.projects.filter((x) => pathKey(x.path) !== k);
      dropped.push(p.path);
      continue;
    }
    const r = await ensureServiceProject(p.path).catch(() => ({ ok: false }));
    if (r && r.ok) registered.push(p.path);
  }

  // --- names -------------------------------------------------------------
  for (const p of cfg.projects) {
    const r = svcKeys.get(pathKey(p.path));
    const name = r && String(r.name || "").trim();
    if (!name || name === p.name) continue;
    p.name = name;
    renamed.push(p.path);
  }

  cfg.syncedPaths = [...svcKeys.values()].map((r) => r.worktree);
  const saved = writeConfig(cfg);
  return {
    ok: true,
    added,
    registered,
    dropped,
    renamed,
    total: saved.projects.length,
  };
}

/**
 * Remove a project from the service as well, so the reconciliation does not
 * bring it back on the next run.
 *
 * Returns `{ ok, removed }` — `removed` is false when the service never knew
 * about the folder, which is not an error.
 */
async function deleteServiceProjectByPath(dir) {
  const key = pathKey(dir);
  if (!key) return { ok: false, removed: false };
  const svc = readServiceProjects();
  if (!svc.ok) return { ok: false, removed: false };
  const hit = svc.rows.find((r) => pathKey(r.worktree) === key);
  if (!hit) return { ok: true, removed: false };
  const r = await deleteProject(hit.id);
  return { ok: !!r.ok, removed: !!r.ok, error: r.error };
}

/**
 * Register every project in the library with the service.
 *
 * Cheap (one GET per folder) compared to `webSyncProjects`, which also repairs
 * the session tables — the workspace panel only needs the project rows.
 */
async function webRegisterLibrary() {
  const cfg = readConfig();
  const dirs = (cfg.projects || []).map((p) => p.path).filter(Boolean);
  let ok = 0;
  for (const dir of dirs) {
    const r = await webRegisterProject(dir);
    if (r.ok) ok++;
  }
  return { total: dirs.length, ok };
}

/**
 * Sessions for one project directory.
 *
 * Returns `{ok, dir, sessions, cached, ms}`, or `{ok:false, dir, reason,
 * sessions:[]}` — the failure shape still carries `sessions: []` so the caller
 * never has to guard for undefined.
 */
async function listSessions(dir, { refresh = false } = {}) {
  const key = pathKey(dir);
  if (!key) return { ok: false, dir, reason: "未指定目录", sessions: [] };
  const t0 = Date.now();

  const hit = sessionCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < SESSION_TTL) {
    return { ok: true, dir, sessions: hit.sessions, cached: true, ms: Date.now() - t0 };
  }

  // Rapidly clicking between projects would otherwise spawn two opencode
  // processes (~1.2s total) and let the slower response overwrite the newer one.
  const running = sessionInflight.get(key);
  if (running) {
    const r = await running;
    return r && r.ok ? { ...r, dir, cached: false, ms: Date.now() - t0 } : r;
  }

  const p = querySessions(key, dir);
  sessionInflight.set(key, p);
  try {
    const r = await p;
    if (r.ok) {
      sessionCache.set(key, { at: Date.now(), sessions: r.sessions });
      if (sessionCache.size > SESSION_CACHE_MAX) {
        const oldest = [...sessionCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) sessionCache.delete(oldest[0]);
      }
    }
    return { ...r, dir, cached: false, ms: Date.now() - t0 };
  } finally {
    sessionInflight.delete(key);
  }
}

/** Drop cached sessions (after a delete / a fresh launch). */
function invalidateSessions(dir) {
  if (dir) sessionCache.delete(pathKey(dir));
  else sessionCache.clear();
}

/** Map opencode's English errors to something the UI can show directly. */
function translateSessionError(raw) {
  const t = String(raw || "");
  if (/expected a string starting with/i.test(t)) return "会话 ID 无效（应以 ses 开头）";
  if (/session not found|no session/i.test(t)) return "会话不存在，可能已被删除";
  if (/^\s*usage/im.test(t)) return "opencode 未执行删除（参数不被识别）";
  if (/no such table|no such column/i.test(t)) return "opencode 会话表结构不匹配，请升级 opencode";
  if (/ENOENT|EINVAL|is not recognized|spawn/i.test(t)) return "调用 opencode 失败，请确认已正确安装";
  if (/timed out|ETIMEDOUT/i.test(t)) return "删除超时，请重试";
  const first = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return first ? `删除失败：${first.slice(0, 160)}` : "删除失败：未知错误";
}

/**
 * Delete a session.
 *
 * Uses the official `opencode session delete <id>` (present in both v1 and v2)
 * so that the associated message/part rows are cleaned up by opencode itself.
 * Deleting straight from SQLite would leave orphans behind and would have to
 * deal with the WAL lock held by a running opencode.
 */
async function deleteSession(id) {
  const sid = String(id || "").trim();
  if (!sid) return { ok: false, error: "未指定会话 ID" };

  // The id reaches opencode as argv, and on Windows runCmd() may fall back to
  // `cmd /d /c <exe> session delete <id>` — an id containing & | ^ " would be
  // interpreted by cmd as a second command. Whitelist before it gets there.
  if (!/^[A-Za-z0-9_-]+$/.test(sid)) {
    return { ok: false, error: "会话 ID 无效（只允许字母、数字、下划线和连字符）" };
  }

  const r = await opencodeExec(["session", "delete", sid], { timeout: 30000 });
  // Without this the next list request is served from cache and the deleted
  // session reappears as a ghost.
  invalidateSessions();

  // Judge by exit code, but also reject a usage dump: opencode writes
  // usage/help to stderr and can exit 0 when the argument is missing.
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.ok && !/^\s*(usage|opencode\s+session\s+delete)/im.test(out)) {
    log(`session deleted ${sid}`);
    return { ok: true, id: sid };
  }
  log(`session delete failed ${sid}: ${out.trim().slice(0, 300)}`);
  return { ok: false, error: translateSessionError(out) };
}

/* ------------------------------------------------------------ maintenance --- */

/**
 * Install (or repair) opencode through npm.
 *
 * The package is chosen from the installed line, never hardcoded: `@opencode/cli`
 * for the v2 line, `opencode-ai` for v1. Getting this wrong installs the other
 * major — `opencode-ai@latest` is 1.19.0 and would downgrade a v2 machine.
 */
/** Single-quote a value for embedding in a generated .ps1. */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The newest version of `pkg` on the registry ("x.y.z", or "" when it cannot be
 * determined). Run through PowerShell so the install flow stays off cmd.exe.
 */
async function npmLatestVersion(npm, pkg) {
  const host = await resolvePowerShellHost();
  let script = "";
  let cmd;
  if (host.exe) {
    fs.mkdirSync(dataDir(), { recursive: true });
    script = path.join(dataDir(), `npmview-${process.pid}-${Date.now()}.ps1`);
    // `pkg` is quoted as one token — a bare @opencode/… would be parsed as splatting
    fs.writeFileSync(script, "\uFEFF" + `& ${psQuote(npm)} view ${psQuote(pkg)} version\r\n`, "utf8");
    cmd = `"${host.exe}" -NoProfile -File "${script}"`;
  } else {
    cmd = `${quoteForShell(npm)} view ${pkg} version`;
  }
  try {
    const r = await execShell(cmd, { timeout: 60000 });
    const hit = `${r.stdout}\n${r.stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^\d+\.\d+\.\d+/.test(l));
    return hit || "";
  } catch {
    return "";
  } finally {
    if (script) { try { fs.rmSync(script, { force: true }); } catch { /* ignore */ } }
  }
}

/**
 * Newest version straight from the package registry.
 *
 * npm is not a prerequisite for opencode: the official standalone installer
 * drops a binary into `~/.opencode/bin` without Node.js or npm. Those installs
 * still need a version check, so query the registry over HTTPS instead of
 * shelling out to `npm view`.
 */
async function registryLatestVersion(pkg) {
  for (const base of ["https://registry.npmjs.org", "https://registry.npmmirror.com"]) {
    try {
      const raw = await httpsGetBuffer(`${base}/${pkg}/latest`, 30000);
      const meta = JSON.parse(raw.toString("utf8"));
      const version = String((meta && meta.version) || "").trim();
      if (/^\d+\.\d+\.\d+/.test(version)) return version;
    } catch {
      /* try the next registry */
    }
  }
  return "";
}

/**
 * Latest version for the maintenance panel.
 *
 * Prefer npm because it honours the user's configured registry; when npm is
 * absent (official standalone install) or its query fails, use the registry
 * API directly. This keeps the panel useful on machines without Node.js.
 */
async function latestVersion(npm, pkg) {
  const fromNpm = npm ? await npmLatestVersion(npm, pkg).catch(() => "") : "";
  return fromNpm || registryLatestVersion(pkg);
}

/* ------------------------------------- standalone (non-npm) install path --- */

/** Walk a ustar archive in memory — npm tarballs need no tar.exe. */
function eachTarMember(raw, visit) {
  let off = 0;
  while (off + 512 <= raw.length) {
    const header = raw.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return;
    const cstr = (b) => {
      const end = b.indexOf(0);
      return b.toString("utf8", 0, end === -1 ? b.length : end);
    };
    const name = cstr(header.subarray(0, 100));
    const size = parseInt(cstr(header.subarray(124, 136)).trim() || "0", 8) || 0;
    const type = String.fromCharCode(header[156]);
    const dataStart = off + 512;
    const isFile = type === "0" || type === "\0" || type === "";
    if (visit({ name, size, isFile, data: raw.subarray(dataStart, dataStart + size) }) === false) return;
    off = dataStart + Math.ceil(size / 512) * 512;
  }
}

/** Pull one member (matched by path suffix) out of a .tgz buffer. */
function extractFromTarGz(tgzBuffer, memberSuffix, destPath) {
  const raw = zlib.gunzipSync(tgzBuffer);
  let found = null;
  eachTarMember(raw, (m) => {
    if (m.isFile && m.name.replace(/\\/g, "/").endsWith(memberSuffix)) {
      found = m;
      return false;
    }
    return true;
  });
  if (!found) return { ok: false, error: `压缩包内未找到 ${memberSuffix}` };
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, found.data);
  return { ok: true, name: found.name, size: found.size };
}

/** GET a URL into memory, reporting progress on the way. */
function httpsGetBuffer(url, timeout, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers["content-length"] || 0);
      const chunks = [];
      let got = 0;
      res.on("data", (c) => {
        got += c.length;
        chunks.push(c);
        if (onProgress) onProgress(got, total);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("请求超时")));
  });
}

/** Where the standalone (non-npm) opencode lives — locateOpencode looks here. */
function standaloneOpencodePath() {
  return path.join(os.homedir() || process.cwd(), ".opencode", "bin", "opencode.exe");
}

/**
 * Install opencode without npm: fetch the platform package from the registry
 * and extract its compiled binary into ~/.opencode/bin. The tarball carries a
 * standalone `bin/opencode.exe`, so the result needs no Node.js at all.
 */
async function installStandaloneOpencode(onLine) {
  const pkg = "@opencode/cli-windows-x64-baseline";
  onLine?.(`查询 ${pkg} 最新版本…\n`);
  const meta = JSON.parse((await httpsGetBuffer(`https://registry.npmjs.org/${pkg}/latest`, 30000)).toString("utf8"));
  const url = meta && meta.dist && meta.dist.tarball;
  if (!url) throw new Error(`${pkg} 没有可下载的包`);
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  onLine?.(`下载 opencode ${meta.version || ""}（独立程序，约 ${mb((meta.dist && meta.dist.unpackedSize) || 0)} MB）…\n`);
  let lastPct = -1;
  const tgz = await httpsGetBuffer(url, 900000, (got, total) => {
    if (!total) return;
    const pct = Math.floor((got / total) * 100);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      onLine?.(`已下载 ${mb(got)} / ${mb(total)} MB（${pct}%）\n`);
    }
  });
  const dest = standaloneOpencodePath();
  const r = extractFromTarGz(tgz, "bin/opencode.exe", dest);
  if (!r.ok) throw new Error(r.error || "下载包解压失败");
  const probe = spawnSync(dest, ["--version"], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (probe.status !== 0) {
    throw new Error("下载的 opencode 无法运行：" + String((probe.stderr || probe.stdout || "").trim()).slice(0, 200));
  }
  invalidateOpencodeCache();
  onLine?.(`opencode ${meta.version || ""} 已安装到 ${dest}（独立程序，不依赖 Node.js）\n`);
  return { method: "standalone", version: String(meta.version || ""), exe: dest };
}

/**
 * Install or repair opencode.
 *
 * npm is tried first, and a failure is retried against the official registry
 * and then the China mirror — a stale or half-synced mirror is a common source
 * of `500` errors for scoped packages. If npm is absent or every registry
 * fails, the compiled standalone build is downloaded straight from the
 * registry instead, so a machine without Node.js still gets a working opencode.
 */
async function installOpencode(onLine, opts = {}) {
  const npm = await resolveNpm();
  const probe = await exec(npm, ["-v"], { shell: true, timeout: 20000 });
  const before = await installedVersion({ refresh: true });
  const pkg = opencodeNpmPkg();

  if (probe.ok) {
    // refresh the version cache first so a curl-installed opencode still steers
    // the package choice by its major version
    const latest = await npmLatestVersion(npm, pkg);
    onLine?.(`本机已装：${before || "（未安装）"}\n`);
    onLine?.(`registry 最新：${latest || "（查询失败，仍按 @latest 安装）"}\n`);

    for (const reg of ["", "https://registry.npmjs.org", "https://registry.npmmirror.com"]) {
      const host = await resolvePowerShellHost();
      let installScript = "";
      let cmd;
      const regArg = reg ? ` --registry=${reg}` : "";
      if (host.exe) {
        fs.mkdirSync(dataDir(), { recursive: true });
        installScript = path.join(dataDir(), `install-${process.pid}-${Date.now()}.ps1`);
        // one quoted token: '@opencode/cli@latest' — a bare @… would be splatting
        fs.writeFileSync(
          installScript,
          "\uFEFF" + `& ${psQuote(npm)} install -g ${psQuote(`${pkg}@latest`)}${regArg}\r\n`,
          "utf8"
        );
        cmd = `"${host.exe}" -NoProfile -File "${installScript}"`;
      } else {
        cmd = `${quoteForShell(npm)} install -g ${pkg}@latest${regArg}`;
      }
      onLine?.(`$ ${cmd}\n`);
      const r = await execShell(cmd, { timeout: 900000, onLine, windowsHide: opts.terminal !== true });
      if (installScript) { try { fs.rmSync(installScript, { force: true }); } catch { /* ignore */ } }
      invalidateOpencodeCache();
      if (r.ok) {
        const version = await installedVersion();
        return { ...r, version, pkg, npm, latest, before, method: "npm", registry: reg || "default" };
      }
      onLine?.(`该源安装失败（${reg || "默认 registry"}），换下一个源重试…\n`);
    }
    onLine?.("npm 各源均未成功，改用独立版下载…\n");
  } else {
    onLine?.("未检测到 npm，改用独立版下载（无需 Node.js）…\n");
  }

  try {
    const s = await installStandaloneOpencode(onLine);
    return {
      ok: true,
      code: 0,
      stdout: "",
      stderr: "",
      version: s.version,
      pkg: "standalone",
      npm,
      before,
      method: "standalone",
    };
  } catch (e) {
    const why = String((e && e.message) || e);
    log(`install failed (standalone): ${why}`);
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: `安装失败：${why}`,
      pkg,
      npm,
      version: "",
      before,
    };
  }
}

/**
 * Remove one npm-installed copy that `opencode uninstall` refused to touch
 * ("Could not detect the installation method"). Only ever touches the prefix
 * the detected shim/binary actually lives in — its global `node_modules\@opencode`
 * plus the shims npm created next to it.
 */
function removeOpencodeLeftover(ocPath) {
  const p = String(ocPath || "");
  const m = /^(.*)[\\/]node_modules[\\/]@opencode[\\/]/i.exec(p);
  const prefix = m ? m[1] : path.dirname(p);
  const pkgDir = path.join(prefix, "node_modules", "@opencode");
  const shims = ["opencode.cmd", "opencode2.cmd", "opencode", "opencode2"].map((f) => path.join(prefix, f));
  const removed = [];
  for (const target of [pkgDir, ...shims]) {
    try {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (e) {
      log(`leftover remove failed ${target}: ${(e && e.message) || e}`);
    }
  }
  return removed;
}

/**
 * Uninstall opencode.
 *
 * Three things the raw command needs help with:
 *  - `opencode uninstall` renders an interactive confirmation and refuses to
 *    run without a terminal ("Use --force to uninstall without an interactive
 *    terminal"). The UI already asked the user, so pass --force.
 *  - a running session holds the binary, so npm cannot remove it — close the
 *    launcher's sessions first.
 *  - one machine can carry several npm prefixes (a system Node and a managed
 *    one), each with its own copy. A single run only removes the copy it was
 *    started from, and a copy it cannot classify is left behind with
 *    "remove the installation manually" — so loop, then clean any leftover.
 */
async function uninstallOpencode(onLine) {
  if (!locateOpencode({ refresh: true }).found) {
    return { ok: false, code: 1, stdout: "", stderr: "opencode 未安装" };
  }

  const running = await listLaunches().catch(() => []);
  if (running.length) {
    onLine?.(`先关闭正在运行的 ${running.length} 个 opencode 会话…\n`);
    await killLaunched().catch(() => {});
  }

  const clean = (s) =>
    String(s || "")
      .replace(/^.*(找不到批处理文件|batch file cannot be found).*$/gim, "")
      .trim();

  const chunks = [];
  let last = { code: 0, stdout: "", stderr: "" };
  for (let round = 0; round < 3; round++) {
    const oc = locateOpencode({ refresh: true });
    if (!oc.found) break;
    // npm deletes the .cmd shim this run started from, so cmd exits with
    // "The batch file cannot be found" — the exit code is meaningless here,
    // what matters is whether another install is still present.
    const r = await opencodeExec(["uninstall", "--force"], { timeout: 300000, refresh: true });
    invalidateOpencodeCache();
    const out = clean([r.stdout, r.stderr].filter(Boolean).join("\n"));
    if (out) chunks.push(out);
    last = r;
  }

  let still = locateOpencode({ refresh: true });
  if (still.found) {
    // The official uninstaller could not classify this copy — clear it by hand.
    const removed = removeOpencodeLeftover(still.path);
    if (removed.length) {
      chunks.push(`已手动清理：\n${removed.join("\n")}`);
      invalidateOpencodeCache();
    }
    still = locateOpencode({ refresh: true });
  }

  const gone = !still.found;
  onLine?.(
    [chunks.join("\n"), gone ? "opencode 已卸载" : `仍检测到 opencode：${still.path}`].filter(Boolean).join("\n") + "\n"
  );
  log(`uninstall exit=${last.code} stillFound=${still.found}`);
  return {
    ok: gone,
    code: gone ? 0 : last.code || 1,
    stdout: chunks.join("\n"),
    stderr: gone ? "" : last.stderr,
  };
}

/** Collect environment diagnostics for the troubleshooting panel. */
async function runDoctor(onLine) {
  const checks = [];
  const oc = locateOpencode({ refresh: true });

  const npm = await resolveNpm();
  const npmFound = Boolean(findExecutableOnPath("npm"));
  checks.push({ name: "opencode 可执行文件", ok: oc.found, detail: oc.path || "未在 PATH 中找到" });

  const ver = await installedVersion({ refresh: true });
  const pkg = opencodeNpmPkg();
  // Show the npm line next to the version: a v2 version resolved from the
  // `opencode-ai` package (or vice versa) is exactly the mix-up that installs
  // the wrong major.
  const lineOk = !ver || (/^1\./.test(ver) ? pkg === REGISTRY : pkg === REGISTRY_V2);
  checks.push({
    name: "opencode 版本",
    ok: Boolean(ver) && lineOk,
    detail: ver ? `${ver}（${pkg}）` : "无法读取版本",
  });

  checks.push({ name: "npm", ok: npmFound, detail: npm });

  const wt = await resolveWindowsTerminal();
  checks.push({
    name: "终端",
    ok: true,
    detail: wt ? `Windows Terminal (${wt})` : "未检测到 Windows Terminal，将使用 cmd",
  });

  const cfgDir = path.join(os.homedir() || "", ".config", "opencode");
  let hasCfg = false;
  try {
    hasCfg = fs.existsSync(path.join(cfgDir, "opencode.json")) ||
      fs.existsSync(path.join(cfgDir, "opencode.jsonc"));
  } catch {
    /* ignore */
  }
  checks.push({ name: "opencode 配置目录", ok: hasCfg, detail: cfgDir + (hasCfg ? "" : "（未找到配置文件）") });

  // Does the local server actually answer? A failed migration, a corrupt state
  // file or a provider-auth crash surfaces here — the same thing the TUI shows
  // as a 5xx when a message is sent. The probe starts the background service
  // if it is not running, which is exactly the chain the button relies on.
  let apiOk = false;
  let apiDetail = "opencode 未安装";
  if (oc.found) {
    const p = await opencodeExec(["api", "session.list"], { timeout: 90000 });
    const stdout = String(p.stdout || "").trim();
    const isJson = stdout.startsWith("[") || stdout.startsWith("{");
    if (p.ok && isJson) {
      apiOk = true;
      apiDetail = "服务正常应答";
    } else {
      const first =
        (stdout || String(p.stderr || ""))
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)[0] || "无响应";
      apiDetail = first.slice(0, 180);
    }
  }
  checks.push({ name: "opencode 服务", ok: apiOk, detail: apiDetail });

  const ocData = opencodeDataDir();
  checks.push({
    name: "opencode 数据目录",
    ok: fs.existsSync(ocData),
    detail: `${ocData}（日志在 ${opencodeLogDir()}）`,
  });

  const platform = `${os.type()} ${os.release()} · Node ${process.versions.node} · ${os.arch()}`;
  checks.push({ name: "运行环境", ok: true, detail: platform });

  const text = checks.map((c) => `${c.ok ? "[OK]  " : "[!!] "}${c.name}: ${c.detail}`).join("\n");
  onLine?.(text + "\n");
  log("doctor\n" + text);
  return { ok: checks.every((c) => c.ok), checks, text };
}

/* ---------------------------------------------------------------- export --- */

module.exports = {
  dataDir,
  configPath,
  logPath,
  readConfig,
  pathKey,
  canonicalPath,
  writeConfig,
  exec,
  opencodeExec,
  execShell,
  locateOpencode,
  locateNpm,
  resolveNpm,
  installedVersion,
  opencodeMajor,
  opencodeNpmPkg,
  opencodeInstalledViaNpm,
  invalidateOpencodeCache,
  buildOpencodeArgs,
  renderArgLine,
  launch,
  killLaunched,
  listLaunches,
  isLaunchedRunning,
  npmLatestVersion,
  registryLatestVersion,
  latestVersion,
  isProjectDir,
  gitStatus,
  listSessions,
  listAllSessions,
  listScannedProjects,
  deleteProject,
  webServiceUrl,
  webStart,
  webStatus,
  webAlive,
  webPairLink,
  webOpenUrl,
  webRegisterProject,
  webOpenProject,
  webSyncProjects,
  webSeedScript,
  webBookmarkletBody,
  webProjectDirs,
  webSeedDirs,
  webRegisterLibrary,
  syncProjectRegistry,
  ensureServiceProject,
  deleteServiceProjectByPath,
  readServiceProjects,
  syncOpencodeSessions,
  deleteSession,
  renameSession,
  invalidateSessions,
  installOpencode,
  uninstallOpencode,
  runDoctor,
  cleanupRunScripts,
  hasWindowsTerminal,
  resolveWindowsTerminal,
  log,
  DEFAULT_CONFIG,
  opencodeDbPath,
  opencodeDataDir,
  opencodeLogDir,
  extractFromTarGz,
  analyzeCache,
  clearCache,
  isOpencodeRunning,
  sessionSql,
  BUILD_ID,
};
