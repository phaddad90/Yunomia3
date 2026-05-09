// Diagnostic log file. Persistent record of spawn events, pty exits, JS
// errors. Lives at `~/.yunomia/log/<YYYY-MM-DD>.log` so each day rotates
// automatically and old logs are easy to glob/delete. Frontend appends via
// the `log_append` Tauri command; Rust spawn/exit callsites also append
// directly through `append()`.
//
// Format is plain text, one event per line, ISO-8601 timestamp prefix:
//
//   2026-05-09T10:42:11Z [pty.spawn] id=lead-... cmd=claude args=... cwd=...
//   2026-05-09T10:42:11Z [pty.exit ] id=lead-... code=3221225786
//   2026-05-09T10:43:02Z [js.error ] TypeError: foo is not a function
//
// No structured logging on purpose — operators paste the file directly into
// bug reports. Keep one line per event so it's grep-friendly.

use crate::store::home_dir;
use chrono::Utc;
use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// Resolve today's log file path. Creates the parent directory on demand.
fn today_log_path() -> Result<PathBuf, String> {
    let dir = home_dir().join(".yunomia").join("log");
    fs::create_dir_all(&dir).map_err(|e| format!("create log dir: {}", e))?;
    let date = Utc::now().format("%Y-%m-%d").to_string();
    Ok(dir.join(format!("{}.log", date)))
}

/// Path to today's log file (UI surfaces this so the operator can open it
/// in their preferred editor).
pub fn current_log_file() -> Result<String, String> {
    today_log_path().map(|p| p.to_string_lossy().to_string())
}

/// Append a single event line. Creates the file if it doesn't exist.
/// `tag` should be a short bracketed category like "pty.spawn"; `line` is
/// the rest of the message. Caller need not include a timestamp — we add
/// one. Newline is added automatically.
pub fn append(tag: &str, line: &str) {
    let _ = append_inner(tag, line);
}

fn append_inner(tag: &str, line: &str) -> Result<(), String> {
    let path = today_log_path()?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open log: {}", e))?;
    let ts = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    writeln!(f, "{} [{}] {}", ts, tag, line).map_err(|e| format!("write log: {}", e))?;
    Ok(())
}

#[derive(Deserialize)]
pub struct LogAppendArgs {
    pub tag: String,
    pub line: String,
}

#[tauri::command]
pub fn log_append(args: LogAppendArgs) -> Result<(), String> {
    append(&args.tag, &args.line);
    Ok(())
}

#[tauri::command]
pub fn log_path() -> Result<String, String> {
    current_log_file()
}
