// Per-project credentials store backed by the OS keychain.
//
// Names + types live in plaintext at credentials.json so the UI can list them
// without unlocking the keychain on every render. The actual secret value is
// stored under a deterministic keychain key:
//
//   service: "io.yunomia.shell"
//   account: "<sha256(cwd)>:<name>"
//
// Hashing the cwd avoids leaking project paths into the keychain UI / system
// console while still making the entry unique per project + name. Reads,
// writes, and deletes all append to the project audit log (cred.read /
// cred.write / cred.delete) so there's a paper trail.

use crate::tickets::{ensure_project_dir, new_uuid, now_iso, read_json, write_audit, write_json};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

const SERVICE: &str = "io.yunomia.shell";

fn cwd_hash(cwd: &str) -> String {
    let mut h = Sha256::new();
    h.update(cwd.as_bytes());
    format!("{:x}", h.finalize())
}

fn account(cwd: &str, name: &str) -> String {
    format!("{}:{}", cwd_hash(cwd), name)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CredMeta {
    pub id: String,
    pub name: String,           // human-friendly name like "prod-ssh-key"
    pub kind: String,           // "ssh-key" | "password" | "token" | "env" | "json"
    pub note: Option<String>,
    pub env_var: Option<String>, // when kind == "env", the env var name to inject as
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Default)]
struct CredFile { creds: Vec<CredMeta> }

fn load(dir: &PathBuf) -> Result<CredFile, String> {
    read_json(&dir.join("credentials.json"))
}

fn save(dir: &PathBuf, file: &CredFile) -> Result<(), String> {
    write_json(&dir.join("credentials.json"), file)
}

#[derive(Deserialize)]
pub struct ListArgs { pub cwd: String }

#[tauri::command]
pub fn credentials_list(args: ListArgs) -> Result<Vec<CredMeta>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    Ok(load(&dir)?.creds)
}

#[derive(Deserialize)]
pub struct UpsertArgs {
    pub cwd: String,
    pub name: String,
    pub kind: String,
    pub value: String,
    pub note: Option<String>,
    pub env_var: Option<String>,
}

#[tauri::command]
pub fn credentials_upsert(args: UpsertArgs) -> Result<CredMeta, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    if args.name.trim().is_empty() { return Err("name required".into()); }
    let entry = keyring::Entry::new(SERVICE, &account(&args.cwd, &args.name))
        .map_err(|e| format!("keyring: {e}"))?;
    entry.set_password(&args.value).map_err(|e| format!("keyring write: {e}"))?;

    let mut file = load(&dir)?;
    let now = now_iso();
    let meta = if let Some(existing) = file.creds.iter_mut().find(|c| c.name == args.name) {
        existing.kind = args.kind.clone();
        existing.note = args.note.clone();
        existing.env_var = args.env_var.clone();
        existing.updated_at = now.clone();
        existing.clone()
    } else {
        let m = CredMeta {
            id: new_uuid(), name: args.name.clone(), kind: args.kind.clone(),
            note: args.note.clone(), env_var: args.env_var.clone(),
            created_at: now.clone(), updated_at: now.clone(),
        };
        file.creds.push(m.clone());
        m
    };
    save(&dir, &file)?;
    let _ = write_audit(&dir, "cred.write", "", "PETER", serde_json::json!({
        "name": args.name, "kind": args.kind,
    }));
    Ok(meta)
}

#[derive(Deserialize)]
pub struct DeleteArgs { pub cwd: String, pub name: String }

#[tauri::command]
pub fn credentials_delete(args: DeleteArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    if let Ok(entry) = keyring::Entry::new(SERVICE, &account(&args.cwd, &args.name)) {
        let _ = entry.delete_credential();
    }
    let mut file = load(&dir)?;
    file.creds.retain(|c| c.name != args.name);
    save(&dir, &file)?;
    let _ = write_audit(&dir, "cred.delete", "", "PETER", serde_json::json!({ "name": args.name }));
    Ok(())
}

#[derive(Deserialize)]
pub struct GetArgs { pub cwd: String, pub name: String, pub reader: Option<String> }

// Reveals the secret value. Used by the UI's "Show" toggle and by the deploy
// runner. Always audits with the requesting actor (defaults to PETER for the
// UI; agents would pass their code).
#[tauri::command]
pub fn credentials_reveal(args: GetArgs) -> Result<String, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let entry = keyring::Entry::new(SERVICE, &account(&args.cwd, &args.name))
        .map_err(|e| format!("keyring: {e}"))?;
    let value = entry.get_password().map_err(|e| format!("keyring read: {e}"))?;
    let actor = args.reader.unwrap_or_else(|| "PETER".into());
    let _ = write_audit(&dir, "cred.read", "", &actor, serde_json::json!({ "name": args.name }));
    Ok(value)
}
