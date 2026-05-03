// PH-134 Phase 2 - file-backed sticky-model store + sentinel watcher.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// PH-134 - Yunomia v3 owns its own state dir. NOT ~/.printpepper/. Decoupled
// from PrintPepper completely.
fn yunomia_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".yunomia")
}

fn agent_models_path() -> PathBuf {
    yunomia_dir().join("agent-models.json")
}

fn audit_dir() -> PathBuf { yunomia_dir() }

#[derive(Serialize, Deserialize, Default, Debug)]
struct ModelsFile {
    models: HashMap<String, String>,
}

#[tauri::command]
pub fn models_get() -> Result<HashMap<String, String>, String> {
    let path = agent_models_path();
    if !path.exists() { return Ok(HashMap::new()); }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: ModelsFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(parsed.models)
}

#[derive(Deserialize)]
pub struct ModelsSetArgs {
    pub code: String,
    pub model: String,
}

#[tauri::command]
pub fn models_set(args: ModelsSetArgs) -> Result<(), String> {
    let path = agent_models_path();
    fs::create_dir_all(yunomia_dir()).map_err(|e| e.to_string())?;
    let mut current = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<ModelsFile>(&raw).map_err(|e| e.to_string())?
    } else {
        ModelsFile::default()
    };
    current.models.insert(args.code, args.model);
    let serialised = serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?;
    fs::write(&path, serialised).map_err(|e| e.to_string())?;
    Ok(())
}

// PH-134 Phase 2 - sentinel watcher.
// Polls ~/.printpepper/ every 1s for `pre-compact-<AGENT>.done` files. On
// appearance, emits `compact://ready` event with the agent code, then deletes
// the sentinel. Frontend's compact orchestrator listens for this event.
//
// Naming convention: sentinel files use the agent CODE not session id, since
// MC v3 routes wakeup + compact on agent code basis, not session id. The
// /pre-compact skill writes `~/.printpepper/pre-compact-${AGENT_CODE}.done`.
pub fn start_sentinel_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let dir = audit_dir();
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = match path.file_name().and_then(|n| n.to_str()) { Some(n) => n, None => continue };
                if !name.starts_with("pre-compact-") || !name.ends_with(".done") { continue; }
                let code = &name["pre-compact-".len()..name.len() - ".done".len()];
                let payload = serde_json::json!({ "agentCode": code });
                if let Err(e) = app.emit("compact://ready", payload) {
                    log::warn!("emit compact://ready failed: {}", e);
                }
                let _ = fs::remove_file(&path);
                log::info!("sentinel processed for agent {}", code);
            }
        }
    });
}

// PH-134 Phase 3 - crash recovery / session enumeration.
// Lists Claude Code session JSONL files in `~/.claude/projects/<sanitised_cwd>/`
// that have been touched recently. The sanitisation rule (per Anthropic) is to
// replace each path separator and dot with `-`. Returns up to `limit` newest
// entries with their session id (filename stem) and last-modified time.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionInfo {
    pub session_id: String,
    pub project_dir: String,
    pub modified: String,
    pub size_bytes: u64,
}

#[derive(Deserialize)]
pub struct EnumerateArgs {
    pub cwd: String,
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn enumerate_sessions(args: EnumerateArgs) -> Result<Vec<SessionInfo>, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let sanitised = args
        .cwd
        .trim_start_matches('/')
        .replace('/', "-")
        .replace('.', "-");
    let proj_dir = PathBuf::from(&home).join(".claude").join("projects").join(format!("-{}", sanitised));
    if !proj_dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<SessionInfo> = Vec::new();
    for entry in fs::read_dir(&proj_dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let modified = meta
            .modified()
            .ok()
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
            .unwrap_or_default();
        entries.push(SessionInfo {
            session_id: stem,
            project_dir: args.cwd.clone(),
            modified,
            size_bytes: meta.len(),
        });
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    if let Some(lim) = args.limit { entries.truncate(lim); }
    Ok(entries)
}

// Context-window estimate. Reads the latest JSONL file for a (cwd) under
// ~/.claude/projects/, returns byte size + a token estimate (bytes ÷ 4) +
// percent of a 200K context window. Stand-in until Claude Code hooks emit
// canonical <session>-stats.json - same shape will be returned then.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ContextEstimate {
    pub session_id: String,
    pub bytes: u64,
    pub tokens_estimated: u64,
    pub percent: u32,
    pub source: String,    // "jsonl-bytes" today, "stats-hook" once hooks land
}

#[derive(Deserialize)]
pub struct ContextEstimateArgs {
    pub cwd: String,
}

const CONTEXT_WINDOW_TOKENS: u64 = 200_000;

#[tauri::command]
pub fn agent_context_estimate(args: ContextEstimateArgs) -> Result<Option<ContextEstimate>, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let sanitised = args.cwd.trim_start_matches('/').replace('/', "-").replace('.', "-");
    let proj_dir = PathBuf::from(&home).join(".claude").join("projects").join(format!("-{}", sanitised));
    if !proj_dir.exists() { return Ok(None); }
    // Pick the newest jsonl file.
    let mut newest: Option<(PathBuf, std::time::SystemTime, u64)> = None;
    for entry in fs::read_dir(&proj_dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let modified = match meta.modified() { Ok(m) => m, Err(_) => continue };
        let len = meta.len();
        let take = newest.as_ref().map(|(_, t, _)| modified > *t).unwrap_or(true);
        if take { newest = Some((path, modified, len)); }
    }
    let (path, _, bytes) = match newest { Some(x) => x, None => return Ok(None) };
    let session_id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let tokens_estimated = bytes / 4;       // rough - replace with hook stats once available
    let percent = ((tokens_estimated * 100) / CONTEXT_WINDOW_TOKENS).min(100) as u32;
    Ok(Some(ContextEstimate {
        session_id,
        bytes,
        tokens_estimated,
        percent,
        source: "jsonl-bytes".into(),
    }))
}

// Delete a Claude Code session file (the JSONL conversation history). Used
// by the Resume banner's per-entry × button. Path is sanitised so a caller
// can't escape ~/.claude/projects/.
#[derive(Deserialize)]
pub struct DeleteSessionArgs { pub cwd: String, pub session_id: String }
#[tauri::command]
pub fn delete_session(args: DeleteSessionArgs) -> Result<(), String> {
    if args.session_id.contains('/') || args.session_id.contains('.') {
        return Err("invalid session id".into());
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let sanitised = args.cwd.trim_start_matches('/').replace('/', "-").replace('.', "-");
    let path = PathBuf::from(&home).join(".claude").join("projects").join(format!("-{}", sanitised)).join(format!("{}.jsonl", args.session_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// PH-134 Phase 3 - pty stdin audit log. Append every byte written to an agent's
// stdin to ~/.printpepper/pty-audit-<AGENT>.log with timestamp.
pub fn audit_pty_write(agent_code: &str, data: &str) {
    let dir = audit_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("audit mkdir: {}", e);
        return;
    }
    let path = dir.join(format!("pty-audit-{}.log", agent_code));
    let line = format!("[{}] {}\n", chrono::Utc::now().to_rfc3339(), data.replace('\n', "\\n"));
    if let Err(e) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| { use std::io::Write; f.write_all(line.as_bytes()) })
    {
        log::warn!("audit append: {}", e);
    }
}
