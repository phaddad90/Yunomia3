// Git status + GH CLI integration.
//
// We shell out to `git` and `gh` rather than linking libgit2: the user
// already has both for their normal workflow, and gh handles auth + GH
// servers without us reimplementing it. Each command degrades gracefully:
// if the cwd isn't a repo, git_status returns is_repo=false; if gh isn't
// installed or unauthenticated, ci_last_run returns "unknown".

use serde::{Deserialize, Serialize};
use std::process::Command;

fn run(args: &[&str], cwd: &str) -> Option<String> {
    let out = Command::new(args[0]).args(&args[1..]).current_dir(cwd).output().ok()?;
    if !out.status.success() { return None; }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Serialize, Default)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub remote: Option<String>,
}

#[derive(Deserialize)]
pub struct CwdArgs { pub cwd: String }

#[tauri::command]
pub fn git_status(args: CwdArgs) -> Result<GitStatus, String> {
    let inside = run(&["git", "rev-parse", "--is-inside-work-tree"], &args.cwd);
    if inside.as_deref() != Some("true") {
        return Ok(GitStatus { is_repo: false, ..Default::default() });
    }
    let branch = run(&["git", "branch", "--show-current"], &args.cwd);
    let porcelain = run(&["git", "status", "--porcelain"], &args.cwd).unwrap_or_default();
    let dirty = !porcelain.is_empty();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    if let Some(rev_count) = run(&["git", "rev-list", "--left-right", "--count", "HEAD...@{u}"], &args.cwd) {
        let mut parts = rev_count.split_whitespace();
        ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }
    let remote = run(&["git", "remote", "get-url", "origin"], &args.cwd);
    Ok(GitStatus { is_repo: true, branch, dirty, ahead, behind, remote })
}

#[derive(Serialize, Default)]
pub struct CiRun {
    pub status: String,            // "queued" | "in_progress" | "completed" | "unknown"
    pub conclusion: Option<String>, // "success" | "failure" | "cancelled" | null while running
    pub workflow: Option<String>,
    pub url: Option<String>,
    pub created_at: Option<String>,
}

#[tauri::command]
pub fn ci_last_run(args: CwdArgs) -> Result<CiRun, String> {
    // gh refuses to run without a repo context; if there's no gh or no auth,
    // we just return status=unknown rather than an error so the UI can render
    // a "no CI signal" badge.
    let raw = match run(&[
        "gh", "run", "list", "--limit", "1",
        "--json", "status,conclusion,name,url,createdAt",
    ], &args.cwd) {
        Some(s) => s,
        None => return Ok(CiRun { status: "unknown".into(), ..Default::default() }),
    };
    if raw.trim() == "[]" || raw.is_empty() {
        return Ok(CiRun { status: "unknown".into(), ..Default::default() });
    }
    #[derive(Deserialize)]
    struct Row {
        status: String,
        conclusion: Option<String>,
        name: Option<String>,
        url: Option<String>,
        #[serde(rename = "createdAt")]
        created_at: Option<String>,
    }
    let rows: Vec<Row> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let r = match rows.into_iter().next() {
        Some(r) => r,
        None => return Ok(CiRun { status: "unknown".into(), ..Default::default() }),
    };
    Ok(CiRun {
        status: r.status,
        conclusion: r.conclusion,
        workflow: r.name,
        url: r.url,
        created_at: r.created_at,
    })
}

#[derive(Deserialize)]
pub struct PrCreateArgs {
    pub cwd: String,
    pub title: String,
    pub body: String,
    pub draft: Option<bool>,
}

#[derive(Serialize)]
pub struct PrCreateResult {
    pub url: String,
}

#[tauri::command]
pub fn gh_pr_create(args: PrCreateArgs) -> Result<PrCreateResult, String> {
    let mut cmd = vec!["gh", "pr", "create", "--title", args.title.as_str(), "--body", args.body.as_str()];
    if args.draft.unwrap_or(false) { cmd.push("--draft"); }
    let out = Command::new(cmd[0]).args(&cmd[1..]).current_dir(&args.cwd)
        .output().map_err(|e| format!("gh: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(format!("gh pr create failed: {}", if stderr.is_empty() { stdout } else { stderr }));
    }
    // gh prints the PR URL on stdout.
    let url = stdout.lines().rev().find(|l| l.starts_with("http")).unwrap_or(&stdout).to_string();
    Ok(PrCreateResult { url })
}
