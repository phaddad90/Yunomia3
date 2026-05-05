// Deploy-target definitions + the runner.
//
// Targets live in deploys.json per project. The runner shells out to bash -c
// (or cmd /C on Windows) so each target's command can do whatever the user
// configures: rsync, ssh + remote command, vercel CLI, gh release upload,
// custom shell script, etc. Approval rules are enforced before the command
// runs - "auto" runs immediately, "requires-peter" needs the actor to be
// PETER, "requires-tag" needs the ticket to carry a deploy-approved tag,
// "requires-qa" needs a comment from QA on the ticket containing the verdict
// line. Stdout / stderr stream back to the frontend over a Tauri event so
// the UI can show a tail.

use crate::tickets::{ensure_project_dir, new_uuid, now_iso, read_json, write_audit, write_json};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::io::{BufRead, BufReader};
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DeployTarget {
    pub id: String,
    pub name: String,
    pub kind: String,                  // "command" | "ssh" | "rsync" | "s3" | "vercel"
    pub command: String,               // shell command to execute (we do not parse, just exec)
    pub cred_name: Option<String>,     // injected as env vars (see env_var on CredMeta) or named CRED_<NAME>
    pub preflight: Option<String>,     // optional shell command to run first; non-zero blocks the deploy
    pub approval: String,              // "auto" | "requires-peter" | "requires-qa" | "requires-tag"
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Default)]
struct DeployFile { targets: Vec<DeployTarget> }

fn load(dir: &PathBuf) -> Result<DeployFile, String> {
    read_json(&dir.join("deploys.json"))
}

fn save(dir: &PathBuf, file: &DeployFile) -> Result<(), String> {
    write_json(&dir.join("deploys.json"), file)
}

#[derive(Deserialize)]
pub struct ListArgs { pub cwd: String }

#[tauri::command]
pub fn deploys_list(args: ListArgs) -> Result<Vec<DeployTarget>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    Ok(load(&dir)?.targets)
}

#[derive(Deserialize)]
pub struct UpsertArgs {
    pub cwd: String,
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub command: String,
    pub cred_name: Option<String>,
    pub preflight: Option<String>,
    pub approval: String,
    pub note: Option<String>,
}

#[tauri::command]
pub fn deploys_upsert(args: UpsertArgs) -> Result<DeployTarget, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    if args.name.trim().is_empty() || args.command.trim().is_empty() {
        return Err("name and command required".into());
    }
    let mut file = load(&dir)?;
    let now = now_iso();
    let target = if let Some(existing_id) = &args.id {
        if let Some(t) = file.targets.iter_mut().find(|t| &t.id == existing_id) {
            t.name = args.name.clone();
            t.kind = args.kind.clone();
            t.command = args.command.clone();
            t.cred_name = args.cred_name.clone();
            t.preflight = args.preflight.clone();
            t.approval = args.approval.clone();
            t.note = args.note.clone();
            t.updated_at = now.clone();
            t.clone()
        } else {
            return Err(format!("target {existing_id} not found"));
        }
    } else {
        let t = DeployTarget {
            id: new_uuid(), name: args.name.clone(), kind: args.kind.clone(),
            command: args.command.clone(), cred_name: args.cred_name.clone(),
            preflight: args.preflight.clone(), approval: args.approval.clone(),
            note: args.note.clone(),
            created_at: now.clone(), updated_at: now.clone(),
        };
        file.targets.push(t.clone());
        t
    };
    save(&dir, &file)?;
    Ok(target)
}

#[derive(Deserialize)]
pub struct DeleteArgs { pub cwd: String, pub id: String }

#[tauri::command]
pub fn deploys_delete(args: DeleteArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let mut file = load(&dir)?;
    file.targets.retain(|t| t.id != args.id);
    save(&dir, &file)?;
    Ok(())
}

#[derive(Deserialize)]
pub struct RunArgs {
    pub cwd: String,
    pub target_id: String,
    pub ticket_id: Option<String>,
    pub actor: Option<String>,        // "PETER" or an agent code
    pub dry_run: Option<bool>,
}

#[derive(Serialize)]
pub struct RunResult {
    pub run_id: String,
    pub started_at: String,
}

// Spawns the deploy in a background thread. Streams output to the frontend
// over `deploy://output/<run_id>` and emits a `deploy://exit/<run_id>` event
// when finished. The UI mounts a panel listening on those channels.
#[tauri::command]
pub fn deploys_run(args: RunArgs, app: tauri::AppHandle) -> Result<RunResult, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let file = load(&dir)?;
    let target = file.targets.iter().find(|t| t.id == args.target_id)
        .ok_or_else(|| format!("target {} not found", args.target_id))?
        .clone();
    let actor = args.actor.clone().unwrap_or_else(|| "PETER".into());

    // Approval gate.
    if let Err(reason) = check_approval(&target, &args, &dir) {
        let _ = write_audit(&dir, "deploy.blocked", &args.target_id, &actor, serde_json::json!({
            "target": target.name, "reason": reason,
        }));
        return Err(format!("blocked: {reason}"));
    }

    let run_id = new_uuid();
    let dry_run = args.dry_run.unwrap_or(false);
    let _ = write_audit(&dir, "deploy.start", args.ticket_id.as_deref().unwrap_or(""), &actor, serde_json::json!({
        "target": target.name, "run_id": run_id, "dry_run": dry_run,
    }));

    // Resolve cred (if any) into the child env. We don't log the value, just
    // the fact of injection - the read itself audits via credentials_reveal.
    let mut env_vars: Vec<(String, String)> = Vec::new();
    if let Some(cred_name) = &target.cred_name {
        match keyring::Entry::new("io.yunomia.shell", &account(&args.cwd, cred_name)) {
            Ok(entry) => match entry.get_password() {
                Ok(value) => {
                    let var = cred_lookup::env_var_for(&args.cwd, cred_name)
                        .unwrap_or_else(|| format!("CRED_{}", cred_name.to_uppercase().replace('-', "_")));
                    env_vars.push((var, value));
                    let _ = write_audit(&dir, "cred.read", "", &actor, serde_json::json!({
                        "name": cred_name, "context": "deploy", "target": target.name,
                    }));
                }
                Err(e) => {
                    return Err(format!("keychain read failed for cred '{}': {}", cred_name, e));
                }
            },
            Err(e) => return Err(format!("keychain entry: {e}")),
        }
    }

    let cwd = args.cwd.clone();
    let app2 = app.clone();
    let dir2 = dir.clone();
    let run_id2 = run_id.clone();
    let actor2 = actor.clone();
    let ticket_id2 = args.ticket_id.clone().unwrap_or_default();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();

        if let Some(pre) = target.preflight.as_deref() {
            if !pre.trim().is_empty() {
                emit_line(&app2, &run_id2, &format!("> preflight: {pre}\n"));
                if let Err(code) = run_command(pre, &cwd, &env_vars, dry_run, &app2, &run_id2) {
                    let elapsed = started.elapsed().as_millis() as i64;
                    let _ = write_audit(&dir2, "deploy.complete", &ticket_id2, &actor2, serde_json::json!({
                        "target": target.name, "run_id": run_id2,
                        "exit_code": code, "duration_ms": elapsed, "stage": "preflight",
                    }));
                    let _ = app2.emit(&format!("deploy://exit/{}", run_id2),
                        serde_json::json!({ "code": code, "stage": "preflight" }));
                    return;
                }
            }
        }

        emit_line(&app2, &run_id2, &format!("> {}\n", target.command));
        let exit = run_command(&target.command, &cwd, &env_vars, dry_run, &app2, &run_id2)
            .err().unwrap_or(0);
        let elapsed = started.elapsed().as_millis() as i64;
        let _ = write_audit(&dir2, "deploy.complete", &ticket_id2, &actor2, serde_json::json!({
            "target": target.name, "run_id": run_id2,
            "exit_code": exit, "duration_ms": elapsed,
        }));
        let _ = app2.emit(&format!("deploy://exit/{}", run_id2),
            serde_json::json!({ "code": exit }));
    });

    Ok(RunResult { run_id, started_at: now_iso() })
}

fn run_command(cmd_str: &str, cwd: &str, env: &[(String, String)], dry_run: bool, app: &tauri::AppHandle, run_id: &str) -> Result<(), i32> {
    if dry_run {
        emit_line(app, run_id, "[dry-run] not executing.\n");
        return Ok(());
    }
    let mut cmd;
    if cfg!(windows) {
        cmd = std::process::Command::new("cmd");
        cmd.args(["/C", cmd_str]);
    } else {
        cmd = std::process::Command::new("bash");
        cmd.args(["-lc", cmd_str]);
    }
    cmd.current_dir(cwd)
        .envs(env.iter().cloned())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_line(app, run_id, &format!("[error] spawn failed: {e}\n"));
            return Err(127);
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app1 = app.clone(); let id1 = run_id.to_string();
    let app2 = app.clone(); let id2 = run_id.to_string();
    let t1 = stdout.map(|s| std::thread::spawn(move || pump(s, app1, id1)));
    let t2 = stderr.map(|s| std::thread::spawn(move || pump(s, app2, id2)));
    let status = child.wait().map_err(|_| 127)?;
    if let Some(t) = t1 { let _ = t.join(); }
    if let Some(t) = t2 { let _ = t.join(); }
    let code = status.code().unwrap_or(-1);
    if code == 0 { Ok(()) } else { Err(code) }
}

fn pump<R: std::io::Read + Send + 'static>(r: R, app: tauri::AppHandle, run_id: String) {
    let reader = BufReader::new(r);
    for line in reader.lines().flatten() {
        emit_line(&app, &run_id, &format!("{line}\n"));
    }
}

fn emit_line(app: &tauri::AppHandle, run_id: &str, line: &str) {
    let _ = app.emit(&format!("deploy://output/{}", run_id), line);
}

// We can't import the private CredFile from credentials.rs, so we reload its
// JSON shape locally for the env_var lookup. Cheap (small file) and keeps
// the modules independent.
mod cred_lookup {
    use serde::Deserialize;
    #[derive(Deserialize)]
    pub struct Meta { pub name: String, pub env_var: Option<String> }
    #[derive(Deserialize, Default)]
    pub struct File { pub creds: Vec<Meta> }
    pub fn env_var_for(cwd: &str, name: &str) -> Option<String> {
        let dir = crate::tickets::ensure_project_dir(cwd).ok()?;
        let raw = std::fs::read_to_string(dir.join("credentials.json")).ok()?;
        let file: File = serde_json::from_str(&raw).ok()?;
        file.creds.into_iter().find(|c| c.name == name).and_then(|c| c.env_var)
    }
}

fn account(cwd: &str, name: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(cwd.as_bytes());
    format!("{:x}:{}", h.finalize(), name)
}

fn check_approval(target: &DeployTarget, args: &RunArgs, dir: &PathBuf) -> Result<(), String> {
    match target.approval.as_str() {
        "auto" => Ok(()),
        "requires-peter" => {
            let actor = args.actor.as_deref().unwrap_or("");
            if actor == "PETER" { Ok(()) } else { Err("approval=requires-peter; only PETER can run this target".into()) }
        }
        "requires-tag" => {
            let ticket_id = args.ticket_id.as_deref().ok_or("approval=requires-tag; this target needs a ticket reference")?;
            #[derive(serde::Deserialize, Default)]
            struct T { pub id: String, pub tags: Option<Vec<String>> }
            let tickets: Vec<T> = read_json(&dir.join("tickets.json"))?;
            let t = tickets.iter().find(|t| t.id == ticket_id).ok_or("ticket not found")?;
            let has_tag = t.tags.as_ref().map(|v| v.iter().any(|s| s == "deploy-approved")).unwrap_or(false);
            if has_tag { Ok(()) } else { Err("approval=requires-tag; ticket needs the 'deploy-approved' tag".into()) }
        }
        "requires-qa" => {
            let ticket_id = args.ticket_id.as_deref().ok_or("approval=requires-qa; this target needs a ticket reference")?;
            #[derive(serde::Deserialize, Default)]
            struct C { pub ticket_id: String, pub author_label: Option<String>, pub body_md: String }
            let comments: Vec<C> = read_json(&dir.join("comments.json"))?;
            let ok = comments.iter().any(|c|
                c.ticket_id == ticket_id
                && c.author_label.as_deref().map(|a| a.contains("QA")).unwrap_or(false)
                && c.body_md.to_lowercase().contains("qa verdict: pass"));
            if ok { Ok(()) } else { Err("approval=requires-qa; needs a QA comment containing 'QA verdict: pass'".into()) }
        }
        other => Err(format!("unknown approval rule: {other}")),
    }
}

