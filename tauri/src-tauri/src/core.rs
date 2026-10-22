//! Backend: what `desktop/core/core.js` does, expressed in Rust.
//!
//! The scripts, SQL and command lines are deliberately identical to the
//! Electron build — only the orchestration is new, so behaviour does not drift.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub const APP_DIR: &str = "opencode-launcher";
pub const BUILD: &str = "1.1.0";

const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/* ------------------------------------------------------------------ paths --- */

pub fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| {
        dirs_home().join("AppData").join("Roaming").to_string_lossy().to_string()
    });
    PathBuf::from(base).join(APP_DIR)
}

pub fn dirs_home() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Public"))
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

pub fn log_path() -> PathBuf {
    data_dir().join("launcher.log")
}

pub fn opencode_data_dir() -> PathBuf {
    match std::env::var("XDG_DATA_HOME") {
        Ok(x) if !x.trim().is_empty() => PathBuf::from(x).join("opencode"),
        _ => dirs_home().join(".local").join("share").join("opencode"),
    }
}

pub fn opencode_db_path() -> PathBuf {
    opencode_data_dir().join("opencode.db")
}

pub fn opencode_log_dir() -> PathBuf {
    opencode_data_dir().join("log")
}

const REGISTRY: &str = "opencode-ai";
const REGISTRY_V2: &str = "@opencode/cli";

/* -------------------------------------------------------------------- log --- */

pub fn log(msg: &str) {
    let line = format!("[{}] {}\n", timestamp(), msg);
    let _ = fs::create_dir_all(data_dir());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

/* ----------------------------------------------------------------- config --- */

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Project {
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "addedAt")]
    pub added_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Config {
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub prefs: Value,
    #[serde(default, rename = "lastProject")]
    pub last_project: String,
    /// Directories the service held at the end of the previous sync pass.
    /// Comparing against this snapshot (not a timestamp) is what tells a new
    /// library entry apart from one deleted in the web UI or the terminal.
    #[serde(default, rename = "syncedPaths")]
    pub synced_paths: Vec<String>,
}

pub fn read_config() -> Config {
    let p = config_path();
    if let Ok(text) = fs::read_to_string(&p) {
        if let Ok(cfg) = serde_json::from_str::<Config>(&text) {
            return cfg;
        }
    }
    Config {
        projects: Vec::new(),
        prefs: json!({ "terminal": "auto", "extraArgs": "" }),
        last_project: String::new(),
        synced_paths: Vec::new(),
    }
}

pub fn write_config(cfg: &Config) {
    let _ = fs::create_dir_all(data_dir());
    let text = serde_json::to_string_pretty(cfg).unwrap_or_else(|_| "{}".into());
    let _ = fs::write(config_path(), text);
}

/// Case- and separator-insensitive key used to compare directories.
pub fn path_key(p: &str) -> String {
    p.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/* --------------------------------------------------------------- processes --- */

fn no_window(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn run(exe: &str, args: &[&str]) -> String {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(std::process::Stdio::null());
    no_window(&mut cmd);
    match cmd.output() {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            s
        }
        Err(_) => String::new(),
    }
}

pub fn run_status(exe: &str, args: &[&str]) -> Output {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(std::process::Stdio::null());
    no_window(&mut cmd);
    cmd.output().unwrap_or_else(|e| {
        // Fabricate a failed Output so callers keep one code path.
        let _ = e;
        Command::new("cmd.exe")
            .args(["/c", "exit", "127"])
            .output()
            .expect("cmd")
    })
}

fn powershell(script: &str) -> String {
    // -EncodedCommand avoids every quoting problem a .ps1 path would bring.
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    let b64 = base64(utf16);
    run("powershell.exe", &["-NoProfile", "-NonInteractive", "-EncodedCommand", &b64])
}

fn base64(bytes: Vec<u8>) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/* ---------------------------------------------------------------- opencode --- */

fn find_on_path(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
        .split(';')
        .map(|s| s.to_lowercase())
        .collect();
    for dir in std::env::var("PATH").unwrap_or_default().split(';') {
        if dir.trim().is_empty() {
            continue;
        }
        for ext in &exts {
            let p = PathBuf::from(dir).join(format!("{}{}", name, ext));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// v2 installs `opencode2` next to `opencode`, so prefer it when present.
pub fn locate_opencode() -> Option<PathBuf> {
    if let Some(p) = find_on_path("opencode2") {
        return Some(p);
    }
    if let Some(p) = find_on_path("opencode") {
        return Some(p);
    }
    let appdata_npm = std::env::var("APPDATA")
        .map(|a| PathBuf::from(a).join("npm"))
        .unwrap_or_default();
    let guesses = [
        appdata_npm.join("opencode2.cmd"),
        appdata_npm.join("opencode.cmd"),
        dirs_home().join(".opencode").join("bin").join("opencode.exe"),
    ];
    guesses.into_iter().find(|p| p.is_file())
}

pub fn installed_version() -> String {
    let Some(oc) = locate_opencode() else { return String::new() };
    let out = run(&oc.to_string_lossy(), &["--version"]);
    parse_version(&out).unwrap_or_default()
}

fn parse_version(s: &str) -> Option<String> {
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_digit() {
            let mut j = i;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || ".-+".contains(bytes[j])) {
                j += 1;
            }
            let cand: String = bytes[i..j].iter().collect();
            if cand.matches('.').count() >= 2 {
                return Some(cand);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

pub fn opencode_major() -> u8 {
    let v = installed_version();
    if v.starts_with("2.") { 2 } else { 1 }
}

pub fn npm_pkg() -> &'static str {
    if opencode_major() >= 2 { REGISTRY_V2 } else { REGISTRY }
}

pub fn resolve_npm() -> String {
    find_on_path("npm")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "npm".into())
}

/* ------------------------------------------------------------------ launch --- */

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\\\""))
}

fn needs_quote(t: &str) -> bool {
    t.chars().any(|c| c.is_whitespace() || "\"^&|<>()%".contains(c))
}

pub fn build_args(opts: &Value, major: u8) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let s = |k: &str| opts.get(k).and_then(|v| v.as_str()).map(|x| x.to_string());
    let b = |k: &str| opts.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    if major >= 2 {
        if let Some(v) = s("session") { a.push("--session".into()); a.push(v); }
        if b("continueSession") { a.push("--continue".into()); }
        if let Some(v) = s("prompt") { a.push("--prompt".into()); a.push(v); }
        if b("auto") { a.push("--auto".into()); }
        if let Some(v) = s("logLevel") { a.push("--log-level".into()); a.push(v); }
        return a;
    }
    if b("continueSession") { a.push("--continue".into()); }
    if let Some(v) = s("session") { a.push("--session".into()); a.push(v); }
    if let Some(v) = s("model") { a.push("--model".into()); a.push(v); }
    if let Some(v) = s("agent") { a.push("--agent".into()); a.push(v); }
    if let Some(v) = s("prompt") { a.push("--prompt".into()); a.push(v); }
    if b("auto") { a.push("--auto".into()); }
    if b("pure") { a.push("--pure".into()); }
    if let Some(v) = s("logLevel") { a.push("--log-level".into()); a.push(v); }
    a
}

pub fn render_args(tokens: &[String], extra: &str) -> String {
    let mut parts: Vec<String> = tokens
        .iter()
        .map(|t| if needs_quote(t) { quote(t) } else { t.clone() })
        .collect();
    if !extra.trim().is_empty() {
        parts.push(extra.trim().to_string());
    }
    parts.join(" ")
}

/// Spawn a GUI program detached so it outlives this app.
fn spawn_detached(exe: &str, args: &[String]) -> bool {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    match cmd.spawn() {
        Ok(_) => true,
        Err(e) => {
            log(&format!("spawn {} failed: {}", exe, e));
            false
        }
    }
}

fn windows_terminal() -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let p = PathBuf::from(&local).join("Microsoft").join("WindowsApps").join("wt.exe");
    if p.is_file() { Some(p.to_string_lossy().to_string()) } else { None }
}

pub fn launch(dir: &str, terminal: &str, opts: &Value) -> Value {
    let dir_path = PathBuf::from(dir);
    if !dir_path.is_dir() {
        return json!({ "ok": false, "error": format!("目录不存在：{}", dir) });
    }
    let Some(oc) = locate_opencode() else {
        return json!({ "ok": false, "error": "未找到 opencode，请先点击「安装 / 修复」" });
    };
    let major = opencode_major();
    let args = build_args(opts, major);
    let extra = opts.get("extraArgs").and_then(|v| v.as_str()).unwrap_or("");
    let inner = render_args(&args, extra);
    let title = format!("opencode · {}", dir_path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| dir.to_string()));

    let _ = fs::create_dir_all(data_dir());
    let script = data_dir().join(format!("run-{}-{}.cmd", std::process::id(), now_ms()));
    let body = format!(
        "@echo off\r\nchcp 65001 >nul\r\ncd /d \"{}\"\r\n\"{}\" {}\r\n",
        dir,
        oc.to_string_lossy(),
        inner
    );
    if fs::write(&script, body).is_err() {
        return json!({ "ok": false, "error": "无法写入启动脚本" });
    }
    let script_s = script.to_string_lossy().to_string();

    // Preferred: our own wt window, spawned directly (no shell wrapper).
    if (terminal == "auto" || terminal == "wt") && windows_terminal().is_some() {
        if let Some(wt) = windows_terminal() {
            let args: Vec<String> = vec![
                "-w".into(), "new".into(),
                "-d".into(), dir.into(),
                "--title".into(), title.clone(),
                "cmd".into(), "/k".into(), script_s.clone(),
            ];
            if spawn_detached(&wt, &args) {
                log(&format!("launch dir={} method=wt script={}", dir, script_s));
                return json!({ "ok": true, "method": "Windows Terminal", "script": script_s, "args": args });
            }
        }
    }
    // Fallback: a classic console window.
    let cmdline = format!("start \"opencode\" /D \"{}\" cmd /k \"{}\"", dir, script_s);
    if spawn_detached("cmd.exe", &["/c".into(), cmdline]) {
        log(&format!("launch dir={} method=cmd script={}", dir, script_s));
        return json!({ "ok": true, "method": "命令提示符", "script": script_s });
    }
    let _ = fs::remove_file(&script);
    json!({ "ok": false, "error": "启动失败：无法创建终端窗口" })
}

pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/* ------------------------------------------------------------- sessions io --- */

#[derive(Clone, Debug)]
pub struct LiveSession {
    pub script: String,
    pub pane_pid: u32,
    pub window_pid: u32,
}

/// Same match as the Electron build: a terminal pane running one of our
/// `run-*.cmd` scripts, plus the window that was launched for that script.
pub fn discover_sessions() -> Vec<LiveSession> {
    let dir = data_dir().to_string_lossy().replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'\n\
$dir = '{dir}'\n\
$all = Get-CimInstance Win32_Process\n\
$panes = $all | Where-Object {{\n\
  $_.CommandLine -and\n\
  $_.CommandLine -match '^\\s*\"?cmd(\\.exe)?\"?\\s+/k\\s' -and\n\
  $_.CommandLine.Contains($dir) -and\n\
  $_.CommandLine -match 'run-\\d+-\\d+\\.cmd'\n\
}}\n\
foreach ($p in $panes) {{\n\
  $m = [regex]::Match($p.CommandLine, 'run-\\d+-\\d+\\.cmd')\n\
  if (-not $m.Success) {{ continue }}\n\
  $base = $m.Value\n\
  $win = 0\n\
  $cur = $p\n\
  for ($i = 0; $i -lt 6 -and $cur; $i++) {{\n\
    if ($cur.ProcessId -eq $cur.ParentProcessId) {{ break }}\n\
    $parent = $all | Where-Object {{ $_.ProcessId -eq $cur.ParentProcessId }} | Select-Object -First 1\n\
    if (-not $parent) {{ break }}\n\
    if ($parent.Name -eq 'WindowsTerminal.exe' -and $parent.CommandLine -and $parent.CommandLine.Contains($base)) {{ $win = $parent.ProcessId; break }}\n\
    $cur = $parent\n\
  }}\n\
  Write-Output ($base + '|' + $p.ProcessId + '|' + $win)\n\
}}"
    );

    let out = powershell(&script);
    let mut list = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        let parts: Vec<&str> = t.split('|').collect();
        if parts.len() < 2 {
            continue;
        }
        let name = parts[0].trim();
        if !name.starts_with("run-") || !name.ends_with(".cmd") {
            continue;
        }
        let Some(pane) = parts[1].trim().parse::<u32>().ok() else { continue };
        let win = parts.get(2).and_then(|v| v.trim().parse::<u32>().ok()).unwrap_or(0);
        list.push(LiveSession { script: name.to_string(), pane_pid: pane, window_pid: win });
    }
    list
}

pub fn kill_sessions() -> Value {
    let sessions = discover_sessions();
    let mut killed: Vec<Value> = Vec::new();
    let mut swept = 0;
    for s in &sessions {
        if s.window_pid > 0 {
            let _ = run_status("taskkill", &["/PID", &s.window_pid.to_string(), "/F", "/T"]);
        }
        let _ = run_status("taskkill", &["/PID", &s.pane_pid.to_string(), "/F", "/T"]);
        let _ = fs::remove_file(data_dir().join(&s.script));
        killed.push(json!({ "script": s.script }));
    }
    // Sweep anything left — manually started sessions, orphans, the service.
    for img in ["opencode.exe", "opencode2.exe"] {
        let out = run_status("taskkill", &["/IM", img, "/F", "/T"]);
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            swept += text.matches("SUCCESS").count().max(1);
        }
    }
    log(&format!("kill: sessions={} swept={}", killed.len(), swept));
    json!({ "ok": true, "killed": killed, "stale": [], "errors": [], "swept": swept })
}

/* ---------------------------------------------------------------- sessions --- */

fn session_rows(db: &rusqlite::Connection, table: &str) -> Option<Vec<serde_json::Map<String, Value>>> {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({})", table)).ok()?;
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();
    for req in ["id", "directory", "time_updated"] {
        if !cols.iter().any(|c| c == req) {
            return None;
        }
    }
    let optional = [
        "id", "slug", "directory", "title", "agent", "model", "cost",
        "tokens_input", "tokens_output", "time_created", "time_updated",
    ];
    let select: Vec<String> = optional
        .iter()
        .filter(|c| cols.iter().any(|x| x == *c))
        .map(|c| format!("s.{}", c))
        .collect();
    let count = message_count_sql(db);
    let where_ = if cols.iter().any(|c| c == "time_archived") {
        "WHERE s.time_archived IS NULL "
    } else {
        ""
    };
    let sql = format!(
        "SELECT {}, {} FROM {} s {}\
         ORDER BY s.time_updated DESC LIMIT 1000",
        select.join(", "), count, table, where_
    );
    let mut stmt = db.prepare(&sql).ok()?;
    let n = stmt.column_count();
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query([]).ok()?;
    let mut out = Vec::new();
    while let Ok(Some(r)) = rows.next() {
        let mut m = serde_json::Map::new();
        for i in 0..n {
            let v: Value = match r.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                Ok(rusqlite::types::ValueRef::Integer(v)) => json!(v),
                Ok(rusqlite::types::ValueRef::Real(f)) => json!(f),
                Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                Ok(rusqlite::types::ValueRef::Blob(_)) => Value::Null,
                Err(_) => Value::Null,
            };
            m.insert(names[i].clone(), v);
        }
        out.push(m);
    }
    Some(out)
}

fn table_exists(db: &rusqlite::Connection, name: &str) -> bool {
    db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

/// Column names of a table (empty when the table does not exist).
fn table_columns(db: &rusqlite::Connection, name: &str) -> Vec<String> {
    db.prepare(&format!("PRAGMA table_info({})", name))
        .ok()
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1)).ok().map(|it| {
                it.filter_map(|x| x.ok()).collect()
            })
        })
        .unwrap_or_default()
}

fn message_count_sql(db: &rusqlite::Connection) -> String {
    let mut present = Vec::new();
    for t in ["session_message", "message"] {
        if table_exists(db, t) {
            present.push(t);
        }
    }
    if present.is_empty() {
        return "0 AS message_count".into();
    }
    let parts: Vec<String> = present
        .iter()
        .map(|t| format!("SELECT COUNT(*) AS c FROM {} WHERE session_id = s.id", t))
        .collect();
    format!("(SELECT MAX(c) FROM ({})) AS message_count", parts.join(" UNION ALL "))
}

fn num(v: &Value) -> f64 {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0)
}

fn normalize(row: &serde_json::Map<String, Value>) -> Value {
    let get = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    let text = |k: &str| get(k).as_str().map(|s| s.to_string()).unwrap_or_default();
    let model = {
        let raw = get("model");
        match raw {
            // v2 stores the model as a JSON object: {"id":..., "providerID":...}
            Value::String(s) if s.starts_with('{') => serde_json::from_str::<Value>(&s)
                .ok()
                .and_then(|j| {
                    j.get("modelID")
                        .or_else(|| j.get("id"))
                        .or_else(|| j.get("model"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or(s),
            Value::String(s) => s,
            Value::Null => String::new(),
            other => other.to_string(),
        }
    };
    // Keep the title empty when opencode has none — the renderer then shows
    // the same "New session - <date>" label opencode itself uses. The slug
    // stays available separately.
    let title = text("title");
    json!({
        "id": text("id"),
        "slug": text("slug"),
        "directory": text("directory"),
        "title": title,
        "agent": text("agent"),
        "model": model,
        "cost": num(&get("cost")),
        "tokensIn": num(&get("tokens_input")),
        "tokensOut": num(&get("tokens_output")),
        "created": num(&get("time_created")),
        "updated": num(&get("time_updated")),
        "messages": num(&get("message_count")),
    })
}

pub fn list_sessions(dir: &str) -> Value {
    let db_path = opencode_db_path();
    if !db_path.exists() {
        return json!({ "ok": false, "reason": format!("未找到 opencode 数据库：{}", db_path.display()), "sessions": [] });
    }
    let conn = match rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "reason": format!("无法打开会话库：{}", e), "sessions": [] }),
    };
    let key = path_key(dir);
    let mut merged: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut readable = false;
    for table in ["session", "session_v2"] {
        let Some(rows) = session_rows(&conn, table) else { continue };
        readable = true;
        for r in rows {
            let n = normalize(&r);
            let id = n.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            let newer = match merged.get(&id) {
                Some(prev) => num(n.get("updated").unwrap_or(&Value::Null)) >= num(prev.get("updated").unwrap_or(&Value::Null)),
                None => true,
            };
            if newer {
                merged.insert(id, n);
            }
        }
    }
    if !readable {
        return json!({ "ok": false, "reason": "opencode 会话表结构不匹配，请升级 opencode", "sessions": [] });
    }
    let mut list: Vec<Value> = merged
        .into_values()
        .filter(|s| path_key(s.get("directory").and_then(|v| v.as_str()).unwrap_or("")) == key)
        .collect();
    list.sort_by(|a, b| {
        num(b.get("updated").unwrap_or(&Value::Null))
            .partial_cmp(&num(a.get("updated").unwrap_or(&Value::Null)))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    json!({ "ok": true, "sessions": list })
}

/// Open the opencode database read-only, or `None` when it is missing/locked.
fn opencode_conn() -> Option<rusqlite::Connection> {
    let db_path = opencode_db_path();
    if !db_path.exists() {
        return None;
    }
    rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()
}

/// Every project opencode itself knows about — the `project` table is the
/// authoritative list of worktrees that were ever opened in the TUI, so it
/// covers sessions the launcher never had a chance to record.
pub fn list_scanned_projects() -> Value {
    let Some(conn) = opencode_conn() else {
        return json!({ "ok": false, "reason": "未找到 opencode 数据库", "projects": [] });
    };
    if !table_exists(&conn, "project") {
        return json!({ "ok": true, "projects": [] });
    }
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(project)")
        .ok()
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1)).ok().map(|it| {
                it.filter_map(|x| x.ok()).collect()
            })
        })
        .unwrap_or_default();
    let has = |c: &str| cols.iter().any(|x| x == c);
    let mut select = vec!["id".to_string()];
    for c in ["worktree", "name", "vcs", "time_created", "time_updated", "time_active", "time_archived"] {
        if has(c) {
            select.push(c.to_string());
        }
    }
    let sql = format!("SELECT {} FROM project", select.join(", "));
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return json!({ "ok": false, "reason": "无法读取 project 表", "projects": [] });
    };
    let n = stmt.column_count();
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let Ok(mut rows) = stmt.query([]) else {
        return json!({ "ok": false, "reason": "无法读取 project 表", "projects": [] });
    };
    let mut out = Vec::new();
    while let Ok(Some(r)) = rows.next() {
        let mut m = serde_json::Map::new();
        for i in 0..n {
            let v: Value = match r.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                Ok(rusqlite::types::ValueRef::Integer(v)) => json!(v),
                Ok(rusqlite::types::ValueRef::Real(f)) => json!(f),
                Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                Ok(rusqlite::types::ValueRef::Blob(_)) => Value::Null,
                Err(_) => Value::Null,
            };
            m.insert(names[i].clone(), v);
        }
        let worktree = m.get("worktree").and_then(|v| v.as_str()).unwrap_or("").to_string();
        // "global" is the catch-all project, not a real directory.
        if worktree.is_empty() || worktree == "/" {
            continue;
        }
        // opencode records whatever directory it was started from as a project —
        // the user's home when the launcher was launched from there, a temp
        // folder otherwise. Those rows look like user-added projects, so they
        // are dropped instead of being shown as phantom entries.
        if is_scratch_path(&path_key(&worktree)) {
            continue;
        }
        let archived = m
            .get("time_archived")
            .map(|v| !v.is_null())
            .unwrap_or(false);
        let path = PathBuf::from(&worktree);
        let name = m
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| path.file_name().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_else(|| worktree.clone());
        out.push(json!({
            "id": m.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "path": worktree,
            "name": name,
            "vcs": m.get("vcs").and_then(|v| v.as_str()).unwrap_or(""),
            "archived": archived,
            "active": num(m.get("time_active").unwrap_or(&Value::Null)),
            "updated": num(m.get("time_updated").unwrap_or(&Value::Null)),
            "exists": path.is_dir(),
        }));
    }
    // The same directory can be recorded twice with different letter case
    // ("D:/..." and "d:/...") — collapse those into one entry.
    let mut by_key: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for p in out {
        let key = path_key(p.get("path").and_then(|v| v.as_str()).unwrap_or(""));
        let keep_new = match by_key.get(&key) {
            Some(prev) => {
                let pa = prev.get("archived").and_then(|v| v.as_bool()).unwrap_or(false);
                let na = p.get("archived").and_then(|v| v.as_bool()).unwrap_or(false);
                pa || !na
            }
            None => true,
        };
        if keep_new {
            by_key.insert(key, p);
        }
    }
    let mut out: Vec<Value> = by_key.into_values().collect();
    // Active projects first, then most recently touched.
    out.sort_by(|a, b| {
        let aa = a.get("archived").and_then(|v| v.as_bool()).unwrap_or(false);
        let ab = b.get("archived").and_then(|v| v.as_bool()).unwrap_or(false);
        ab.cmp(&aa)
            .then_with(|| {
                num(b.get("updated").unwrap_or(&Value::Null))
                    .partial_cmp(&num(a.get("updated").unwrap_or(&Value::Null)))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    json!({ "ok": true, "projects": out })
}

/// Every session opencode has, across all directories — the launcher used to
/// filter by project directory, which hid everything the user started in
/// opencode itself.
pub fn list_all_sessions() -> Value {
    let Some(conn) = opencode_conn() else {
        return json!({ "ok": false, "reason": "未找到 opencode 数据库", "sessions": [] });
    };
    let mut merged: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut readable = false;
    for table in ["session", "session_v2"] {
        let Some(rows) = session_rows(&conn, table) else { continue };
        readable = true;
        for r in rows {
            let n = normalize(&r);
            let id = n.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            let newer = match merged.get(&id) {
                Some(prev) => {
                    num(n.get("updated").unwrap_or(&Value::Null))
                        >= num(prev.get("updated").unwrap_or(&Value::Null))
                }
                None => true,
            };
            if newer {
                merged.insert(id, n);
            }
        }
    }
    if !readable {
        return json!({ "ok": false, "reason": "opencode 会话表结构不匹配，请升级 opencode", "sessions": [] });
    }
    let mut list: Vec<Value> = merged.into_values().collect();
    list.sort_by(|a, b| {
        num(b.get("updated").unwrap_or(&Value::Null))
            .partial_cmp(&num(a.get("updated").unwrap_or(&Value::Null)))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    json!({ "ok": true, "sessions": list })
}

/* -------------------------------------------------------------------- web --- */

/// URL of the running opencode background service, if any.
pub fn web_service_url() -> Option<String> {
    let oc = opencode_path_or("opencode");
    let out = run(&oc, &["service", "status"]);
    for line in out.lines() {
        let t = line.trim();
        if t.starts_with("http://") || t.starts_with("https://") {
            return Some(t.trim_end_matches('/').to_string());
        }
    }
    None
}

/// Is the service actually listening?
///
/// An open webview window is not the same as a running service: if opencode
/// dies while the window stays open, the page can only show "Failed to fetch".
/// A TCP connect to the reported port answers that in milliseconds.
pub fn web_alive() -> bool {
    let Some(url) = web_service_url() else {
        return false;
    };
    let rest = url
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let host_port = rest.split('/').next().unwrap_or("");
    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{}:80", host_port)
    };
    let sock: std::net::SocketAddr = match addr.parse() {
        Ok(s) => s,
        Err(_) => return false,
    };
    std::net::TcpStream::connect_timeout(&sock, std::time::Duration::from_millis(1200)).is_ok()
}

/// A one-time sign-in link for the web UI.
///
/// The background service is password protected: opening its bare root URL
/// only returns the page shell, and every API call behind it answers 401 —
/// the browser ends up on an unauthenticated page. `opencode pair` prints a
/// single-use `/auth/connect/...` link that, when opened in a browser, signs
/// the session in with a cookie and then loads the real web UI. (v1 had an
/// `opencode web` command; v2 replaced it with `pair`.)
pub fn web_pair_link() -> Option<String> {
    let oc = opencode_path_or("opencode");
    let out = run(&oc, &["pair"]);
    for line in out.lines() {
        let t = line.trim();
        if t.starts_with("http://") || t.starts_with("https://") {
            if t.contains("/auth/connect/") {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Start the background service (which also serves the web UI) and return its
/// URL. `opencode service start` is idempotent, so this is safe to call when
/// the service is already up.
pub fn web_start() -> Value {
    if let Some(url) = web_service_url() {
        return json!({ "ok": true, "url": url, "started": false });
    }
    let oc = opencode_path_or("opencode");
    let out = run(&oc, &["service", "start"]);
    // The service comes up asynchronously — poll for its URL for a few seconds.
    for _ in 0..20 {
        if let Some(url) = web_service_url() {
            return json!({ "ok": true, "url": url, "started": true });
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let lowered = out.to_lowercase();
    if lowered.contains("already") || lowered.contains("running") {
        if let Some(url) = web_service_url() {
            return json!({ "ok": true, "url": url, "started": false });
        }
    }
    json!({ "ok": false, "error": "opencode 后台服务启动失败", "detail": out.trim() })
}

/// Open the web UI in the browser.
///
/// The service must be up first, and the URL handed to the browser has to be
/// the one-time pairing link — the bare service address would only show an
/// unauthenticated page.
pub fn web_open_url() -> Value {
    let started = web_start();
    if started["ok"] != json!(true) {
        return started;
    }
    let base = started
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    match web_pair_link() {
        Some(link) => json!({ "ok": true, "url": link, "base": base, "started": started["started"] }),
        None => json!({
            "ok": false,
            "error": "无法生成 Web 版登录链接",
            "detail": "opencode pair 没有输出可用链接，可手动运行 opencode pair 后打开提示的地址",
        }),
    }
}

/// Shared background-service password, used for HTTP basic auth on /api/*.
///
/// opencode keeps it in `~/.local/state/opencode/service.json` (newer builds
/// also carry `url` and `pid` there) with `~/.config/opencode/service.json`
/// as the older fallback.
fn opencode_service_password() -> Option<String> {
    let state = dirs_home()
        .join(".local")
        .join("state")
        .join("opencode")
        .join("service.json");
    let config = dirs_home()
        .join(".config")
        .join("opencode")
        .join("service.json");
    for p in [state, config] {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(pw) = v.get("password").and_then(|x| x.as_str()) {
                    if !pw.is_empty() {
                        return Some(pw.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Percent-encode a query value (UTF-8, everything but unreserved characters).
fn query_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Register a directory with the running opencode service.
///
/// The web UI's own "add project" flow does exactly this: a GET on
/// `/api/location` with the directory makes the server create its project
/// record (it also does so for paths that do not exist yet on disk). Doing it
/// from the launcher means the folder shows up in the web UI without the user
/// having to fight the web file picker at all.
pub fn web_register_project(dir: &str) -> Value {
    let dir = dir.trim();
    if dir.is_empty() {
        return json!({ "ok": false, "error": "目录为空" });
    }
    let base = match web_service_url() {
        Some(u) => u,
        None => match web_start().get("url").and_then(|v| v.as_str()) {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => return json!({ "ok": false, "error": "opencode 服务未运行" }),
        },
    };
    // The password is optional: a service without one answers anonymously.
    let pw = opencode_service_password();
    // System curl ships with Windows 10 1803+; matches how the rest of the
    // backend shells out. The service is only password protected when opencode
    // generated one, so the first attempt is unauthenticated and a 401 (or an
    // auth error body) triggers a retry with basic auth — a machine with no
    // service password still works.
    let url = format!(
        "{}/api/location?location%5Bdirectory%5D={}",
        base,
        query_encode(dir)
    );
    let mut out = run("curl.exe", &["-s", "-m", "15", &url]);
    if let Some(pw) = &pw {
        if out.is_empty()
            || out.contains("UnauthorizedError")
            || out.contains("Authentication required")
        {
            out = run(
                "curl.exe",
                &["-s", "-m", "15", "-u", &format!("opencode:{}", pw), &url],
            );
        }
    }
    let unauthorized = out.contains("UnauthorizedError") || out.contains("Authentication required");
    // A directory that does not exist yet is still registered by the service.
    let missing = out.contains("LocationNotFoundError");
    json!({
        "ok": !unauthorized,
        "dir": dir,
        "missing": missing,
        "detail": out.trim().chars().take(300).collect::<String>(),
    })
}

/// Register every project in the launcher's library, then open the web UI —
/// one click syncs the whole list into the web client.
/// Make opencode's own session store match what the launcher shows.
///
/// The web client only reads the v2 tables (`session_v2` + `session_message`),
/// so sessions can exist in the database yet be invisible there. Three things
/// are repaired, all of them additive or corrective:
///
/// 1. **Ownership** — a session stores the id of the project it belongs to.
///    Sessions created before their folder was known carry `project_id =
///    "global"`, which makes the web client file them under the root instead
///    of under the project. The id is re-derived from the session's own
///    directory.
/// 2. **Duplicates** — the same folder can be recorded twice ("D:/x" and
///    "d:/X"), which shows up as two identical projects in the web client.
///    The stale one is merged into the survivor and its sessions are
///    re-pointed first.
/// 3. **Legacy sessions** — sessions that only exist in the old `session` /
///    `message` / `part` tables are copied into the v2 tables (the v2 row is
///    a superset of the v1 one), with their messages converted to the v2
///    `session_message` shape. Nothing is deleted.
///
/// The database is backed up with `VACUUM INTO` before anything is written,
/// and every change runs inside one transaction.
pub fn sync_opencode_sessions() -> Value {
    let db_path = opencode_db_path();
    if !db_path.exists() {
        return json!({ "ok": false, "error": "未找到 opencode 数据库" });
    }
    sync_opencode_sessions_at(&db_path)
}

/// Same as [`sync_opencode_sessions`], but against an explicit database file —
/// the seam the unit tests use.
fn sync_opencode_sessions_at(db_path: &std::path::Path) -> Value {
    if !db_path.exists() {
        return json!({ "ok": false, "error": "未找到 opencode 数据库" });
    }
    let conn = match rusqlite::Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("无法打开数据库：{}", e) }),
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(8));
    if !table_exists(&conn, "project") {
        return json!({ "ok": false, "error": "opencode 数据库缺少 project 表" });
    }
    let mut stats = json!({
        "ok": true,
        "projectsMerged": 0,
        "reattached": 0,
        "migrated": 0,
        "messages": 0,
        "backup": "",
    });

    // ---- backup before touching anything ---------------------------
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let backup = db_path.with_file_name(format!("opencode.db.bak-{}", stamp));
    let _ = conn.execute(
        "VACUUM INTO ?1",
        rusqlite::params![backup.to_string_lossy().to_string()],
    );
    if backup.exists() {
        stats["backup"] = json!(backup.to_string_lossy().to_string());
    }

    let tx = match conn.unchecked_transaction() {
        Ok(t) => t,
        Err(e) => return json!({ "ok": false, "error": format!("无法开启事务：{}", e) }),
    };

    // ---- 1. merge duplicate project rows ---------------------------
    let mut groups: std::collections::HashMap<String, Vec<(String, String, bool, i64)>> =
        std::collections::HashMap::new();
    {
        let mut stmt = match tx.prepare("SELECT id, worktree, time_archived, time_updated FROM project") {
            Ok(s) => s,
            Err(e) => {
                // The transaction rolls back when it is dropped.
                return json!({ "ok": false, "error": e.to_string() });
            }
        };
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?.is_some(),
                r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            ))
        });
        if let Ok(it) = rows {
            for row in it.flatten() {
                let (id, worktree, archived, updated) = row;
                if worktree.is_empty() || worktree == "/" {
                    continue;
                }
                groups
                    .entry(path_key(&worktree))
                    .or_default()
                    .push((id, worktree, archived, updated));
            }
        }
    }
    let mut merged = 0i64;
    for (_, mut list) in groups {
        if list.len() < 2 {
            continue;
        }
        // Keep the newest, unarchived row.
        list.sort_by(|a, b| {
            a.2.cmp(&b.2).then(b.3.cmp(&a.3))
        });
        let keep = list[0].0.clone();
        for (dup_id, _, _, _) in list.iter().skip(1) {
            for table in ["session", "session_v2"] {
                if table_exists(&conn, table) {
                    let _ = tx.execute(
                        &format!("UPDATE {} SET project_id = ?1 WHERE project_id = ?2", table),
                        rusqlite::params![keep, dup_id],
                    );
                }
            }
            let _ = tx.execute("DELETE FROM project WHERE id = ?1", rusqlite::params![dup_id]);
            merged += 1;
        }
    }
    stats["projectsMerged"] = json!(merged);

    // ---- 2. re-attach sessions to their project --------------------
    let mut by_key: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    {
        let mut stmt = match tx.prepare("SELECT id, worktree FROM project") {
            Ok(s) => s,
            Err(e) => {
                // The transaction rolls back when it is dropped.
                return json!({ "ok": false, "error": e.to_string() });
            }
        };
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
        if let Ok(it) = rows {
            for row in it.flatten() {
                let (id, worktree) = row;
                if worktree.is_empty() || worktree == "/" {
                    continue;
                }
                by_key.entry(path_key(&worktree)).or_insert(id);
            }
        }
    }
    let mut reattached = 0i64;
    for table in ["session", "session_v2"] {
        if !table_exists(&conn, table) {
            continue;
        }
        let mut ids: Vec<(String, String, String)> = Vec::new();
        {
            let mut stmt = match tx.prepare(&format!("SELECT id, project_id, directory FROM {}", table)) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            });
            if let Ok(it) = rows {
                for row in it.flatten() {
                    ids.push(row);
                }
            }
        }
        for (id, project_id, directory) in ids {
            if let Some(target) = by_key.get(&path_key(&directory)) {
                if &project_id == target {
                    continue;
                }
                if tx
                    .execute(
                        &format!("UPDATE {} SET project_id = ?1 WHERE id = ?2", table),
                        rusqlite::params![target, id],
                    )
                    .is_ok()
                {
                    reattached += 1;
                }
            }
        }
    }
    stats["reattached"] = json!(reattached);

    // ---- 3. copy legacy sessions into the v2 tables -----------------
    let mut migrated = 0i64;
    let mut messages = 0i64;
    if table_exists(&conn, "session") && table_exists(&conn, "session_v2") {
        let session_cols = table_columns(&conn, "session");
        let v2_cols = table_columns(&conn, "session_v2");
        let shared: Vec<String> = v2_cols
            .iter()
            .filter(|c| session_cols.contains(c))
            .cloned()
            .collect();
        let mut legacy: Vec<serde_json::Map<String, Value>> = Vec::new();
        {
            let mut stmt = match tx.prepare("SELECT * FROM session") {
                Ok(s) => s,
                Err(_) => {
                    return json!({ "ok": false, "error": "无法读取 session 表" });
                }
            };
            let rows = stmt.query_map([], |r| {
                let n = r.as_ref().column_count();
                let mut m = serde_json::Map::new();
                for i in 0..n {
                    let name = r.as_ref().column_name(i).unwrap_or("").to_string();
                    let v: Value = match r.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                        Ok(rusqlite::types::ValueRef::Integer(v)) => json!(v),
                        Ok(rusqlite::types::ValueRef::Real(f)) => json!(f),
                        Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                        Ok(rusqlite::types::ValueRef::Blob(_)) => Value::Null,
                        Err(_) => Value::Null,
                    };
                    m.insert(name, v);
                }
                Ok(m)
            });
            if let Ok(it) = rows {
                for row in it.flatten() {
                    legacy.push(row);
                }
            }
        }
        for s in legacy {
            let sid = s.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if sid.is_empty() {
                continue;
            }
            let exists: i64 = tx
                .query_row(
                    "SELECT count(*) FROM session_v2 WHERE id = ?1",
                    rusqlite::params![sid],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if exists > 0 {
                continue;
            }
            let cols: Vec<&str> = shared.iter().map(|s| s.as_str()).collect();
            let sql = format!(
                "INSERT INTO session_v2 ({}) VALUES ({})",
                cols.join(","),
                cols.iter().map(|_| "?").collect::<Vec<_>>().join(",")
            );
            let values: Vec<rusqlite::types::Value> = shared
                .iter()
                .map(|c| match s.get(c) {
                    Some(Value::String(v)) => rusqlite::types::Value::Text(v.clone()),
                    Some(Value::Number(v)) => {
                        if let Some(i) = v.as_i64() {
                            rusqlite::types::Value::Integer(i)
                        } else {
                            rusqlite::types::Value::Real(v.as_f64().unwrap_or(0.0))
                        }
                    }
                    Some(Value::Bool(b)) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
                    _ => rusqlite::types::Value::Null,
                })
                .collect();
            if tx.execute(&sql, rusqlite::params_from_iter(values)).is_ok() {
                migrated += 1;
                messages += migrate_session_messages(&tx, &sid);
            }
        }
    }
    stats["migrated"] = json!(migrated);
    stats["messages"] = json!(messages);

    if let Err(e) = tx.commit() {
        return json!({ "ok": false, "error": format!("提交失败：{}", e) });
    }
    stats
}

/// Convert one legacy session's messages into v2 `session_message` rows.
///
/// v1 keeps a `message` row per turn with the payload split across `part`
/// rows; v2 keeps one `session_message` row per turn with the parts inlined
/// as `content`. The shapes are close enough to translate field by field.
fn migrate_session_messages(tx: &rusqlite::Transaction, session_id: &str) -> i64 {
    if !table_exists(tx, "session_message") || !table_exists(tx, "message") || !table_exists(tx, "part") {
        return 0;
    }
    let mut msgs: Vec<(String, i64, i64, String)> = Vec::new();
    {
        let mut stmt = match tx
            .prepare("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ?1 ORDER BY time_created, id")
        {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let rows = stmt.query_map(rusqlite::params![session_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        });
        if let Ok(it) = rows {
            for row in it.flatten() {
                msgs.push(row);
            }
        }
    }
    let mut seq = 0i64;
    let mut written = 0i64;
    for (mid, created, updated, data) in msgs {
        let meta: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
        let role = meta.get("role").and_then(|v| v.as_str()).unwrap_or("user").to_string();
        // Collect the parts of this message.
        let mut parts: Vec<Value> = Vec::new();
        {
            let mut stmt = match tx
                .prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY time_created, id")
            {
                Ok(s) => s,
                Err(_) => continue,
            };
            let rows = stmt.query_map(rusqlite::params![mid], |r| {
                Ok(r.get::<_, Option<String>>(0)?.unwrap_or_default())
            });
            if let Ok(it) = rows {
                for row in it.flatten() {
                    if let Ok(v) = serde_json::from_str::<Value>(&row) {
                        parts.push(v);
                    }
                }
            }
        }
        let payload = if role == "assistant" {
            let mut content: Vec<Value> = Vec::new();
            for p in &parts {
                match p.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "text" | "reasoning" => content.push(json!({
                        "type": p.get("type").cloned().unwrap_or(Value::Null),
                        "text": p.get("text").and_then(|v| v.as_str()).unwrap_or(""),
                    })),
                    "tool" => content.push(json!({
                        "type": "tool",
                        "id": p.get("callID").or_else(|| p.get("callId")).cloned().unwrap_or(json!("")),
                        "name": p.get("tool").or_else(|| p.get("name")).cloned().unwrap_or(json!("")),
                        "state": p.get("state").cloned().unwrap_or(json!({})),
                    })),
                    _ => {}
                }
            }
            json!({
                "agent": meta.get("agent").cloned().unwrap_or(json!("build")),
                "model": {
                    "providerID": meta.get("providerID").cloned().unwrap_or(json!("opencode")),
                    "id": meta.get("modelID").cloned().unwrap_or(json!("")),
                    "variant": "default",
                },
                "content": content,
                "time": { "created": meta.pointer("/time/created").cloned().unwrap_or(json!(created)) },
            })
        } else {
            let text: String = parts
                .iter()
                .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("text"))
                .filter_map(|p| p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect::<Vec<_>>()
                .join("\n");
            json!({ "text": text, "time": { "created": meta.pointer("/time/created").cloned().unwrap_or(json!(created)) } })
        };
        let _ = tx.execute(
            "INSERT OR REPLACE INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![
                format!("msgv2_{}", mid),
                session_id,
                if role == "assistant" { "assistant" } else { "user" },
                seq,
                created,
                updated,
                payload.to_string()
            ],
        );
        seq += 1;
        written += 1;
    }
    written
}

pub fn web_sync_projects() -> Value {
    let cfg = read_config();
    let mut dirs: Vec<String> = cfg.projects.iter().map(|p| p.path.clone()).filter(|p| !p.is_empty()).collect();
    if dirs.is_empty() {
        return json!({ "ok": false, "error": "项目库是空的" });
    }
    // Sessions started outside the library live in folders the service has
    // never heard of — their project row has to exist before the ownership
    // can be repaired, so register those folders as well.
    let mut known: std::collections::HashSet<String> = dirs.iter().map(|d| path_key(d)).collect();
    for s in list_all_sessions()["sessions"].as_array().cloned().unwrap_or_default() {
        let dir = s.get("directory").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if dir.is_empty() || known.contains(&path_key(&dir)) {
            continue;
        }
        known.insert(path_key(&dir));
        dirs.push(dir);
    }
    let mut registered = 0usize;
    let mut missing: Vec<String> = Vec::new();
    for dir in &dirs {
        let r = web_register_project(dir);
        if r["ok"] == json!(true) {
            registered += 1;
        }
        if r["missing"] == json!(true) {
            missing.push(r["dir"].as_str().unwrap_or("").to_string());
        }
    }
    // The web client reads the v2 tables only — repair ownership and legacy
    // rows before opening it, otherwise the sessions stay invisible there.
    let sessions = sync_opencode_sessions();
    let open = web_open_url();
    json!({
        "ok": open["ok"] == json!(true),
        "total": dirs.len(),
        "registered": registered,
        "missing": missing,
        "sessions": sessions,
        "open": open,
    })
}


/// Register the directory with the service, then open the web UI (pairing
/// link) in the browser.
pub fn web_open_project(dir: &str) -> Value {
    let reg = web_register_project(dir);
    let sessions = sync_opencode_sessions();
    let open = web_open_url();
    json!({
        "ok": open["ok"] == json!(true),
        "register": reg,
        "sessions": sessions,
        "open": open,
    })
}

/* ------------------------------------------------- built-in web window --- */

/// The seeding routine that runs *inside* the web page.
///
/// Kept in `shared/web-seed.js` and compiled in here — the Electron build
/// reads the very same file at runtime, so the merge rules cannot drift.
fn web_seed_source() -> &'static str {
    include_str!("../../../shared/web-seed.js")
}

/// Script that seeds the workspace panel, then reloads once if anything moved.
///
/// The web client reads its project list at startup, so writing localStorage
/// alone would not repaint the sidebar — the reload is what makes it visible.
pub fn web_seed_script(dirs: &[String]) -> String {
    const TPL: &str = r#"(function(){__SRC__
var r=__ocLauncherSeed(__SEED__);if(r&&r.changed){location.reload();}return r;})()"#;
    TPL.replace("__SRC__", web_seed_source())
        .replace("__SEED__", &json!({ "dirs": dirs }).to_string())
}

/// Body of the "sync" bookmarklet — the caller prefixes `javascript:` and
/// percent-encodes it.
pub fn web_bookmarklet_body() -> String {
    const TPL: &str = r#"(function(){__SRC__
fetch("/api/project").then(function(r){return r.json();}).then(function(j){var a=Array.isArray(j)?j:(j.data||[]);var dirs=a.map(function(p){return p&&(p.canonical||p.worktree||p.directory);}).filter(Boolean);var r=__ocLauncherSeed({dirs:dirs});if(r.changed){location.reload();}else{alert("项目已是最新（"+r.total+" 个）");}}).catch(function(e){alert("同步失败："+e);});})()"#;
    TPL.replace("__SRC__", web_seed_source())
}

/// Project directories the service knows about — the same list the settings
/// page renders, so the workspace panel can be made to match it.
/// Directories the service knows about (`/api/project`).
///
/// Directories the service knows about (`/api/project`), for diagnostics.
/// The workspace panel seeds from the library instead — see `web_seed_dirs`.
#[allow(dead_code)]
pub fn web_project_dirs() -> Vec<String> {
    let base = match web_service_url() {
        Some(u) => u,
        None => match web_start().get("url").and_then(|v| v.as_str()) {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => return Vec::new(),
        },
    };
    let pw = opencode_service_password();
    let url = format!("{}/api/project", base);
    let mut out = run("curl.exe", &["-s", "-m", "15", &url]);
    if out.trim().is_empty() || out.contains("UnauthorizedError") || out.contains("Authentication required") {
        if let Some(pw) = &pw {
            out = run(
                "curl.exe",
                &["-s", "-m", "15", "-u", &format!("opencode:{}", pw), &url],
            );
        }
    }
    let parsed: Value = match serde_json::from_str(&out) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = parsed
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| parsed.as_array().cloned())
        .unwrap_or_default();
    arr.iter()
        .filter_map(|p| {
            p.get("canonical")
                .and_then(|v| v.as_str())
                .or_else(|| p.get("worktree").and_then(|v| v.as_str()))
                .or_else(|| p.get("directory").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
        })
        // "/" is the global pseudo-project, not a real folder.
        .filter(|s| !s.is_empty() && s != "/" && s != "\\")
        .collect()
}

/// Directories the workspace panel should list — exactly the launcher's own
/// project library.
///
/// The library is the single source of truth: removing a project there must
/// also remove it from the web panel, which the seed's mark-and-sweep step
/// handles (anything the launcher added last time but no longer seeds gets
/// dropped). Merging the service's project table in would resurrect projects
/// the user already deleted, so it is deliberately left out.
pub fn web_seed_dirs() -> Vec<String> {
    let cfg = read_config();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for dir in cfg.projects.iter().map(|p| p.path.clone()) {
        let k = path_key(&dir);
        if k.is_empty() || !seen.insert(k) {
            continue;
        }
        out.push(dir);
    }
    out
}

/// Folders the service registers but nobody picked as a project.
///
/// opencode creates a `project` row for the directory the background service
/// happened to start in (the user's home folder), and the launcher's own sync
/// used to leave temp dirs behind. Neither is a project the user chose.
fn is_scratch_path(key: &str) -> bool {
    if key.is_empty() {
        return true;
    }
    // A bare drive root (`c:`) is never a project either.
    if key.len() == 2 && key.ends_with(':') {
        return true;
    }
    let home = path_key(&std::env::var("USERPROFILE").unwrap_or_default());
    let tmp = path_key(&std::env::temp_dir().to_string_lossy());
    if !home.is_empty() && key == home {
        return true;
    }
    if !tmp.is_empty() && (key == tmp || key.starts_with(&format!("{}\\", tmp))) {
        return true;
    }
    false
}

/// `(id, worktree, name)` rows of the service's project table, global excluded.
fn read_service_project_rows() -> Option<Vec<(String, String, String)>> {
    let db_path = opencode_db_path();
    if !db_path.exists() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    let mut stmt = conn
        .prepare("SELECT id, worktree, COALESCE(name, '') FROM project")
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .ok()?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        if row.1.is_empty() || row.1 == "/" {
            continue;
        }
        out.push(row);
    }
    Some(out)
}

/// Make sure the service has a project row for `dir`.
///
/// `/api/location` registers the folder in memory and hands back the id the
/// service itself computed, but opencode only *persists* a row for folders it
/// considers real projects — a folder the user just added to the launcher often
/// gets none. Writing the row here, reusing that id so both sides agree, is what
/// makes the library authoritative: every library folder then exists for the
/// web UI and the terminal, whatever opencode decided on its own.
pub fn ensure_service_project(dir: &str) -> Value {
    let target = dir.trim();
    if target.is_empty() {
        return json!({ "ok": false, "error": "目录为空" });
    }
    let key = path_key(target);
    if let Some(rows) = read_service_project_rows() {
        if rows.iter().any(|(_, w, _)| path_key(w) == key) {
            return json!({ "ok": true, "existed": true, "dir": target });
        }
    }

    let reg = web_register_project(target);
    if reg.get("ok") != Some(&json!(true)) {
        return reg;
    }
    // The response body carries the project the service computed for us.
    let id = reg
        .get("detail")
        .and_then(|d| d.as_str())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| {
            v.get("project")
                .and_then(|p| p.get("id"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    if id.len() < 8 {
        return json!({ "ok": false, "dir": target, "error": "服务未返回项目 ID" });
    }

    let db_path = opencode_db_path();
    if !db_path.exists() {
        return json!({ "ok": false, "dir": target, "error": "未找到 opencode 数据库" });
    }
    let conn = match rusqlite::Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "dir": target, "error": e.to_string() }),
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(8000));
    let now = now_ms() as u64;
    match conn.execute(
        "INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated, time_active)
         VALUES (?1, ?2, '[]', ?3, ?3, ?3)",
        rusqlite::params![id, target.replace('\\', "/"), now],
    ) {
        Ok(_) => json!({ "ok": true, "existed": false, "dir": target, "id": id }),
        Err(e) => json!({ "ok": false, "dir": target, "error": e.to_string() }),
    }
}

/// Remove a project from the service, so reconciliation does not bring it back.
pub fn delete_service_project_by_path(dir: &str) -> Value {
    let key = path_key(dir);
    if key.is_empty() {
        return json!({ "ok": false, "removed": false });
    }
    let Some(rows) = read_service_project_rows() else {
        return json!({ "ok": false, "removed": false });
    };
    let Some((id, _, _)) = rows.into_iter().find(|(_, w, _)| path_key(w) == key) else {
        return json!({ "ok": true, "removed": false });
    };
    let r = delete_project(&id);
    let ok = r.get("ok") == Some(&json!(true));
    json!({
        "ok": ok,
        "removed": ok,
        "error": r.get("error").cloned().unwrap_or(Value::Null),
    })
}

/// Two-way reconciliation between the launcher library and the service.
///
/// The library is what the user manages; the service's table is what the web UI
/// and the terminal see. Both are kept in step so a change made anywhere shows
/// up everywhere:
///
///   service only -> added to the library (a project created in web/terminal)
///   library only -> registered with the service, or dropped from the library
///                   when it was in the previous snapshot (deleted elsewhere)
///   both         -> the service's `name` wins, since renames happen there
pub fn sync_project_registry() -> Value {
    let mut cfg = read_config();
    let now = now_ms() as u64;
    let Some(rows) = read_service_project_rows() else {
        return json!({ "ok": false, "error": "读取 opencode 项目失败" });
    };
    let svc: Vec<(String, String, String)> = rows
        .into_iter()
        .filter(|(_, w, _)| !is_scratch_path(&path_key(w)))
        .collect();
    let svc_keys: std::collections::HashMap<String, (String, String)> = svc
        .iter()
        .map(|(id, w, n)| (path_key(w), (id.clone(), n.clone())))
        .collect();
    let prev: std::collections::HashSet<String> =
        cfg.synced_paths.iter().map(|p| path_key(p)).collect();

    let mut added: Vec<String> = Vec::new();
    let mut registered: Vec<String> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    let mut renamed: Vec<String> = Vec::new();

    // --- service -> library -------------------------------------------
    let mut lib_keys: std::collections::HashSet<String> =
        cfg.projects.iter().map(|p| path_key(&p.path)).collect();
    for (_, worktree, name) in svc.clone() {
        let k = path_key(&worktree);
        if lib_keys.contains(&k) {
            continue;
        }
        let display = if name.trim().is_empty() {
            worktree
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(&worktree)
                .to_string()
        } else {
            name.trim().to_string()
        };
        cfg.projects.insert(
            0,
            Project {
                path: worktree.clone(),
                name: display,
                added_at: now,
            },
        );
        lib_keys.insert(k);
        added.push(worktree);
    }

    // --- library -> service, and deletions seen on the service side ----
    let mut kept: Vec<Project> = Vec::new();
    for p in cfg.projects.clone() {
        let k = path_key(&p.path);
        if k.is_empty() || svc_keys.contains_key(&k) {
            kept.push(p);
            continue;
        }
        if prev.contains(&k) {
            // It was there last time and is gone now: deleted in the web UI or
            // the terminal. Follow it, or the row springs back every pass.
            dropped.push(p.path.clone());
            continue;
        }
        let r = ensure_service_project(&p.path);
        if r.get("ok") == Some(&json!(true)) {
            registered.push(p.path.clone());
        }
        kept.push(p);
    }
    cfg.projects = kept;

    // --- names ---------------------------------------------------------
    for p in cfg.projects.iter_mut() {
        if let Some((_, name)) = svc_keys.get(&path_key(&p.path)) {
            let n = name.trim();
            if !n.is_empty() && n != p.name {
                p.name = n.to_string();
                renamed.push(p.path.clone());
            }
        }
    }

    cfg.synced_paths = svc.iter().map(|(_, w, _)| w.clone()).collect();
    let total = cfg.projects.len();
    write_config(&cfg);
    json!({
        "ok": true,
        "added": added,
        "registered": registered,
        "dropped": dropped,
        "renamed": renamed,
        "total": total,
    })
}

/// Register every project in the library (best effort, one GET per folder).
///
/// Cheap compared to `web_sync_projects`, which also repairs the session
/// tables — the workspace panel only needs the project rows.
pub fn web_register_library() -> Value {
    let cfg = read_config();
    let dirs: Vec<String> = cfg
        .projects
        .iter()
        .map(|p| p.path.clone())
        .filter(|p| !p.is_empty())
        .collect();
    let mut ok = 0usize;
    for dir in &dirs {
        if web_register_project(dir)["ok"] == json!(true) {
            ok += 1;
        }
    }
    json!({ "total": dirs.len(), "ok": ok })
}


/// Whether the web UI answers right now.
pub fn web_status() -> Value {
    match web_service_url() {
        Some(url) => json!({ "ok": true, "url": url, "running": true }),
        None => json!({ "ok": true, "url": "", "running": false }),
    }
}

pub fn delete_session(id: &str) -> Value {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return json!({ "ok": false, "error": "会话 ID 无效" });
    }
    let out = run(&opencode_path_or("opencode"), &["session", "delete", id]);
    if out.to_lowercase().contains("not found") {
        return json!({ "ok": false, "error": "会话不存在，可能已被删除" });
    }
    json!({ "ok": true })
}

/// Delete a project record from opencode's own `project` table.
///
/// opencode has no CLI/API for removing a project, so the row has to go from
/// the database directly. Two things make that safe here:
///
/// * the row is matched by **id** (never by path), and the global pseudo
///   project (`worktree == "/"`) is refused outright — it holds every
///   session that has no real directory;
/// * the session tables are cleaned explicitly instead of relying on the
///   `ON DELETE CASCADE` foreign key, because SQLite does not enforce
///   foreign keys unless `PRAGMA foreign_keys = ON` is set on the very
///   connection that performs the delete, and opencode's own connections do
///   not guarantee that.
///
/// Only the records are removed — nothing on disk is touched.
pub fn delete_project(id: &str) -> Value {
    let db_path = opencode_db_path();
    if !db_path.exists() {
        return json!({ "ok": false, "error": "未找到 opencode 数据库" });
    }
    delete_project_at(&db_path, id)
}

/// Same as [`delete_project`], but against an explicit database file — the
/// seam the unit tests use.
fn delete_project_at(db_path: &std::path::Path, id: &str) -> Value {
    let id = id.trim();
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return json!({ "ok": false, "error": "项目 ID 无效" });
    }
    let conn = match rusqlite::Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("无法打开数据库：{}", e) }),
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    if !table_exists(&conn, "project") {
        return json!({ "ok": false, "error": "opencode 数据库缺少 project 表" });
    }
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id, worktree FROM project WHERE id = ?1",
            rusqlite::params![id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .ok();
    let Some((pid, worktree)) = row else {
        return json!({ "ok": false, "error": "项目不存在，可能已被删除" });
    };
    if worktree == "/" || worktree.is_empty() {
        return json!({ "ok": false, "error": "不能删除全局项目" });
    }
    let mut sessions = 0i64;
    let mut err = String::new();
    let tx = match conn.unchecked_transaction() {
        Ok(t) => t,
        Err(e) => return json!({ "ok": false, "error": format!("无法开启事务：{}", e) }),
    };
    // Collect the session ids first: the child tables hang off the session
    // rows, and the directory column may hold a different spelling of the
    // path than `project.worktree` does.
    for table in ["session", "session_v2"] {
        if !table_exists(&conn, table) {
            continue;
        }
        let cols = table_columns(&conn, table);
        let by_project = cols.iter().any(|c| c == "project_id");
        let by_dir = cols.iter().any(|c| c == "directory");
        if !by_project && !by_dir {
            continue;
        }
        let mut where_sql = String::new();
        if by_project {
            where_sql.push_str("project_id = ?1");
        }
        if by_dir {
            if !where_sql.is_empty() {
                where_sql.push_str(" OR ");
            }
            where_sql.push_str("lower(replace(directory, char(92), '/')) = lower(replace(?2, char(92), '/'))");
        }
        let mut ids: Vec<String> = Vec::new();
        {
            let mut stmt = match tx.prepare(&format!("SELECT id FROM {} WHERE {}", table, where_sql)) {
                Ok(s) => s,
                Err(e) => {
                    err = e.to_string();
                    break;
                }
            };
            let rows = stmt.query_map(rusqlite::params![pid, worktree], |r| r.get::<_, String>(0));
            if let Ok(it) = rows {
                for row in it.flatten() {
                    ids.push(row);
                }
            }
        }
        for sid in &ids {
            // part -> message -> session, session_message -> session_v2
            if table_exists(&conn, "part") {
                let _ = tx.execute("DELETE FROM part WHERE session_id = ?1", rusqlite::params![sid]);
            }
            if table_exists(&conn, "message") {
                let _ = tx.execute("DELETE FROM message WHERE session_id = ?1", rusqlite::params![sid]);
            }
            if table_exists(&conn, "session_message") {
                let _ = tx.execute("DELETE FROM session_message WHERE session_id = ?1", rusqlite::params![sid]);
            }
            let _ = tx.execute(&format!("DELETE FROM {} WHERE id = ?1", table), rusqlite::params![sid]);
            sessions += 1;
        }
    }
    if err.is_empty() {
        if let Err(e) = tx.execute("DELETE FROM project WHERE id = ?1", rusqlite::params![pid]) {
            err = e.to_string();
        }
    }
    if !err.is_empty() {
        let _ = tx.rollback();
        return json!({ "ok": false, "error": format!("删除失败：{}", err) });
    }
    if let Err(e) = tx.commit() {
        return json!({ "ok": false, "error": format!("提交失败：{}", e) });
    }
    json!({ "ok": true, "id": pid, "path": worktree, "sessions": sessions })
}

fn opencode_path_or(fallback: &str) -> String {
    locate_opencode()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| fallback.to_string())
}

pub fn rename_session(id: &str, title: &str) -> Value {
    let t = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return json!({ "ok": false, "error": "会话 ID 无效" });
    }
    if t.is_empty() {
        return json!({ "ok": false, "error": "标题不能为空" });
    }
    if t.chars().count() > 200 {
        return json!({ "ok": false, "error": "标题最多 200 个字符" });
    }
    let body = json!({ "title": t }).to_string();
    let oc = opencode_path_or("opencode");
    let out = run(
        &oc,
        &["api", "session.update", "--param", &format!("sessionID={}", id), "-d", &body],
    );
    let lowered = out.to_lowercase();
    if lowered.contains("usage") || lowered.contains("error") {
        // fall back to a direct write
        if let Ok(conn) = rusqlite::Connection::open(opencode_db_path()) {
            let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
            for table in ["session_v2", "session"] {
                if table_exists(&conn, table) {
                    let _ = conn.execute(&format!("UPDATE {} SET title=?1 WHERE id=?2", table), rusqlite::params![t, id]);
                }
            }
        }
    }
    json!({ "ok": true, "id": id, "title": t })
}

/* -------------------------------------------------------------------- git --- */

fn bracket_count(line: &str, prefix: &str) -> i64 {
    // "## main...origin/main [ahead 3, behind 2]" → 3 / 2
    let Some(start) = line.find('[') else { return 0 };
    let Some(end) = line[start..].find(']') else { return 0 };
    let inner = &line[start + 1..start + end];
    for part in inner.split(',') {
        let p = part.trim();
        if p.starts_with(prefix) {
            let num: String = p.chars().filter(|c| c.is_ascii_digit()).collect();
            return num.parse().unwrap_or(0);
        }
    }
    0
}

pub fn git_status(dir: &str) -> Value {
    let git = find_on_path("git")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "git".to_string());
    let out = run_status(&git, &["-C", dir, "status", "--porcelain=v1", "--branch", "-z"]);
    if !out.status.success() {
        return json!({ "ok": false, "isRepo": false, "reason": "不是 Git 仓库" });
    }
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    let (header, body) = match raw.split_once('\u{0}') {
        Some((h, b)) => (h.to_string(), b.to_string()),
        None => (raw.clone(), String::new()),
    };
    let branch_line = header.lines().find(|l| l.starts_with("## ")).unwrap_or("");
    let branch = branch_line
        .trim_start_matches("## ")
        .split("...")
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;
    let mut sample: Vec<Value> = Vec::new();
    for entry in body.split('\u{0}').filter(|s| !s.is_empty()) {
        let mut it = entry.chars();
        let x = it.next().unwrap_or(' ');
        let y = it.next().unwrap_or(' ');
        let name: String = entry.chars().skip(3).collect();
        if x == '?' && y == '?' {
            untracked += 1;
        } else {
            if x != ' ' {
                staged += 1;
            }
            if y != ' ' {
                unstaged += 1;
            }
        }
        if sample.len() < 8 {
            let status = if x == '?' && y == '?' { "?".to_string() } else { format!("{}{}", x, y) };
            sample.push(json!({ "name": name, "status": status }));
        }
    }
    json!({
        "ok": true, "isRepo": true, "branch": branch,
        "ahead": bracket_count(branch_line, "ahead"), "behind": bracket_count(branch_line, "behind"),
        "staged": staged, "unstaged": unstaged, "untracked": untracked,
        "clean": staged + unstaged + untracked == 0,
        "files": sample,
        "total": staged + unstaged + untracked,
    })
}

/* ------------------------------------------------------------------ cache --- */

fn size_of(p: &Path) -> u64 {
    let Ok(meta) = fs::metadata(p) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    let mut total = 0;
    if let Ok(rd) = fs::read_dir(p) {
        for e in rd.flatten() {
            total += size_of(&e.path());
        }
    }
    total
}

struct CacheKind {
    key: &'static str,
    name: &'static str,
    files: &'static [&'static str],
    dir: &'static str,
    clearable: bool,
    risky: bool,
    note: &'static str,
}

const CACHE_KINDS: &[CacheKind] = &[
    CacheKind { key: "db", name: "会话数据库", files: &["opencode.db"], dir: "", clearable: false, risky: false,
        note: "全部会话的 SQLite 数据库；删除请使用会话列表逐条删除" },
    CacheKind { key: "wal", name: "WAL 预写日志", files: &["opencode.db-wal", "opencode.db-shm"], dir: "", clearable: true, risky: true,
        note: "数据库的事务日志；opencode 未运行时可清理以回收空间" },
    CacheKind { key: "log", name: "运行日志", files: &[], dir: "log", clearable: true, risky: false,
        note: "opencode 的运行日志" },
    CacheKind { key: "repos", name: "仓库缓存", files: &[], dir: "repos", clearable: true, risky: false,
        note: "克隆的仓库缓存；清理后首次使用会重新克隆" },
    CacheKind { key: "shell", name: "Shell 历史", files: &[], dir: "shell", clearable: true, risky: false,
        note: "会话内的 shell 命令历史" },
    CacheKind { key: "tool", name: "工具输出", files: &[], dir: "tool-output", clearable: true, risky: false,
        note: "工具调用的输出缓存" },
];

pub fn cache_analyze() -> Value {
    let dir = opencode_data_dir();
    let running = !discover_sessions().is_empty();
    if !dir.exists() {
        return json!({ "ok": true, "path": dir.display().to_string(), "exists": false, "running": running, "items": [], "total": 0 });
    }
    let mut items: Vec<Value> = Vec::new();
    let mut total: u64 = 0;
    let mut known: Vec<String> = Vec::new();
    for k in CACHE_KINDS {
        let mut size: u64 = 0;
        let mut present = false;
        if !k.dir.is_empty() {
            let p = dir.join(k.dir);
            present = p.exists();
            size = size_of(&p);
            known.push(k.dir.to_string());
        }
        for f in k.files {
            let p = dir.join(f);
            if p.exists() {
                present = true;
                size += size_of(&p);
            }
            known.push((*f).to_string());
        }
        total += size;
        let clearable = k.clearable && present && (!k.risky || !running);
        items.push(json!({
            "key": k.key, "name": k.name, "note": k.note, "size": size, "present": present,
            "clearable": clearable, "risky": k.risky && present,
        }));
    }
    let mut other: u64 = 0;
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !known.iter().any(|k| k == &name) {
                other += size_of(&e.path());
            }
        }
    }
    if other > 0 {
        items.push(json!({ "key": "other", "name": "其他文件", "note": "未分类的文件", "size": other,
            "present": true, "clearable": false, "risky": false }));
        total += other;
    }
    json!({ "ok": true, "path": dir.display().to_string(), "exists": true, "running": running, "items": items, "total": total })
}

pub fn cache_clear(keys: &[String]) -> Value {
    let dir = opencode_data_dir();
    let running = !discover_sessions().is_empty();
    let mut cleared: Vec<String> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for k in CACHE_KINDS {
        if !keys.iter().any(|x| x == k.key) {
            continue;
        }
        if !k.clearable {
            skipped.push(json!({ "key": k.key, "reason": "该类别不支持清理" }));
            continue;
        }
        if k.risky && running {
            skipped.push(json!({ "key": k.key, "reason": "opencode 正在运行" }));
            continue;
        }
        if !k.dir.is_empty() {
            let p = dir.join(k.dir);
            if p.exists() && fs::remove_dir_all(&p).is_ok() {
                cleared.push(k.key.to_string());
            }
        }
        for f in k.files {
            let p = dir.join(f);
            if p.exists() && fs::remove_file(&p).is_ok() {
                cleared.push(k.key.to_string());
            }
        }
    }
    json!({ "ok": true, "cleared": cleared, "skipped": skipped })
}

/* ----------------------------------------------------------------- doctor --- */

pub fn doctor() -> Value {
    let mut checks: Vec<Value> = Vec::new();
    let oc = locate_opencode();
    let oc_path = oc.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    checks.push(json!({ "name": "opencode 可执行文件", "ok": oc.is_some(),
        "detail": if oc_path.is_empty() { "未在 PATH 中找到".to_string() } else { oc_path.clone() } }));

    let ver = installed_version();
    checks.push(json!({ "name": "opencode 版本", "ok": !ver.is_empty(),
        "detail": if ver.is_empty() { "无法读取版本".to_string() } else { format!("{}（{}）", ver, npm_pkg()) } }));

    let npm = resolve_npm();
    let npm_ok = find_on_path("npm").is_some();
    checks.push(json!({ "name": "npm", "ok": npm_ok, "detail": npm }));

    let wt = windows_terminal();
    checks.push(json!({ "name": "终端", "ok": true,
        "detail": wt.map(|p| format!("Windows Terminal ({})", p))
            .unwrap_or_else(|| "未检测到 Windows Terminal，将使用 cmd".to_string()) }));

    let cfg_dir = dirs_home().join(".config").join("opencode");
    let has_cfg = cfg_dir.join("opencode.json").exists() || cfg_dir.join("opencode.jsonc").exists();
    checks.push(json!({ "name": "opencode 配置目录", "ok": has_cfg,
        "detail": format!("{}{}", cfg_dir.display(), if has_cfg { "" } else { "（未找到配置文件）" }) }));

    // Does the local server answer? A 5xx while sending shows up here.
    let mut api_ok = false;
    let mut api_detail = "opencode 未安装".to_string();
    if oc.is_some() {
        let out = run(&opencode_path_or("opencode"), &["api", "session.list"]);
        let trimmed = out.trim();
        if trimmed.starts_with('[') || trimmed.starts_with('{') {
            api_ok = true;
            api_detail = "服务正常应答".to_string();
        } else {
            api_detail = trimmed.lines().next().unwrap_or("无响应").chars().take(180).collect();
        }
    }
    checks.push(json!({ "name": "opencode 服务", "ok": api_ok, "detail": api_detail }));

    let data = opencode_data_dir();
    checks.push(json!({ "name": "opencode 数据目录", "ok": data.exists(),
        "detail": format!("{}（日志在 {}）", data.display(), opencode_log_dir().display()) }));

    checks.push(json!({ "name": "运行环境", "ok": true,
        "detail": format!("Windows · Tauri WebView2 · {}", std::env::consts::ARCH) }));

    let text = checks
        .iter()
        .map(|c| {
            format!(
                "[{}] {}: {}",
                if c["ok"].as_bool().unwrap_or(false) { "OK" } else { "!!" },
                c["name"].as_str().unwrap_or(""),
                c["detail"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    log(&format!("doctor\n{}", text));
    let ok = checks.iter().all(|c| c["ok"].as_bool().unwrap_or(false));
    json!({ "ok": ok, "checks": checks, "text": text })
}

/* -------------------------------------------------------------- maintenance --- */

/// Download the compiled standalone build (no Node.js involved).
fn install_standalone(emit: &dyn Fn(&str)) -> Result<String, String> {
    let pkg = "@opencode/cli-windows-x64-baseline";
    emit(&format!("查询 {} 最新版本…\n", pkg));
    let meta = run("curl.exe", &["-sS", "-L", "--max-time", "60", &format!("https://registry.npmjs.org/{}/latest", pkg)]);
    let v: Value = serde_json::from_str(meta.trim()).map_err(|_| "无法读取 registry 元数据".to_string())?;
    let url = v["dist"]["tarball"].as_str().ok_or("该包没有可下载的 tarball")?.to_string();
    let ver = v["version"].as_str().unwrap_or("").to_string();
    let tmp = std::env::temp_dir().join(format!("opencode-{}.tgz", std::process::id()));
    emit(&format!("下载 opencode {}（独立程序，解压约 200MB）…\n", ver));
    let out = run_status("curl.exe", &["-sS", "-L", "--max-time", "900", "-o", &tmp.to_string_lossy(), &url]);
    if !out.status.success() {
        return Err(format!("下载失败：{}", String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("")));
    }
    let bin = dirs_home().join(".opencode").join("bin");
    fs::create_dir_all(&bin).map_err(|e| format!("无法创建目录：{}", e))?;
    let out = run_status(
        "tar.exe",
        &["-xzf", &tmp.to_string_lossy(), "-C", &bin.to_string_lossy(), "package/bin/opencode.exe"],
    );
    let _ = fs::remove_file(&tmp);
    if !out.status.success() {
        return Err("解压失败（需要 Windows 自带的 tar.exe）".into());
    }
    let extracted = bin.join("package").join("bin").join("opencode.exe");
    let dest = bin.join("opencode.exe");
    if extracted.exists() {
        let _ = fs::remove_file(&dest);
        fs::rename(&extracted, &dest).map_err(|e| format!("无法放置二进制：{}", e))?;
        let _ = fs::remove_dir_all(bin.join("package"));
    }
    let probe = run_status(&dest.to_string_lossy(), &["--version"]);
    if !probe.status.success() {
        return Err("下载的 opencode 无法运行".into());
    }
    emit(&format!("opencode {} 已安装到 {}\n", ver, dest.display()));
    Ok(ver)
}

pub fn install_opencode(emit: &dyn Fn(&str)) -> Value {
    let before = installed_version();
    let pkg = npm_pkg();
    let npm = resolve_npm();
    let npm_ok = find_on_path("npm").is_some();

    if npm_ok {
        emit(&format!("本机已装：{}\n", if before.is_empty() { "（未安装）" } else { &before }));
        for reg in ["", "https://registry.npmjs.org", "https://registry.npmmirror.com"] {
            let mut args: Vec<String> = vec!["install".into(), "-g".into(), format!("{}@latest", pkg)];
            if !reg.is_empty() {
                args.push(format!("--registry={}", reg));
            }
            emit(&format!("$ npm install -g {}@latest {}\n", pkg, if reg.is_empty() { "" } else { reg }));
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            let out = run_status(&npm, &refs);
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if !text.trim().is_empty() {
                emit(&text);
            }
            if out.status.success() {
                let v = installed_version();
                return json!({ "ok": true, "version": v, "pkg": pkg, "method": "npm", "registry": reg });
            }
            emit(&format!("该源失败（{}），换下一个源…\n", if reg.is_empty() { "默认" } else { reg }));
        }
        emit("npm 各源均未成功，改用独立版下载…\n");
    } else {
        emit("未检测到 npm，改用独立版下载（无需 Node.js）…\n");
    }

    match install_standalone(emit) {
        Ok(v) => json!({ "ok": true, "version": v, "pkg": "standalone", "method": "standalone" }),
        Err(e) => {
            log(&format!("install failed: {}", e));
            json!({ "ok": false, "error": format!("安装失败：{}", e) })
        }
    }
}

/// A copy `opencode uninstall` refused to classify — clear it by hand.
fn remove_leftover(oc_path: &str) -> Vec<String> {
    let p = PathBuf::from(oc_path);
    let prefix = p
        .ancestors()
        .find(|a| a.file_name().map(|n| n.eq_ignore_ascii_case("node_modules")).unwrap_or(false))
        .and_then(|a| a.parent())
        .map(|a| a.to_path_buf())
        .unwrap_or_else(|| p.parent().map(|x| x.to_path_buf()).unwrap_or_default());
    let mut removed = Vec::new();
    let pkg = prefix.join("node_modules").join("@opencode");
    if pkg.exists() && fs::remove_dir_all(&pkg).is_ok() {
        removed.push(pkg.display().to_string());
    }
    for f in ["opencode.cmd", "opencode2.cmd", "opencode", "opencode2"] {
        let target = prefix.join(f);
        if target.exists() && fs::remove_file(&target).is_ok() {
            removed.push(target.display().to_string());
        }
    }
    removed
}

pub fn uninstall_opencode(emit: &dyn Fn(&str)) -> Value {
    if locate_opencode().is_none() {
        return json!({ "ok": false, "error": "opencode 未安装" });
    }
    // Running sessions hold the binary.
    let running = discover_sessions();
    if !running.is_empty() {
        emit(&format!("先关闭正在运行的 {} 个 opencode 会话…\n", running.len()));
        kill_sessions();
    }
    let mut chunks: Vec<String> = Vec::new();
    for _ in 0..3 {
        let Some(oc) = locate_opencode() else { break };
        let out = run(&oc.to_string_lossy(), &["uninstall", "--force"]);
        let cleaned: String = out
            .lines()
            .filter(|l| !l.contains("batch file cannot be found") && !l.contains("找不到批处理文件"))
            .collect::<Vec<_>>()
            .join("\n");
        if !cleaned.trim().is_empty() {
            chunks.push(cleaned);
        }
    }
    if let Some(left) = locate_opencode() {
        let removed = remove_leftover(&left.to_string_lossy());
        if !removed.is_empty() {
            chunks.push(format!("已手动清理：\n{}", removed.join("\n")));
        }
    }
    let gone = locate_opencode().is_none();
    chunks.push(if gone { "opencode 已卸载".into() } else { "仍检测到 opencode".to_string() });
    emit(&(chunks.join("\n") + "\n"));
    json!({ "ok": gone, "stdout": chunks.join("\n"), "stderr": "" })
}

pub fn maintenance_status() -> Value {
    let current = installed_version();
    let pkg = npm_pkg();
    let npm = resolve_npm();
    let latest = if find_on_path("npm").is_some() {
        run(&npm, &["view", &pkg, "version"])
            .lines()
            .map(|l| l.trim().to_string())
            .find(|l| l.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
            .unwrap_or_default()
    } else {
        String::new()
    };
    json!({ "current": current, "latest": latest, "npm": npm, "pkg": pkg })
}

/* ----------------------------------------------------------------- cleanup --- */

/// Drop working files from earlier runs (same policy as the Electron build).
pub fn cleanup_run_scripts() {
    let dir = data_dir();
    let Ok(rd) = fs::read_dir(&dir) else { return };
    let hour = 60 * 60 * 1000u128;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(meta) = e.metadata() else { continue };
        let age = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let is_run = name.starts_with("run-") && name.ends_with(".cmd");
        let is_temp = (name.ends_with(".ps1") && (name.starts_with("panes-") || name.starts_with("install-")
            || name.starts_with("npmview-") || name.starts_with("live-") || name.starts_with("kill-")
            || name.starts_with("elevate-")))
            || name == "instance.json"
            || name == "setup-instance.json";
        if (is_run && age > 6 * hour) || (is_temp && age > hour) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/* ------------------------------------------------------------------- tests --- */

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an in-memory opencode-like database: `project`, `session`,
    /// `session_v2` and `session_message` tables.
    fn fixture_db() -> rusqlite::Connection {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE project (id TEXT, worktree TEXT, name TEXT, vcs TEXT,
                time_created INTEGER, time_updated INTEGER, time_active INTEGER, time_archived INTEGER);
             CREATE TABLE session (id TEXT, slug TEXT, directory TEXT, title TEXT, agent TEXT,
                model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
             CREATE TABLE session_v2 (id TEXT, slug TEXT, directory TEXT, title TEXT, agent TEXT,
                model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
             CREATE TABLE session_message (id TEXT, session_id TEXT);",
        )
        .unwrap();
        db.execute("INSERT INTO project VALUES ('p1','D:/a','alpha','git',1,10,10,NULL)", []).unwrap();
        db.execute("INSERT INTO project VALUES ('p2','d:/A','alpha-lower',NULL,1,5,5,NULL)", []).unwrap();
        db.execute("INSERT INTO project VALUES ('p3','G:/c','gamma',NULL,1,8,8,99)", []).unwrap();
        db.execute("INSERT INTO project VALUES ('p4','/','global',NULL,1,1,1,NULL)", []).unwrap();
        // Same session in both tables — the newer time_updated must win.
        db.execute(
            "INSERT INTO session VALUES ('s1','sl1','D:/a','old title',NULL,NULL,0,0,0,1,100,NULL)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO session_v2 VALUES ('s1','sl1','D:/a','new title',NULL,NULL,0,0,0,1,200,NULL)",
            [],
        )
        .unwrap();
        // A session in a folder the launcher never added, and one with no title.
        db.execute(
            "INSERT INTO session_v2 VALUES ('s2','sl2','G:/c',NULL,NULL,NULL,0,0,0,2,300,NULL)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO session_message (id, session_id) VALUES ('m1','s1'),('m2','s1'),('m3','s2')",
            [],
        )
        .unwrap();
        db
    }

    fn rows(conn: &rusqlite::Connection, sql: &str) -> Vec<serde_json::Map<String, Value>> {
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.column_count();
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut out = Vec::new();
        let mut rows = stmt.query([]).unwrap();
        while let Ok(Some(r)) = rows.next() {
            let mut m = serde_json::Map::new();
            for i in 0..n {
                let v: Value = match r.get_ref(i) {
                    Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                    Ok(rusqlite::types::ValueRef::Integer(v)) => json!(v),
                    Ok(rusqlite::types::ValueRef::Real(f)) => json!(f),
                    Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                    _ => Value::Null,
                };
                m.insert(names[i].clone(), v);
            }
            out.push(m);
        }
        out
    }

    #[test]
    fn path_key_is_case_and_separator_insensitive() {
        assert_eq!(path_key("D:/文件/A"), path_key("d:\\文件\\a\\"));
        assert_eq!(path_key("D:/x/"), path_key("D:/x"));
    }

    #[test]
    fn normalize_keeps_empty_title_and_parses_model() {
        let row: serde_json::Map<String, Value> = [
            ("id".into(), json!("s1")),
            ("slug".into(), json!("sl1")),
            ("directory".into(), json!("D:/a")),
            ("title".into(), json!("")),
            ("model".into(), json!("{\"id\":\"m1\",\"providerID\":\"opencode\"}")),
            ("time_updated".into(), json!(42)),
        ]
        .into_iter()
        .collect();
        let n = normalize(&row);
        assert_eq!(n["title"], json!(""));
        assert_eq!(n["slug"], json!("sl1"));
        assert_eq!(n["model"], json!("m1"));
        assert_eq!(n["updated"].as_f64(), Some(42.0));
    }

    #[test]
    fn session_rows_merges_both_tables_and_counts_messages() {
        let db = fixture_db();
        let mut merged: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        for table in ["session", "session_v2"] {
            let Some(rs) = session_rows(&db, table) else { continue };
            for r in rs {
                let n = normalize(&r);
                let id = n["id"].as_str().unwrap().to_string();
                let newer = match merged.get(&id) {
                    Some(prev) => num(n.get("updated").unwrap()) >= num(prev.get("updated").unwrap()),
                    None => true,
                };
                if newer {
                    merged.insert(id, n);
                }
            }
        }
        assert_eq!(merged.len(), 2, "两个会话应合并为两个");
        let s1 = merged.get("s1").unwrap();
        assert_eq!(s1["title"], json!("new title"), "同 id 取 time_updated 较新的一行");
        assert_eq!(s1["messages"].as_f64(), Some(2.0));
        let s2 = merged.get("s2").unwrap();
        assert_eq!(s2["title"], json!(""), "无标题会话保持空");
        assert_eq!(s2["messages"].as_f64(), Some(1.0));
    }

    #[test]
    fn project_table_is_deduped_and_excludes_global() {
        let db = fixture_db();
        let mut by_key: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        for p in rows(&db, "SELECT id, worktree, name, vcs, time_updated, time_archived FROM project") {
            let worktree = p.get("worktree").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if worktree.is_empty() || worktree == "/" {
                continue;
            }
            by_key.insert(path_key(&worktree), json!({ "path": worktree }));
        }
        assert_eq!(by_key.len(), 2, "D:/a 与 d:/A 应合并，global 应排除");
    }

    #[test]
    fn session_filtering_uses_path_key() {
        let db = fixture_db();
        let rs = session_rows(&db, "session_v2").unwrap();
        let key = path_key("D:/a");
        let hits: Vec<String> = rs
            .iter()
            .map(|r| normalize(r))
            .filter(|n| path_key(n.get("directory").and_then(|v| v.as_str()).unwrap_or("")) == key)
            .map(|n| n["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(hits, vec!["s1".to_string()]);
    }

    #[test]
    fn build_args_for_v2_uses_session_flag() {
        let opts = json!({ "session": "ses_1", "auto": true, "model": "x" });
        let args = build_args(&opts, 2);
        assert!(args.contains(&"--session".to_string()));
        assert!(args.contains(&"ses_1".to_string()));
        assert!(args.contains(&"--auto".to_string()));
        assert!(!args.contains(&"--model".to_string()), "v2 没有 --model");
    }

    #[test]
    fn build_args_for_v1_keeps_model() {
        let opts = json!({ "model": "m", "agent": "build" });
        let args = build_args(&opts, 1);
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"--agent".to_string()));
    }

    /// A project row on disk, so `delete_project_at` can be exercised for real.
    fn delete_fixture_db(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("opencode.db");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE project (id TEXT, worktree TEXT, name TEXT, vcs TEXT,
                time_created INTEGER, time_updated INTEGER, time_active INTEGER, time_archived INTEGER);
             CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT,
                time_created INTEGER, time_updated INTEGER);
             CREATE TABLE session_v2 (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT,
                time_created INTEGER, time_updated INTEGER);
             CREATE TABLE session_message (id TEXT, session_id TEXT);
             CREATE TABLE message (id TEXT, session_id TEXT);
             CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT);",
        )
        .unwrap();
        db.execute("INSERT INTO project VALUES ('p1','D:/a','alpha',NULL,1,10,10,99)", []).unwrap();
        db.execute("INSERT INTO project VALUES ('p2','G:/c','gamma',NULL,1,8,8,NULL)", []).unwrap();
        db.execute("INSERT INTO project VALUES ('pg','/','global',NULL,1,1,1,NULL)", []).unwrap();
        db.execute("INSERT INTO session VALUES ('s1','p1','D:/a','t',NULL,1,100)", []).unwrap();
        db.execute("INSERT INTO session_v2 VALUES ('s2','p1','D:/a','t2',NULL,1,200)", []).unwrap();
        db.execute("INSERT INTO session_v2 VALUES ('s3','p2','G:/c','t3',NULL,1,300)", []).unwrap();
        db.execute("INSERT INTO session_message VALUES ('m1','s1'),('m2','s2')", []).unwrap();
        db.execute("INSERT INTO message VALUES ('m3','s1')", []).unwrap();
        db.execute("INSERT INTO part VALUES ('pt1','m3','s1')", []).unwrap();
        let _ = db.close();
        path
    }

    #[test]
    fn delete_project_removes_row_and_its_sessions() {
        let dir = std::env::temp_dir().join(format!("oc-del-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = delete_fixture_db(&dir);
        let r = delete_project_at(&path, "p1");
        assert_eq!(r["ok"], json!(true), "删除应成功: {}", r);
        assert_eq!(r["sessions"], json!(2), "p1 名下 2 个会话应被删除");
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM project WHERE id='p1'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.query_row("SELECT count(*) FROM project", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        assert_eq!(db.query_row("SELECT count(*) FROM session_v2 WHERE id='s2'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.query_row("SELECT count(*) FROM session_message WHERE session_id='s1'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.query_row("SELECT count(*) FROM part", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        // The other project keeps its session.
        assert_eq!(db.query_row("SELECT count(*) FROM session_v2 WHERE id='s3'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        let _ = db.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The session store has to be repaired the way the web client expects:
    /// ownership re-derived from the directory, duplicate project rows merged,
    /// and legacy sessions copied into the v2 table.
    #[test]
    fn session_store_sync_fixes_ownership_and_migrates_legacy_rows() {
        let dir = std::env::temp_dir().join(format!("oc-sync-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("opencode.db");
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE project (id TEXT, worktree TEXT, name TEXT, vcs TEXT,
                    time_created INTEGER, time_updated INTEGER, time_active INTEGER, time_archived INTEGER);
                 CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT,
                    time_created INTEGER, time_updated INTEGER);
                 CREATE TABLE session_v2 (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT,
                    time_created INTEGER, time_updated INTEGER, time_suspended INTEGER, resume_attempts INTEGER);
                 CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
                    time_created INTEGER, time_updated INTEGER, data TEXT);
                 CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
                 CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
            )
            .unwrap();
            // Same folder twice, different letter case.
            db.execute("INSERT INTO project VALUES ('pA','D:/proj','proj',NULL,1,10,10,NULL)", []).unwrap();
            db.execute("INSERT INTO project VALUES ('pB','d:/PROJ','proj',NULL,1,20,20,NULL)", []).unwrap();
            db.execute("INSERT INTO project VALUES ('pG','/','global',NULL,1,1,1,NULL)", []).unwrap();
            // A session that is owned by "global" although its directory is known.
            db.execute("INSERT INTO session_v2 VALUES ('s1','global','D:/proj','t','sl',1,100,NULL,0)", []).unwrap();
            // A legacy session that only exists in the old table.
            db.execute("INSERT INTO session VALUES ('s2','global','D:/proj','old','sl',1,50)", []).unwrap();
            // The JSON payload is bound, not inlined: SQLite reads a double
            // quote inside a string literal as an identifier quote.
            db.execute(
                "INSERT INTO message VALUES ('m1','s2',10,11,?1)",
                [r#"{"role":"user"}"#],
            )
            .unwrap();
            db.execute(
                "INSERT INTO part VALUES ('pt1','m1','s2',10,?1)",
                [r#"{"type":"text","text":"hello"}"#],
            )
            .unwrap();
            db.close();
        }
        // Point the sync at this fixture.
        let out = sync_opencode_sessions_at(&path);
        assert_eq!(out["ok"], json!(true), "{}", out);
        assert_eq!(out["projectsMerged"], json!(1), "重复的 project 行应被合并");
        // Both tables carry the session, so both rows are re-attached.
        assert_eq!(out["reattached"], json!(2), "会话归属应按目录修正");
        assert_eq!(out["migrated"], json!(1), "旧会话应补进 session_v2");
        assert_eq!(out["messages"], json!(1), "旧消息应转成 session_message");
        let db = rusqlite::Connection::open(&path).unwrap();
        let owner: String = db
            .query_row("SELECT project_id FROM session_v2 WHERE id='s1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(owner, "pB", "s1 应归属到 D:/proj 对应的 project 行");
        let global: i64 = db
            .query_row("SELECT count(*) FROM project WHERE worktree='/'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(global, 1, "global 项目必须保留");
        let msg: String = db
            .query_row("SELECT data FROM session_message WHERE session_id='s2'", [], |r| r.get(0))
            .unwrap();
        assert!(msg.contains("hello"), "迁移后的消息应保留文本: {}", msg);
        let _ = db.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Paths with non-ASCII characters and spaces have to survive being put
    /// into a query string — this runs on other people's machines, with other
    /// people's folder names.
    #[test]
    fn query_encode_handles_non_ascii_and_spaces() {
        assert_eq!(query_encode("D:/a"), "D%3A%2Fa");
        assert_eq!(query_encode("D:/tmp/oc"), "D%3A%2Ftmp%2Foc");
        let enc = query_encode("D:/中文 空格");
        assert!(enc.starts_with("D%3A%2F%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC"), "{}", enc);
        assert!(!enc.contains(' '), "空格必须被编码: {}", enc);
    }

    /// The pairing link has to be picked out of `opencode pair` output, and
    /// the plain service address must never be mistaken for one.
    #[test]
    fn pairing_link_is_picked_out_of_pair_output() {
        let out = "  Open a link to connect. Links work once and expire in 5 minutes.

  http://127.0.0.1:45278/auth/connect/D5ARwOvLniyxCrOZHhHwzg

  Over SSH? Forward the port, then open the link on your machine:
  ssh -L 45278:127.0.0.1:45278 <host>";
        let link = out
            .lines()
            .map(|l| l.trim())
            .find(|l| (l.starts_with("http://") || l.starts_with("https://")) && l.contains("/auth/connect/"));
        assert_eq!(
            link,
            Some("http://127.0.0.1:45278/auth/connect/D5ARwOvLniyxCrOZHhHwzg")
        );
        // The service address on its own is not a pairing link.
        let bare = "http://127.0.0.1:45278";
        assert!(!(bare.contains("/auth/connect/")));
    }

    #[test]
    fn delete_project_refuses_global_and_unknown_ids() {        let dir = std::env::temp_dir().join(format!("oc-del2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = delete_fixture_db(&dir);
        assert_eq!(delete_project_at(&path, "pg")["ok"], json!(false), "全局项目不可删除");
        assert_eq!(delete_project_at(&path, "nope")["ok"], json!(false), "不存在的项目应报错");
        assert_eq!(delete_project_at(&path, "../etc")["ok"], json!(false), "非法 ID 应被拒绝");
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM project", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        let _ = db.close();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
