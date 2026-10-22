//! Tauri command surface — same channels the Electron build exposed, so the
//! renderer keeps working with a one-line bridge instead of a rewrite.
//!
//! Payload contract: the bridge sends the renderer's payload as the `p`
//! argument verbatim, and payloads here mirror app.js call sites exactly —
//! most channels pass a bare string/array, only launch/rename/prefs/… pass
//! objects.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn as_str(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn arg_string(p: &Value) -> String {
    p.as_str().unwrap_or("").to_string()
}

/* ------------------------------------------------------------------ state --- */

#[tauri::command]
fn state_get() -> Value {
    let cfg = core::read_config();
    let recent = core::recent_project(&cfg);
    let oc = core::locate_opencode();
    let version = core::installed_version();
    let major = core::opencode_major();
    let running = !core::discover_sessions().is_empty();
    json!({
        "app": {
            "version": core::BUILD,
            "electron": "Tauri/WebView2",
            "node": "-",
            "theme": "system",
            "isDev": false,
        },
        "paths": {
            "dataDir": core::data_dir().display().to_string(),
            "config": core::config_path().display().to_string(),
            "log": core::log_path().display().to_string(),
            "db": core::opencode_db_path().display().to_string(),
            "ocLog": core::opencode_log_dir().display().to_string(),
        },
        "config": cfg,
        "recentProject": recent,
        "opencode": {
            "found": oc.is_some(),
            "path": oc.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            "current": version,
            "major": major,
            "npmPkg": core::npm_pkg(),
            "npm": core::resolve_npm(),
            "running": running,
        },
        "terminals": { "wt": true },
    })
}

#[tauri::command]
fn prefs_save(p: Value) -> Value {
    let mut cfg = core::read_config();
    let mut prefs = cfg.prefs.clone();
    if let (Some(src), Some(dst)) = (p.as_object(), prefs.as_object_mut()) {
        for (k, v) in src {
            if k == "session" || k == "continueSession" {
                continue;
            }
            dst.insert(k.clone(), v.clone());
        }
    }
    cfg.prefs = prefs;
    core::write_config(&cfg);
    json!({ "ok": true })
}

#[tauri::command]
fn path_open(app: AppHandle, p: Value) -> Value {
    let target = arg_string(&p);
    if target.is_empty() {
        return json!({ "ok": false, "error": "路径为空" });
    }
    match app.opener().open_path(target.clone(), None::<&str>) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/* --------------------------------------------------------------- projects --- */

#[tauri::command]
fn project_pick(app: AppHandle, p: Value) -> Value {
    let passed = arg_string(&p);
    let start = if passed.is_empty() { core::read_config().last_project } else { passed };
    let picked = app
        .dialog()
        .file()
        .set_title("选择 opencode 项目目录")
        .set_directory(start)
        .blocking_pick_folder();
    let Some(picked) = picked else {
        return json!({ "ok": false, "cancelled": true });
    };
    let dir = picked
        .into_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut cfg = core::read_config();
    if !cfg.projects.iter().any(|x| core::path_key(&x.path) == core::path_key(&dir)) {
        let name = std::path::Path::new(&dir)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.clone());
        cfg.projects.insert(0, core::Project { path: dir.clone(), name, added_at: core::now_ms() as u64 });
    }
    cfg.last_project = dir.clone();
    core::write_config(&cfg);
    json!({ "ok": true, "dir": dir, "marker": is_project_dir(&dir), "config": cfg })
}

fn is_project_dir(dir: &str) -> String {
    const MARKERS: [&str; 10] = [
        "opencode.json", "opencode.jsonc", "AGENTS.md", ".git", "package.json",
        "go.mod", "pyproject.toml", "Cargo.toml", "pom.xml", "requirements.txt",
    ];
    for m in MARKERS {
        if std::path::Path::new(dir).join(m).exists() {
            return m.to_string();
        }
    }
    String::new()
}

#[tauri::command]
async fn project_add(p: Value) -> Value {
    let dir = arg_string(&p);
    if dir.trim().is_empty() {
        return json!({ "ok": false, "error": "请填写项目目录" });
    }
    if !std::path::Path::new(&dir).is_dir() {
        return json!({ "ok": false, "error": format!("目录不存在：{}", dir) });
    }
    let mut cfg = core::read_config();
    if !cfg.projects.iter().any(|x| core::path_key(&x.path) == core::path_key(&dir)) {
        let name = std::path::Path::new(&dir)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.clone());
        cfg.projects.insert(0, core::Project { path: dir.clone(), name, added_at: core::now_ms() as u64 });
    }
    cfg.last_project = dir.clone();
    core::write_config(&cfg);
    // Register right away so the web UI and the terminal see it without waiting
    // for the next reconciliation pass.
    core::ensure_service_project(&dir);
    json!({ "ok": true, "config": cfg })
}

#[tauri::command]
async fn project_remove(p: Value) -> Value {
    let dir = arg_string(&p);
    let mut cfg = core::read_config();
    cfg.projects.retain(|x| core::path_key(&x.path) != core::path_key(&dir));
    if cfg.projects.is_empty() {
        cfg.last_project = String::new();
    } else if core::path_key(&cfg.last_project) == core::path_key(&dir) {
        cfg.last_project = cfg.projects[0].path.clone();
    }
    core::write_config(&cfg);
    // Drop the service-side row too, otherwise the next reconciliation would see
    // a project the service still knows and add it straight back. This also
    // removes that project's sessions, which is what deleting a project means
    // everywhere else in opencode.
    let svc = core::delete_service_project_by_path(&dir);
    json!({
        "ok": true,
        "config": cfg,
        "serviceRemoved": svc.get("removed").cloned().unwrap_or(json!(false)),
    })
}

#[tauri::command]
async fn projects_sync() -> Value {
    core::sync_project_registry()
}

/// Manual refresh: reconcile with opencode, drop every cached session list, and
/// let the renderer repaint both the project view and the records view.
#[tauri::command]
async fn app_refresh() -> Value {
    let sync = core::sync_project_registry();
    json!({ "ok": true, "sync": sync })
}

#[tauri::command]
fn project_select(p: Value) -> Value {
    let dir = arg_string(&p);
    let mut cfg = core::read_config();
    cfg.last_project = dir.clone();
    core::write_config(&cfg);
    json!({
        "ok": true, "dir": dir.clone(), "marker": is_project_dir(&dir),
        "git": core::git_status(&dir),
        "sessions": core::list_sessions(&dir),
        "config": cfg,
    })
}

#[tauri::command]
fn project_git(p: Value) -> Value {
    core::git_status(&arg_string(&p))
}

/* -------------------------------------------------------- launch / kill --- */

#[tauri::command]
fn launch(p: Value) -> Value {
    let v = p;
    let dir = {
        let d = as_str(&v, "dir");
        if d.is_empty() { core::read_config().last_project } else { d }
    };
    // No project picked means "open the default": the last project, or the home
    // directory when there is none yet.
    let dir = if dir.is_empty() {
        std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string())
    } else {
        dir
    };
    let opts = v.get("opts").cloned().unwrap_or(json!({}));
    let terminal = {
        let t = as_str(&v, "terminal");
        if t.is_empty() {
            core::read_config()
                .prefs
                .get("terminal")
                .and_then(|x| x.as_str())
                .unwrap_or("auto")
                .to_string()
        } else {
            t
        }
    };
    let mut r = core::launch(&dir, &terminal, &opts);
    if r["ok"] == json!(true) {
        let mut cfg = core::read_config();
        cfg.last_project = dir.clone();
        core::write_config(&cfg);
    }
    r["dir"] = json!(dir);
    r
}

#[tauri::command]
async fn kill(app: AppHandle) -> Value {
    let mut r = core::kill_sessions();
    // "Close opencode" means everything it opened: every terminal pane the
    // launcher spawned, and the built-in web window. Leaving that window alive
    // would show a dead app the moment the service goes away.
    let mut web = false;
    if let Some(w) = app.get_webview_window("opencode-web") {
        let _ = w.destroy();
        web = true;
    }
    if let Some(obj) = r.as_object_mut() {
        obj.insert("web".to_string(), json!(web));
    }
    r
}

#[tauri::command]
fn running_count(app: AppHandle) -> Value {
    let list: Vec<Value> = core::discover_sessions()
        .into_iter()
        .map(|s| json!({ "script": s.script, "pids": [s.pane_pid], "windowPid": s.window_pid }))
        .collect();
    // An open window is not a running service: if opencode died while the
    // window stayed open, the page can only show "Failed to fetch".
    let web_win = app.get_webview_window("opencode-web").is_some();
    let web = web_win && core::web_alive();
    json!({
        "count": list.len() + usize::from(web),
        "sessions": list,
        "web": web,
        "webWin": web_win,
    })
}

/* --------------------------------------------------------------- sessions --- */

#[tauri::command]
fn sessions_list(p: Value) -> Value {
    let passed = arg_string(&p);
    let dir = if passed.is_empty() { core::read_config().last_project } else { passed };
    core::list_sessions(&dir)
}

#[tauri::command]
fn sessions_delete(p: Value) -> Value {
    core::delete_session(&arg_string(&p))
}

#[tauri::command]
fn sessions_rename(p: Value) -> Value {
    core::rename_session(&as_str(&p, "id"), &as_str(&p, "title"))
}

/* --------------------------------------------------------- all records --- */

/// Every project opencode itself recorded — the launcher's own project list
/// only contains folders the user added by hand, which is why the TUI showed
/// sessions the launcher never listed.
#[tauri::command]
fn projects_scanned() -> Value {
    core::list_scanned_projects()
}

/// Every session opencode has, across all directories.
#[tauri::command]
fn sessions_all() -> Value {
    core::list_all_sessions()
}

/// Remove a project record from opencode's own database.
#[tauri::command]
fn project_delete(p: Value) -> Value {
    core::delete_project(&arg_string(&p))
}

/* ------------------------------------------------------------------- web --- */

#[tauri::command]
fn web_status() -> Value {
    core::web_status()
}

#[tauri::command]
fn web_start(app: AppHandle) -> Value {
    let r = core::web_start();
    if r["ok"] == json!(true) {
        let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !url.is_empty() {
            let _ = app.opener().open_url(url, None::<&str>);
        }
    }
    r
}

/// Open the web UI in the default browser, starting the service if needed.
///
/// The URL that is opened is the one-time pairing link, not the bare service
/// address: the service is password protected, so the bare address only
/// serves the page shell while every API call behind it answers 401.
#[tauri::command]
fn web_open(app: AppHandle) -> Value {
    let r = core::web_open_url();
    if r["ok"] != json!(true) {
        return r;
    }
    let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if url.is_empty() {
        return json!({ "ok": false, "error": "未能获取 opencode Web 地址" });
    }
    match app.opener().open_url(url.clone(), None::<&str>) {
        Ok(()) => json!({ "ok": true, "url": url }),
        Err(e) => json!({ "ok": false, "error": e.to_string(), "url": url }),
    }
}

/// Register a directory with the opencode service, then open the web UI.
#[tauri::command]
fn web_open_project(p: Value) -> Value {
    core::web_open_project(&arg_string(&p))
}

/// Register every project in the launcher's library, then open the web UI.
#[tauri::command]
fn web_sync(app: AppHandle) -> Value {
    let r = core::web_sync_projects();
    if r["ok"] == json!(true) {
        if let Some(url) = r
            .get("open")
            .and_then(|v| v.get("url"))
            .and_then(|v| v.as_str())
        {
            let _ = app.opener().open_url(url.to_string(), None::<&str>);
        }
    }
    r
}

/* ------------------------------------------------- built-in web window --- */

/// Open the web UI in a built-in window with the workspace panel in sync.
///
/// The panel is backed by browser localStorage rather than the server's
/// project table, so the list has to be written from inside the page — the
/// seed script does that and reloads once when anything moved. A second click
/// reuses the window instead of paying for another renderer.
// Async on purpose: a sync command blocks the main thread, and building a
// window from there deadlocks the event loop.
#[tauri::command]
async fn web_open_app(app: AppHandle) -> Value {
    let r = core::web_open_url();
    if r["ok"] != json!(true) {
        return r;
    }
    let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if url.is_empty() {
        return json!({ "ok": false, "error": "未能获取 opencode Web 地址" });
    }

    if let Some(w) = app.get_webview_window("opencode-web") {
        let dirs = core::web_seed_dirs();
        let started = r.get("started").and_then(|v| v.as_bool()).unwrap_or(false);
        if started {
            // The service had been down, so this page is a dead shell — reload
            // it, then top up the project list once the new page is ready.
            let script = core::web_seed_script(&dirs);
            let _ = w.eval(&format!(
                "location.reload(); setTimeout(function(){{ {} }}, 1500);",
                script
            ));
        } else {
            let _ = w.eval(&core::web_seed_script(&dirs));
        }
        let _ = w.show();
        let _ = w.set_focus();
        return json!({
            "ok": true,
            "reused": true,
            "created": false,
            "projects": dirs.len(),
        });
    }

    // Register library folders first so projects the service has never seen
    // still appear in both the settings page and the workspace panel.
    let reg = core::web_register_library();
    let dirs = core::web_seed_dirs();
    let script = core::web_seed_script(&dirs);

    let parsed = match tauri::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };

    // Seed once: the reload triggered by the script loads the page again.
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done_in = done.clone();
    let built = tauri::WebviewWindowBuilder::new(
        &app,
        "opencode-web",
        tauri::WebviewUrl::External(parsed),
    )
    .title("opencode Web")
    .inner_size(1280.0, 900.0)
    .min_inner_size(920.0, 620.0)
    .on_page_load(move |webview, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished {
            return;
        }
        // The pairing link redirects into the app — wait for the real page.
        if payload.url().as_str().contains("/auth/connect/") {
            return;
        }
        if done_in.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let _ = webview.eval(&script);
    })
    .build();

    match built {
        Ok(_) => json!({
            "ok": true,
            "created": true,
            "url": url,
            "projects": dirs.len(),
            "registered": reg.get("ok").cloned().unwrap_or(json!(0)),
            "started": r.get("started").cloned().unwrap_or(json!(false)),
        }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Script body for the one-click bookmarklet used with a normal browser.
#[tauri::command]
fn web_bookmarklet() -> Value {
    let body = core::web_bookmarklet_body();
    if body.is_empty() {
        return json!({ "ok": false, "error": "无法生成同步书签" });
    }
    json!({ "ok": true, "body": body })
}

/* ------------------------------------------------------------ maintenance --- */

#[tauri::command]
fn maintenance_status() -> Value {
    core::maintenance_status()
}

#[tauri::command]
fn maintenance_install(app: AppHandle) -> Value {
    let handle = app.clone();
    core::install_opencode(&move |text| {
        let _ = handle.emit("install-line", text);
    })
}

#[tauri::command]
fn maintenance_uninstall(app: AppHandle) -> Value {
    let handle = app.clone();
    core::uninstall_opencode(&move |text| {
        let _ = handle.emit("install-line", text);
    })
}

#[tauri::command]
fn maintenance_uninstall_app(app: AppHandle) -> Value {
    // NSIS uninstaller sits next to the executable.
    let dir = std::path::Path::new(&std::env::current_exe().unwrap_or_default())
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let Some(entry) = std::fs::read_dir(&dir)
        .ok()
        .and_then(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .find(|n| n.to_lowercase().starts_with("uninstall") && n.to_lowercase().ends_with(".exe"))
        })
    else {
        return json!({ "ok": false, "error": "未找到卸载程序（绿色运行模式无法卸载）" });
    };
    let path = dir.join(entry);
    let _ = std::process::Command::new(path).arg("/currentuser").spawn();
    app.exit(0);
    json!({ "ok": true })
}

#[tauri::command]
fn cache_analyze() -> Value {
    core::cache_analyze()
}

#[tauri::command]
fn cache_clear(p: Value) -> Value {
    let keys: Vec<String> = p
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    core::cache_clear(&keys)
}

#[tauri::command]
fn log_read() -> Value {
    let p = core::log_path();
    match std::fs::read_to_string(&p) {
        Ok(text) => json!({ "ok": true, "path": p.display().to_string(), "text": text }),
        Err(e) => json!({ "ok": false, "path": p.display().to_string(), "text": "", "error": e.to_string() }),
    }
}

#[tauri::command]
fn doctor() -> Value {
    core::doctor()
}

/* ---------------------------------------------------------------- updater --- */

#[tauri::command]
fn updater_check(p: Value) -> Value {
    let force = p.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    core::update_check(force)
}

#[tauri::command]
fn updater_download() -> Value {
    match core::update_download() {
        Ok(path) => json!({ "ok": true, "path": path.to_string_lossy() }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
fn updater_install(app: AppHandle) -> Value {
    // The installer path is re-derived from the fixed temp location — it is
    // never accepted from the renderer.
    let path = core::update_setup_path();
    if !path.is_file() {
        return json!({ "ok": false, "error": "安装包不存在，请先下载" });
    }
    if let Err(e) = core::update_install_ready() {
        return json!({ "ok": false, "error": e });
    }
    core::log(&format!("update: launching installer {}", path.display()));
    let _ = std::process::Command::new(&path).spawn();
    app.exit(0);
    json!({ "ok": true })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            core::cleanup_run_scripts();
            core::log(&format!("app start version={} (tauri)", core::BUILD));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state_get, prefs_save, path_open,
            project_pick, project_add, project_remove, project_select, project_git, projects_sync,
            launch, kill, running_count,
            sessions_list, sessions_delete, sessions_rename,
            projects_scanned, sessions_all, project_delete, app_refresh,
            web_status, web_start, web_open, web_open_project, web_sync,
            web_open_app, web_bookmarklet,
            maintenance_status, maintenance_install, maintenance_uninstall, maintenance_uninstall_app,
            cache_analyze, cache_clear, log_read, doctor,
            updater_check, updater_download, updater_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
