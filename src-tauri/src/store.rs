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
#[serde(rename_all = "camelCase")]
pub struct ContextEstimateArgs {
    pub cwd: String,
    // Optional. When provided, look up this agent's recorded session_id in
    // operator/agent-sessions.json and read THAT specific JSONL. Without it
    // we fall back to the newest JSONL in the project's claude-code dir,
    // which is wrong when multiple agents share a cwd (LEAD + CEO both
    // showing identical context %).
    pub agent_code: Option<String>,
}

const CONTEXT_WINDOW_TOKENS: u64 = 200_000;

fn claude_project_dir(cwd: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let sanitised = cwd.trim_start_matches('/').replace('/', "-").replace('.', "-");
    Ok(PathBuf::from(&home).join(".claude").join("projects").join(format!("-{}", sanitised)))
}

fn yunomia_project_op_dir(cwd: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let sanitised = cwd.trim_start_matches('/').replace('/', "-").replace(' ', "_");
    Ok(PathBuf::from(&home).join(".yunomia").join("projects").join(sanitised))
}

fn agent_session_lookup(cwd: &str, agent_code: &str) -> Option<String> {
    let path = yunomia_project_op_dir(cwd).ok()?.join("agent-sessions.json");
    if !path.exists() { return None; }
    let raw = fs::read_to_string(&path).ok()?;
    let map: std::collections::HashMap<String, String> = serde_json::from_str(&raw).ok()?;
    map.get(agent_code).cloned()
}

fn agent_session_pin(cwd: &str, agent_code: &str, session_id: &str) -> Result<(), String> {
    let path = yunomia_project_op_dir(cwd)?.join("agent-sessions.json");
    let mut map: std::collections::HashMap<String, String> = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() { std::collections::HashMap::new() }
        else { serde_json::from_str(&raw).unwrap_or_default() }
    } else {
        std::collections::HashMap::new()
    };
    map.insert(agent_code.to_string(), session_id.to_string());
    let serialised = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
    fs::write(&path, serialised).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_context_estimate(args: ContextEstimateArgs) -> Result<Option<ContextEstimate>, String> {
    let proj_dir = claude_project_dir(&args.cwd)?;
    if !proj_dir.exists() { return Ok(None); }
    // If we have an explicit session for this agent, read THAT JSONL only.
    // EXCEPT: claude-code rotates session IDs after /compact - the old jsonl
    // stops growing and a new one appears. If we keep reading the old one,
    // the context % stays at 100 forever post-compact. Detect rotation by
    // comparing recorded session's mtime to the newest jsonl in the project
    // dir; if there's a newer one with non-trivial size, switch to it and
    // re-record so the agent_session_lookup converges.
    let recorded_session = args.agent_code.as_deref().and_then(|c| agent_session_lookup(&args.cwd, c));
    let (path, bytes) = if let Some(sid) = &recorded_session {
        let recorded_path = proj_dir.join(format!("{}.jsonl", sid));
        if !recorded_path.exists() { return Ok(None); }
        let recorded_meta = recorded_path.metadata().map_err(|e| e.to_string())?;
        let recorded_mtime = recorded_meta.modified().ok();
        // Look for a newer jsonl that started writing AFTER the recorded
        // session's last update. If found, that's the post-compact rotation.
        let mut newer: Option<(PathBuf, std::time::SystemTime, u64)> = None;
        if let Some(rmt) = recorded_mtime {
            for entry in fs::read_dir(&proj_dir).map_err(|e| e.to_string())?.flatten() {
                let p = entry.path();
                if p == recorded_path { continue; }
                if p.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
                let m = match entry.metadata() { Ok(m) => m, Err(_) => continue };
                let mt = match m.modified() { Ok(t) => t, Err(_) => continue };
                if mt > rmt && m.len() > 256 {
                    let take = newer.as_ref().map(|(_, t, _)| mt > *t).unwrap_or(true);
                    if take { newer = Some((p, mt, m.len())); }
                }
            }
        }
        if let Some((np, _, nb)) = newer {
            // Re-record so future ticks (and the chip's session_id label)
            // converge on the new session.
            let new_sid = np.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if !new_sid.is_empty() {
                if let Some(code) = args.agent_code.as_deref() {
                    let _ = agent_session_pin(&args.cwd, code, &new_sid);
                }
            }
            (np, nb)
        } else {
            (recorded_path, recorded_meta.len())
        }
    } else {
        // Fallback: pick the newest jsonl. Used for the resume banner and
        // pre-v0.1.16 spawns that never recorded a session.
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
        match newest { Some((p, _, b)) => (p, b), None => return Ok(None) }
    };
    let session_id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    // Prefer stats hook output when present.
    let stats_path = proj_dir.join(format!("{}-stats.json", session_id));
    if stats_path.exists() {
        if let Ok(raw) = fs::read_to_string(&stats_path) {
            #[derive(Deserialize)] struct Stats { tokens_used: u64, tokens_total: u64 }
            if let Ok(s) = serde_json::from_str::<Stats>(&raw) {
                let total = if s.tokens_total > 0 { s.tokens_total } else { CONTEXT_WINDOW_TOKENS };
                let percent = ((s.tokens_used.min(total) * 100) / total) as u32;
                return Ok(Some(ContextEstimate {
                    session_id,
                    bytes,
                    tokens_estimated: s.tokens_used,
                    percent,
                    source: "stats-hook".into(),
                }));
            }
        }
    }
    let tokens_estimated = bytes / 4;       // fallback heuristic
    let percent = ((tokens_estimated * 100) / CONTEXT_WINDOW_TOKENS).min(100) as u32;
    Ok(Some(ContextEstimate {
        session_id,
        bytes,
        tokens_estimated,
        percent,
        source: "jsonl-bytes".into(),
    }))
}

// Pin an agent's claude-code session id so future context queries read from
// THAT JSONL, not just the newest file in cwd. Called from the frontend a
// few seconds after pty_spawn returns: we snapshot what JSONLs exist now
// and watch for the next one to appear (claude-code creates a new JSONL
// when the session begins streaming). The frontend passes either an
// explicit session_id (if it parsed it from the pty output) or null to
// trigger discovery: pick the newest JSONL whose mtime is after the spawn
// timestamp.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRecordArgs {
    pub cwd: String,
    pub agent_code: String,
    pub session_id: Option<String>,
    pub since_ms: Option<i64>,         // epoch ms; ignored if session_id given
}

#[tauri::command]
pub fn agent_session_record(args: AgentSessionRecordArgs) -> Result<String, String> {
    let session_id = if let Some(sid) = args.session_id.filter(|s| !s.is_empty()) {
        sid
    } else {
        // Discovery path: scan claude-code's project dir for the newest JSONL
        // whose mtime is after `since_ms` (i.e. created since this agent spawned).
        let proj_dir = claude_project_dir(&args.cwd)?;
        if !proj_dir.exists() { return Err("no claude-code project dir yet; spawn hasn't materialised".into()); }
        let since = args.since_ms.unwrap_or(0);
        let mut newest: Option<(PathBuf, i64)> = None;
        for entry in fs::read_dir(&proj_dir).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
            let mtime_ms = entry.metadata().ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if mtime_ms < since { continue; }
            let take = newest.as_ref().map(|(_, t)| mtime_ms > *t).unwrap_or(true);
            if take { newest = Some((path, mtime_ms)); }
        }
        let path = newest.ok_or_else(|| "no JSONL found newer than the spawn timestamp; did the agent get any output yet?".to_string())?.0;
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string()
    };
    if session_id.is_empty() { return Err("derived session_id was empty".into()); }
    let op_dir = yunomia_project_op_dir(&args.cwd)?;
    fs::create_dir_all(&op_dir).map_err(|e| e.to_string())?;
    let path = op_dir.join("agent-sessions.json");
    let mut map: std::collections::HashMap<String, String> = if path.exists() {
        fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    } else { std::collections::HashMap::new() };
    map.insert(args.agent_code, session_id.clone());
    let raw = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(session_id)
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
