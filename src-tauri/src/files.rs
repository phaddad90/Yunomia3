// File-tree + open-with-OS-default-app commands.
//
// list_dir is intentionally a single non-recursive level - the frontend
// expands directories on click and re-fetches their children, so we never
// walk a giant tree on the rust side. We hardcode a small skip list (.git,
// node_modules, dist, target, .venv) instead of pulling in `ignore` for
// gitignore parsing - the user can still navigate into those manually if
// they really want via the path bar in a future version.
//
// open_path / reveal_path shell out to the platform's native opener so files
// land in whichever app the user has wired up (Preview for images, Safari/
// Chrome/etc for HTML, Pages for .docx). No webview embed - the user asked
// for OS-default behaviour.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    pub path: String,        // absolute path - frontend uses this for open/reveal
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: i64,
}

const SKIP: &[&str] = &[".git", "node_modules", "dist", "target", ".venv", "__pycache__", ".next", ".cache"];

#[derive(Deserialize)]
pub struct ListDirArgs {
    pub cwd: String,
    pub rel_path: Option<String>,    // relative to cwd, default ""
}

#[tauri::command]
pub fn list_dir(args: ListDirArgs) -> Result<Vec<DirEntry>, String> {
    let root = PathBuf::from(&args.cwd);
    let target = match args.rel_path.as_deref() {
        None | Some("") | Some(".") => root.clone(),
        Some(rel) => root.join(rel.trim_start_matches('/')),
    };
    // Defence-in-depth: refuse to escape cwd. Canonicalise both paths and
    // verify the target is contained.
    let root_real = root.canonicalize().map_err(|e| format!("cwd: {e}"))?;
    let target_real = target.canonicalize().map_err(|e| format!("target: {e}"))?;
    if !target_real.starts_with(&root_real) {
        return Err(format!("path escapes cwd: {}", target_real.display()));
    }
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in fs::read_dir(&target_real).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name != ".env.example" { continue; }
        if SKIP.contains(&name.as_str()) { continue; }
        let metadata = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let modified_ms = metadata.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: metadata.is_dir(),
            size: if metadata.is_file() { metadata.len() } else { 0 },
            modified_ms,
        });
    }
    // Directories first, then files, both alphabetic.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[derive(Deserialize)]
pub struct PathArgs { pub path: String }

#[tauri::command]
pub fn open_path(args: PathArgs) -> Result<(), String> {
    let is_url = args.path.starts_with("http://") || args.path.starts_with("https://");
    if !is_url && !Path::new(&args.path).exists() {
        return Err(format!("path does not exist: {}", args.path));
    }
    spawn_opener(&args.path).map_err(|e| e.to_string())
}

// Reveal in Finder / Explorer / file manager. On macOS we use `open -R`
// which highlights the file in Finder; on Linux/Windows we open the parent
// directory because there's no equivalent reveal-and-select.
#[tauri::command]
pub fn reveal_path(args: PathArgs) -> Result<(), String> {
    let p = Path::new(&args.path);
    if !p.exists() { return Err(format!("path does not exist: {}", args.path)); }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(&args.path)
            .spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let parent = p.parent().ok_or("no parent")?;
        spawn_opener(&parent.to_string_lossy()).map_err(|e| e.to_string())
    }
}

fn spawn_opener(target: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(target).spawn().map(|_| ()) }
    #[cfg(target_os = "windows")]
    { std::process::Command::new("cmd").args(["/C", "start", "", target]).spawn().map(|_| ()) }
    #[cfg(target_os = "linux")]
    { std::process::Command::new("xdg-open").arg(target).spawn().map(|_| ()) }
}
