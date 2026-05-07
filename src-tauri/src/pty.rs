// PTY layer - wraps portable-pty handles for the Tauri frontend.
//
// Each pty is assigned a stable string ID by the frontend (typically the agent
// code, e.g. "CEO", "QA"). The frontend invokes `pty_spawn` to start a
// process, `pty_write` to send stdin, `pty_resize` to forward TIOCSWINSZ on
// xterm resize, and `pty_kill` on tab close. Stdout is streamed back to the
// frontend via Tauri events on the channel `pty://output/<id>`.

use crate::store;
use anyhow::Result;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use tauri::{Emitter, State};

// Augmented PATH that mirrors what the user's login shell would have. Cached
// once on first read since spawning a login shell is ~50-200 ms. Same fix
// idea as resolve_command_path but for child processes claude itself spawns
// (MCP servers via npx, the native installer's helper at ~/.local/bin, etc.)
// - they all need PATH inherited via the pty's env, not the .app's minimal
// PATH from launchd.
static LOGIN_SHELL_PATH: Lazy<String> = Lazy::new(|| {
    let home = crate::store::home_dir().to_string_lossy().to_string();
    let mut dirs: Vec<String> = vec![
        "/usr/local/bin".into(),
        "/opt/homebrew/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
        "/usr/sbin".into(),
        "/sbin".into(),
        format!("{home}/.npm-global/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/Library/pnpm"),
        format!("{home}/.volta/bin"),
        format!("{home}/.cargo/bin"),
    ];
    // Ask the login shell what it actually has; merges any user-customised
    // PATH from .zshrc / .bashrc that we wouldn't know about.
    if let Ok(shell) = std::env::var("SHELL") {
        if let Ok(out) = std::process::Command::new(&shell)
            .args(["-lc", "echo $PATH"]).output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                for entry in s.split(':') {
                    if !entry.is_empty() && !dirs.iter().any(|d| d == entry) {
                        dirs.push(entry.to_string());
                    }
                }
            }
        }
    }
    // Whatever the .app inherited from launchd - keep it, last priority.
    if let Ok(existing) = std::env::var("PATH") {
        for entry in existing.split(':') {
            if !entry.is_empty() && !dirs.iter().any(|d| d == entry) {
                dirs.push(entry.to_string());
            }
        }
    }
    dirs.join(":")
});

// Resolve `claude` (or any other binary installed via npm/brew/bun/volta) when
// the .app is launched from Finder. macOS gives Finder-launched apps a minimal
// PATH; the user's shell PATH (~/.zshrc etc.) is not applied. Strategy:
//   1. Absolute path? Trust it.
//   2. Search common install locations.
//   3. Ask the user's login shell via `<shell> -lc 'which <cmd>'`.
//   4. Fall through with the bare name (lets portable-pty try its own PATH).
pub fn resolve_command_path(command: &str) -> String {
    if command.starts_with('/') { return command.to_string(); }
    let home = crate::store::home_dir().to_string_lossy().to_string();
    let candidates: Vec<PathBuf> = vec![
        PathBuf::from("/usr/local/bin").join(command),
        PathBuf::from("/opt/homebrew/bin").join(command),
        PathBuf::from(&home).join(".npm-global/bin").join(command),
        PathBuf::from(&home).join(".local/bin").join(command),
        PathBuf::from(&home).join(".bun/bin").join(command),
        PathBuf::from(&home).join("Library/pnpm").join(command),
        PathBuf::from(&home).join(".volta/bin").join(command),
        PathBuf::from(&home).join(".cargo/bin").join(command),
    ];
    for p in &candidates {
        if p.exists() { return p.to_string_lossy().into_owned(); }
    }
    if let Ok(shell) = std::env::var("SHELL") {
        if let Ok(out) = std::process::Command::new(&shell)
            .args(["-lc", &format!("which {}", command)]).output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() && PathBuf::from(&s).exists() {
                    return s;
                }
            }
        }
    }
    command.to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClaudeStatus { pub found: bool, pub path: String }

#[tauri::command]
pub fn claude_status() -> ClaudeStatus {
    let path = resolve_command_path("claude");
    let found = path.starts_with('/') && std::path::Path::new(&path).exists();
    ClaudeStatus { found, path }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SpawnArgs {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PtySummary {
    pub id: String,
    pub command: String,
    pub started_at: String,
    pub alive: bool,
}

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    summary: PtySummary,
}

pub struct PtyRegistry {
    inner: Arc<Mutex<HashMap<String, PtyHandle>>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub fn pty_spawn(
    args: SpawnArgs,
    registry: State<'_, PtyRegistry>,
    app: tauri::AppHandle,
) -> Result<PtySummary, String> {
    spawn_inner(args, registry.inner.clone(), app).map_err(|e| e.to_string())
}

fn spawn_inner(
    args: SpawnArgs,
    registry: Arc<Mutex<HashMap<String, PtyHandle>>>,
    app: tauri::AppHandle,
) -> Result<PtySummary> {
    // If a pty with this id is already registered (typically because the
    // frontend reloaded - vite HMR - but the Rust side kept the prior child
    // alive), drop the old one first so the new spawn can take over cleanly.
    if registry.lock().remove(&args.id).is_some() {
        log::info!("dropping stale pty `{}` before respawn", args.id);
    }

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: args.rows,
        cols: args.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let resolved = resolve_command_path(&args.command);
    let mut cmd = CommandBuilder::new(&resolved);
    for a in &args.args {
        cmd.arg(a);
    }
    if let Some(cwd) = &args.cwd {
        cmd.cwd(cwd);
    }
    // Seed PATH with the user's login-shell PATH so claude AND its
    // children (MCP servers, the native installer's helper, etc.) can find
    // npm/brew/bun/volta-installed binaries when the .app is launched from
    // Finder. The frontend's optional env override wins on duplicate keys.
    cmd.env("PATH", LOGIN_SHELL_PATH.as_str());
    if let Some(env) = &args.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let writer = pair.master.take_writer()?;
    let mut reader = pair.master.try_clone_reader()?;

    let summary = PtySummary {
        id: args.id.clone(),
        command: args.command.clone(),
        started_at: chrono::Utc::now().to_rfc3339(),
        alive: true,
    };

    let handle = PtyHandle {
        master: pair.master,
        writer,
        summary: summary.clone(),
    };

    registry.lock().insert(args.id.clone(), handle);

    // Reader thread - forward stdout/stderr to frontend.
    let id_for_reader = args.id.clone();
    let app_for_reader = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Carry-over for partial UTF-8 sequences that straddle a read
        // boundary. Without this, `from_utf8_lossy` was replacing the
        // trailing bytes of every cross-chunk multi-byte char (─ … ⏵)
        // with U+FFFD, which renders as `???` in xterm.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Find the largest valid UTF-8 prefix. Walk back from the
                    // end up to 3 bytes (max UTF-8 continuation length) to
                    // find where a clean break is.
                    let valid_up_to = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    let chunk = if valid_up_to > 0 {
                        // Safety: we just verified this prefix is valid UTF-8.
                        let s = unsafe { std::str::from_utf8_unchecked(&pending[..valid_up_to]) }.to_string();
                        // Keep the trailing incomplete bytes for next read.
                        pending.drain(..valid_up_to);
                        s
                    } else {
                        // Whole buffer is incomplete (rare). If pending grew
                        // beyond 4 bytes without a valid prefix it's not
                        // actually UTF-8 - emit lossy and drop to avoid
                        // unbounded growth.
                        if pending.len() >= 8 {
                            let s = String::from_utf8_lossy(&pending).to_string();
                            pending.clear();
                            s
                        } else {
                            continue;
                        }
                    };
                    let event = format!("pty://output/{}", id_for_reader);
                    if let Err(e) = app_for_reader.emit(&event, chunk) {
                        log::warn!("emit failed for {}: {}", id_for_reader, e);
                        break;
                    }
                }
                Err(e) => {
                    log::warn!("pty read error for {}: {}", id_for_reader, e);
                    break;
                }
            }
        }
        log::info!("pty reader for {} exited", id_for_reader);
    });

    // Wait thread - clean up on child exit.
    let id_for_wait = args.id.clone();
    let registry_for_wait = registry.clone();
    let app_for_wait = app.clone();
    thread::spawn(move || {
        let status = child.wait();
        log::info!("pty {} child exited: {:?}", id_for_wait, status);
        if let Some(handle) = registry_for_wait.lock().get_mut(&id_for_wait) {
            handle.summary.alive = false;
        }
        let _ = app_for_wait.emit(
            &format!("pty://exit/{}", id_for_wait),
            serde_json::json!({ "id": id_for_wait, "code": status.ok().map(|s| s.exit_code()) }),
        );
    });

    Ok(summary)
}

#[derive(Deserialize)]
pub struct WriteArgs {
    pub id: String,
    pub data: String,
}

#[tauri::command]
pub fn pty_write(args: WriteArgs, registry: State<'_, PtyRegistry>) -> Result<(), String> {
    let mut guard = registry.inner.lock();
    let handle = guard.get_mut(&args.id).ok_or_else(|| format!("no pty {}", args.id))?;
    handle
        .writer
        .write_all(args.data.as_bytes())
        .map_err(|e| e.to_string())?;
    handle.writer.flush().map_err(|e| e.to_string())?;
    // PH-134 Phase 3 - audit every byte written. Cheap, debug-critical.
    store::audit_pty_write(&args.id, &args.data);
    Ok(())
}

#[derive(Deserialize)]
pub struct ResizeArgs {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

// PH-134 Q1 - wire TIOCSWINSZ on xterm fit.
#[tauri::command]
pub fn pty_resize(args: ResizeArgs, registry: State<'_, PtyRegistry>) -> Result<(), String> {
    let guard = registry.inner.lock();
    let handle = guard.get(&args.id).ok_or_else(|| format!("no pty {}", args.id))?;
    handle
        .master
        .resize(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct KillArgs {
    pub id: String,
}

#[tauri::command]
pub fn pty_kill(args: KillArgs, registry: State<'_, PtyRegistry>) -> Result<(), String> {
    let mut guard = registry.inner.lock();
    if guard.remove(&args.id).is_none() {
        return Err(format!("no pty {}", args.id));
    }
    Ok(())
}

#[tauri::command]
pub fn pty_list(registry: State<'_, PtyRegistry>) -> Vec<PtySummary> {
    registry
        .inner
        .lock()
        .values()
        .map(|h| h.summary.clone())
        .collect()
}
