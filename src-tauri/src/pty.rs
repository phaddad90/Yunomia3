// PTY layer - wraps portable-pty handles for the Tauri frontend.
//
// Each pty is assigned a stable string ID by the frontend (typically the agent
// code, e.g. "CEO", "QA"). The frontend invokes `pty_spawn` to start a
// process, `pty_write` to send stdin, `pty_resize` to forward TIOCSWINSZ on
// xterm resize, and `pty_kill` on tab close. Stdout is streamed back to the
// frontend via Tauri events on the channel `pty://output/<id>`.

use crate::store;
use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use tauri::{Emitter, State};

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

    let mut cmd = CommandBuilder::new(&args.command);
    for a in &args.args {
        cmd.arg(a);
    }
    if let Some(cwd) = &args.cwd {
        cmd.cwd(cwd);
    }
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
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
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
