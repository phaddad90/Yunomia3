// Yunomia — file-backed per-project ticket store. Self-contained, no external API.
//
// Layout:
//   ~/.yunomia/projects/<sanitised-cwd>/tickets.json
//   ~/.yunomia/projects/<sanitised-cwd>/comments.json
//   ~/.yunomia/projects/<sanitised-cwd>/audit.json
//   ~/.yunomia/projects/<sanitised-cwd>/counter.txt    (per-project monotonic ticket number)
//   ~/.yunomia/projects/<sanitised-cwd>/prefix.txt     (per-project 3-letter prefix, e.g. "ERP")
//
// Schema mirrors MC v0.3 so existing rendering patterns can be reused.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Ticket {
    pub id: String,
    pub human_id: String,
    pub r#type: String,            // bug | feature | doc | gate | migration | ops
    pub status: String,            // backlog | triage | assigned | in_progress | in_review | done | released
    pub title: String,
    pub body_md: String,
    pub assignee_agent: Option<String>,
    pub audience: String,          // app | admin
    pub references_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Comment {
    pub id: String,
    pub ticket_id: String,
    pub body_md: String,
    pub author_label: String,      // e.g. "🛠 TA" or "🎩 PETER"
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AuditEntry {
    pub id: String,
    pub ticket_id: Option<String>,
    pub action: String,            // ticket.created / status_changed / commented / assigned / patched
    pub actor: String,             // human or agent code
    pub details: serde_json::Value,
    pub created_at: String,
}

fn yunomia_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".yunomia")
}

fn sanitise(cwd: &str) -> String {
    cwd.trim_start_matches('/').replace('/', "-").replace(' ', "_")
}

fn project_dir(cwd: &str) -> PathBuf {
    yunomia_dir().join("projects").join(sanitise(cwd))
}

fn ensure_project_dir(cwd: &str) -> Result<PathBuf, String> {
    let dir = project_dir(cwd);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> Result<T, String> {
    if !path.exists() { return Ok(T::default()); }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() { return Ok(T::default()); }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_json<T: Serialize>(path: &PathBuf, val: &T) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(val).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn now_iso() -> String { chrono::Utc::now().to_rfc3339() }
fn new_uuid() -> String { uuid::Uuid::new_v4().to_string() }

fn project_prefix(cwd: &str, dir: &PathBuf) -> String {
    let path = dir.join("prefix.txt");
    if let Ok(p) = fs::read_to_string(&path) {
        let trimmed = p.trim();
        if !trimmed.is_empty() { return trimmed.to_string(); }
    }
    let base = cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("TKT");
    let mut letters: String = base.chars().filter(|c| c.is_ascii_alphabetic()).take(3).collect::<String>().to_uppercase();
    while letters.len() < 3 { letters.push('X'); }
    if letters.trim().is_empty() { letters = "TKT".into(); }
    let _ = fs::write(&path, &letters);
    letters
}

fn next_human_id(cwd: &str, dir: &PathBuf) -> String {
    let counter_path = dir.join("counter.txt");
    let next = fs::read_to_string(&counter_path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0) + 1;
    let _ = fs::write(&counter_path, next.to_string());
    let prefix = project_prefix(cwd, dir);
    format!("{}-{:03}", prefix, next)
}

#[derive(Deserialize)]
pub struct ListArgs {
    pub cwd: String,
}

#[tauri::command]
pub fn tickets_list(args: ListArgs) -> Result<Vec<Ticket>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("tickets.json");
    let tickets: Vec<Ticket> = read_json(&path)?;
    Ok(tickets)
}

#[derive(Deserialize)]
pub struct CreateArgs {
    pub cwd: String,
    pub title: String,
    pub body_md: String,
    pub r#type: String,
    pub status: Option<String>,
    pub audience: Option<String>,
    pub assignee_agent: Option<String>,
}

#[tauri::command]
pub fn tickets_create(args: CreateArgs) -> Result<Ticket, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("tickets.json");
    let mut tickets: Vec<Ticket> = read_json(&path)?;
    let now = now_iso();
    let ticket = Ticket {
        id: new_uuid(),
        human_id: next_human_id(&args.cwd, &dir),
        r#type: args.r#type,
        status: args.status.unwrap_or_else(|| "triage".into()),
        title: args.title,
        body_md: args.body_md,
        assignee_agent: args.assignee_agent,
        audience: args.audience.unwrap_or_else(|| "admin".into()),
        references_json: None,
        created_at: now.clone(),
        updated_at: now,
    };
    tickets.push(ticket.clone());
    write_json(&path, &tickets)?;
    write_audit(&dir, "ticket.created", &ticket.id, "user", serde_json::json!({ "human_id": ticket.human_id, "title": ticket.title }))?;
    Ok(ticket)
}

#[derive(Deserialize)]
pub struct PatchArgs {
    pub cwd: String,
    pub id: String,
    pub fields: serde_json::Map<String, serde_json::Value>,
}

#[tauri::command]
pub fn tickets_patch(args: PatchArgs) -> Result<Ticket, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("tickets.json");
    let mut tickets: Vec<Ticket> = read_json(&path)?;
    let idx = tickets.iter().position(|t| t.id == args.id).ok_or_else(|| "ticket not found".to_string())?;
    let mut t = tickets[idx].clone();
    let mut changed = serde_json::Map::new();
    for (k, v) in args.fields.iter() {
        match k.as_str() {
            "title"          => if let Some(s) = v.as_str() { t.title = s.into(); changed.insert(k.clone(), v.clone()); },
            "body_md" | "bodyMd" => if let Some(s) = v.as_str() { t.body_md = s.into(); changed.insert("body_md".into(), v.clone()); },
            "type"           => if let Some(s) = v.as_str() { t.r#type = s.into(); changed.insert(k.clone(), v.clone()); },
            "audience"       => if let Some(s) = v.as_str() { t.audience = s.into(); changed.insert(k.clone(), v.clone()); },
            "status"         => if let Some(s) = v.as_str() { t.status = s.into(); changed.insert(k.clone(), v.clone()); },
            "assignee_agent" | "assigneeAgent" => {
                if v.is_null() { t.assignee_agent = None; }
                else if let Some(s) = v.as_str() { t.assignee_agent = Some(s.into()); }
                changed.insert("assignee_agent".into(), v.clone());
            }
            _ => {}
        }
    }
    t.updated_at = now_iso();
    tickets[idx] = t.clone();
    write_json(&path, &tickets)?;
    write_audit(&dir, "ticket.patched", &t.id, "user", serde_json::Value::Object(changed))?;
    Ok(t)
}

#[derive(Deserialize)]
pub struct TransitionArgs {
    pub cwd: String,
    pub id: String,
    pub action: String,            // start | handoff | done | reopen
}

#[tauri::command]
pub fn tickets_transition(args: TransitionArgs) -> Result<Ticket, String> {
    let next = match args.action.as_str() {
        "start"    => "in_progress",
        "handoff"  => "in_review",
        "done"     => "done",
        "reopen"   => "assigned",
        _          => return Err(format!("unknown action {}", args.action)),
    };
    let mut fields = serde_json::Map::new();
    fields.insert("status".into(), serde_json::Value::String(next.into()));
    tickets_patch(PatchArgs { cwd: args.cwd, id: args.id, fields })
}

#[derive(Deserialize)]
pub struct CommentsListArgs {
    pub cwd: String,
    pub ticket_id: Option<String>,
}

#[tauri::command]
pub fn comments_list(args: CommentsListArgs) -> Result<Vec<Comment>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("comments.json");
    let comments: Vec<Comment> = read_json(&path)?;
    Ok(match args.ticket_id {
        Some(id) => comments.into_iter().filter(|c| c.ticket_id == id).collect(),
        None     => comments,
    })
}

#[derive(Deserialize)]
pub struct CommentCreateArgs {
    pub cwd: String,
    pub ticket_id: String,
    pub body_md: String,
    pub author_label: String,
}

#[tauri::command]
pub fn comments_create(args: CommentCreateArgs) -> Result<Comment, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("comments.json");
    let mut comments: Vec<Comment> = read_json(&path)?;
    let comment = Comment {
        id: new_uuid(),
        ticket_id: args.ticket_id.clone(),
        body_md: args.body_md,
        author_label: args.author_label,
        created_at: now_iso(),
    };
    comments.push(comment.clone());
    write_json(&path, &comments)?;
    write_audit(&dir, "ticket.commented", &args.ticket_id, &comment.author_label, serde_json::json!({ "comment_id": comment.id }))?;
    Ok(comment)
}

// Per-project lifecycle state: onboarding (no tickets yet, lead agent
// interviewing the user) vs active (brief approved, tickets in flight).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ProjectState {
    pub phase: String,                  // "onboarding" | "active"
    pub project_name: String,
    pub created_at: String,
    pub brief_finalised_at: Option<String>,
    pub lead_spawned_at: Option<String>,
}

impl Default for ProjectState {
    fn default() -> Self {
        Self {
            phase: "onboarding".into(),
            project_name: String::new(),
            created_at: now_iso(),
            brief_finalised_at: None,
            lead_spawned_at: None,
        }
    }
}

#[derive(Deserialize)]
pub struct StateGetArgs {
    pub cwd: String,
}

#[tauri::command]
pub fn project_state_get(args: StateGetArgs) -> Result<ProjectState, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("state.json");
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if !raw.trim().is_empty() {
            return serde_json::from_str(&raw).map_err(|e| e.to_string());
        }
    }
    Ok(ProjectState::default())
}

#[derive(Deserialize)]
pub struct StateSetArgs {
    pub cwd: String,
    pub patch: serde_json::Map<String, serde_json::Value>,
}

#[tauri::command]
pub fn project_state_set(args: StateSetArgs) -> Result<ProjectState, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("state.json");
    let mut state: ProjectState = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() { ProjectState::default() } else { serde_json::from_str(&raw).map_err(|e| e.to_string())? }
    } else {
        ProjectState::default()
    };
    for (k, v) in args.patch.iter() {
        match k.as_str() {
            "phase"               => if let Some(s) = v.as_str() { state.phase = s.into(); },
            "project_name"        => if let Some(s) = v.as_str() { state.project_name = s.into(); },
            "brief_finalised_at"  => state.brief_finalised_at = v.as_str().map(|s| s.to_string()),
            "lead_spawned_at"     => state.lead_spawned_at = v.as_str().map(|s| s.to_string()),
            _ => {}
        }
    }
    write_json(&path, &state)?;
    Ok(state)
}

// Brief is the canonical scope document. The Lead agent writes here as the
// onboarding conversation evolves.
#[derive(Deserialize)]
pub struct BriefArgs {
    pub cwd: String,
}

#[tauri::command]
pub fn brief_get(args: BriefArgs) -> Result<String, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("brief.md");
    if !path.exists() { return Ok(String::new()); }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct BriefWriteArgs {
    pub cwd: String,
    pub markdown: String,
}

#[tauri::command]
pub fn brief_write(args: BriefWriteArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("brief.md");
    fs::write(&path, args.markdown).map_err(|e| e.to_string())
}

// Agent proposals — Lead writes a JSON file to ask the user to spawn a new
// agent mid-project. Yunomia polls the file, surfaces a modal, ingests on
// approve. Single proposal at a time (Lead overwrites).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentProposal {
    pub code: String,
    pub model: Option<String>,
    pub wakeup_mode: Option<String>,
    pub heartbeat_min: Option<u32>,
    pub reason: String,                 // why this agent is being proposed
    pub soul_md: Option<String>,        // short character sheet
    pub kickoff_md: Option<String>,     // first-wake prompt
    pub pre_compact_md: Option<String>, // /pre-compact summary instructions
    pub reawaken_md: Option<String>,    // post-compact reawaken prompt
    pub proposed_at: String,
}
fn agent_proposal_path(dir: &PathBuf) -> PathBuf { dir.join("agent-proposal.json") }
#[derive(Deserialize)]
pub struct AgentProposalReadArgs { pub cwd: String }
#[tauri::command]
pub fn agent_proposal_read(args: AgentProposalReadArgs) -> Result<Option<AgentProposal>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let p = agent_proposal_path(&dir);
    if !p.exists() { return Ok(None); }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() { return Ok(None); }
    serde_json::from_str(&raw).map(Some).map_err(|e| e.to_string())
}
#[derive(Deserialize)]
pub struct AgentProposalClearArgs { pub cwd: String }
#[tauri::command]
pub fn agent_proposal_clear(args: AgentProposalClearArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let p = agent_proposal_path(&dir);
    if p.exists() { let _ = fs::remove_file(p); }
    Ok(())
}

// Approve a proposal: writes the four agent files, adds to project_agents.
#[derive(Deserialize)]
pub struct AgentProposalApproveArgs {
    pub cwd: String,
    pub proposal: AgentProposal,
}
#[tauri::command]
pub fn agent_proposal_approve(args: AgentProposalApproveArgs) -> Result<ProjectAgent, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let agent_dir = dir.join("agents").join(&args.proposal.code);
    fs::create_dir_all(&agent_dir).map_err(|e| e.to_string())?;
    let p = &args.proposal;
    fs::write(agent_dir.join("soul.md"),         default_text(&p.soul_md,         &default_soul(&p.code, &p.reason))).map_err(|e| e.to_string())?;
    fs::write(agent_dir.join("kickoff.md"),      default_text(&p.kickoff_md,      &default_kickoff(&p.code, &p.reason))).map_err(|e| e.to_string())?;
    fs::write(agent_dir.join("pre-compact.md"),  default_text(&p.pre_compact_md,  &default_pre_compact(&p.code))).map_err(|e| e.to_string())?;
    fs::write(agent_dir.join("reawaken.md"),     default_text(&p.reawaken_md,     &default_reawaken(&p.code))).map_err(|e| e.to_string())?;
    let agent = ProjectAgent {
        code: p.code.clone(),
        model: p.model.clone().unwrap_or_else(|| "claude-sonnet-4-6".into()),
        wakeup_mode: p.wakeup_mode.clone().unwrap_or_else(|| "on-assignment".into()),
        heartbeat_min: p.heartbeat_min.unwrap_or(60),
        note: Some(p.reason.clone()),
    };
    let path = dir.join("agents.json");
    let mut existing: Vec<ProjectAgent> = read_json(&path)?;
    existing.retain(|x| x.code != agent.code);
    existing.push(agent.clone());
    write_json(&path, &existing)?;
    // Clear proposal so the modal doesn't re-fire.
    let _ = fs::remove_file(agent_proposal_path(&dir));
    write_audit(&dir, "agent.approved", "", "user", serde_json::json!({ "code": agent.code }))?;
    Ok(agent)
}

fn default_text(opt: &Option<String>, fallback: &str) -> String {
    opt.as_deref().filter(|s| !s.trim().is_empty()).map(String::from).unwrap_or_else(|| fallback.into())
}
fn default_soul(code: &str, reason: &str) -> String {
    format!("# {} — Soul\n\nRole proposed by Lead: {}\n\n## Voice\n- Direct, technical, terse.\n- Pushes back on fuzzy scope.\n- Cites evidence over opinion.\n\n## Expertise\n(populate during onboarding)\n\n## Operating principles\n- Single-task focus.\n- Document decisions in tickets, not chat.\n- File a bug lesson on every defect closure.\n", code, reason)
}
fn default_kickoff(code: &str, reason: &str) -> String {
    format!("You are {} — newly spawned by the project Lead.\n\nReason: {}\n\nFirst-wake actions:\n1. Read your soul, goals, and the project brief.\n2. Check your queue (assigned tickets in this project's kanban).\n3. If queue is empty, idle until something lands.\n\nUse Yunomia's kanban via the file-backed JSON store. Comments + transitions ripple through the dashboard automatically.\n", code, reason)
}
fn default_pre_compact(code: &str) -> String {
    format!("/pre-compact for {}.\n\nSummarise:\n- Tickets touched this session (human ids + verdict).\n- Open questions you didn't get to.\n- Files modified.\n- Lessons learnt (file them as BL-NNN before /compact).\n- State you'll need to resume cleanly.\n\nWrite a 200–500 word summary. Then trigger /compact.\n", code)
}
fn default_reawaken(code: &str) -> String {
    format!("Reawaken — {}\n\nYou were /compact'd. Read your soul + goals + the most recent BL filed under this project. Then check your queue. If you find a stale in_progress ticket assigned to you, resume it.\n", code)
}

// Schedules — per-ticket scheduled_for.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Schedule {
    pub ticket_id: String,
    pub ticket_human_id: String,
    pub ticket_title: String,
    pub scheduled_for: String,
    pub set_by: String,
    pub set_at: String,
    pub fired: bool,
}
#[derive(Deserialize)]
pub struct SchedulesListArgs { pub cwd: String }
#[tauri::command]
pub fn schedules_list(args: SchedulesListArgs) -> Result<Vec<Schedule>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    Ok(read_json(&dir.join("schedules.json"))?)
}
#[derive(Deserialize)]
pub struct ScheduleSetArgs {
    pub cwd: String, pub ticket_id: String,
    pub scheduled_for: String, pub set_by: Option<String>,
}
#[tauri::command]
pub fn schedules_set(args: ScheduleSetArgs) -> Result<Schedule, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("schedules.json");
    let mut list: Vec<Schedule> = read_json(&path)?;
    list.retain(|s| s.ticket_id != args.ticket_id);
    // Look up ticket to capture title + human_id snapshot.
    let tickets: Vec<Ticket> = read_json(&dir.join("tickets.json"))?;
    let t = tickets.iter().find(|t| t.id == args.ticket_id);
    let entry = Schedule {
        ticket_id: args.ticket_id,
        ticket_human_id: t.map(|x| x.human_id.clone()).unwrap_or_default(),
        ticket_title: t.map(|x| x.title.clone()).unwrap_or_default(),
        scheduled_for: args.scheduled_for,
        set_by: args.set_by.unwrap_or_else(|| "user".into()),
        set_at: now_iso(),
        fired: false,
    };
    list.push(entry.clone());
    write_json(&path, &list)?;
    Ok(entry)
}
#[derive(Deserialize)]
pub struct ScheduleClearArgs { pub cwd: String, pub ticket_id: String }
#[tauri::command]
pub fn schedules_clear(args: ScheduleClearArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("schedules.json");
    let mut list: Vec<Schedule> = read_json(&path)?;
    list.retain(|s| s.ticket_id != args.ticket_id);
    write_json(&path, &list)
}
#[tauri::command]
pub fn schedules_due_now(args: SchedulesListArgs) -> Result<Vec<Schedule>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("schedules.json");
    let mut list: Vec<Schedule> = read_json(&path)?;
    let now = chrono::Utc::now();
    let mut due = Vec::new();
    let mut changed = false;
    for s in list.iter_mut() {
        if s.fired { continue; }
        if let Ok(when) = chrono::DateTime::parse_from_rfc3339(&s.scheduled_for) {
            if when.with_timezone(&chrono::Utc) <= now { s.fired = true; due.push(s.clone()); changed = true; }
        }
    }
    if changed { write_json(&path, &list)?; }
    Ok(due)
}

// Activity feed — read audit.json (newest first).
#[derive(Deserialize)]
pub struct AuditListArgs { pub cwd: String, pub limit: Option<usize> }
#[tauri::command]
pub fn audit_list(args: AuditListArgs) -> Result<Vec<AuditEntry>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("audit.json");
    let mut list: Vec<AuditEntry> = read_json(&path)?;
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    if let Some(n) = args.limit { list.truncate(n); }
    Ok(list)
}

// Per-project inbox — events the user wants surfaced (e.g. ticket assigned to
// them, comments on their tickets, scheduled-due hits). Append-only JSONL.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InboxEntry {
    pub id: String,
    pub created_at: String,
    pub kind: String,                    // ticket.assigned | comment.added | schedule.due | bug.closed
    pub ticket_human_id: Option<String>,
    pub summary: String,
    pub processed: bool,
}
#[derive(Deserialize)]
pub struct InboxAppendArgs {
    pub cwd: String, pub kind: String, pub ticket_human_id: Option<String>, pub summary: String,
}
#[tauri::command]
pub fn inbox_append(args: InboxAppendArgs) -> Result<InboxEntry, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("inbox.json");
    let mut list: Vec<InboxEntry> = read_json(&path)?;
    let entry = InboxEntry {
        id: new_uuid(), created_at: now_iso(),
        kind: args.kind, ticket_human_id: args.ticket_human_id, summary: args.summary,
        processed: false,
    };
    list.push(entry.clone());
    write_json(&path, &list)?;
    Ok(entry)
}
#[derive(Deserialize)]
pub struct InboxListArgs { pub cwd: String }
#[tauri::command]
pub fn inbox_list(args: InboxListArgs) -> Result<Vec<InboxEntry>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let mut list: Vec<InboxEntry> = read_json(&dir.join("inbox.json"))?;
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}
#[derive(Deserialize)]
pub struct InboxMarkArgs { pub cwd: String, pub id: String }
#[tauri::command]
pub fn inbox_mark_processed(args: InboxMarkArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("inbox.json");
    let mut list: Vec<InboxEntry> = read_json(&path)?;
    for e in list.iter_mut() { if e.id == args.id { e.processed = true; } }
    write_json(&path, &list)
}
#[derive(Deserialize)]
pub struct InboxMarkAllArgs { pub cwd: String }
#[tauri::command]
pub fn inbox_mark_all(args: InboxMarkAllArgs) -> Result<u32, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("inbox.json");
    let mut list: Vec<InboxEntry> = read_json(&path)?;
    let mut n = 0;
    for e in list.iter_mut() { if !e.processed { e.processed = true; n += 1; } }
    write_json(&path, &list)?;
    Ok(n)
}

// Per-agent files — kickoff / goals / soul. Stored under agents/<CODE>/{file}.
#[derive(Deserialize)]
pub struct AgentFileArgs { pub cwd: String, pub code: String, pub kind: String }     // kind: kickoff | goals | soul
#[tauri::command]
pub fn agent_file_get(args: AgentFileArgs) -> Result<String, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("agents").join(&args.code).join(format!("{}.md", args.kind));
    if !path.exists() { return Ok(String::new()); }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}
#[derive(Deserialize)]
pub struct AgentFileWriteArgs { pub cwd: String, pub code: String, pub kind: String, pub markdown: String }
#[tauri::command]
pub fn agent_file_write(args: AgentFileWriteArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?.join("agents").join(&args.code);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{}.md", args.kind)), args.markdown).map_err(|e| e.to_string())
}

// Project agents roster — list of {code, model, wakeup_mode, heartbeat_min}.
// Persisted at agents.json. Source of truth for who's "in" this project.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectAgent {
    pub code: String,
    pub model: String,
    pub wakeup_mode: String,           // "heartbeat" | "on-assignment"
    pub heartbeat_min: u32,            // ignored unless mode=heartbeat
    pub note: Option<String>,
}
#[derive(Deserialize)]
pub struct AgentsListArgs { pub cwd: String }
#[tauri::command]
pub fn project_agents_list(args: AgentsListArgs) -> Result<Vec<ProjectAgent>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    Ok(read_json(&dir.join("agents.json"))?)
}
#[derive(Deserialize)]
pub struct AgentsUpsertArgs { pub cwd: String, pub agents: Vec<ProjectAgent> }
#[tauri::command]
pub fn project_agents_upsert(args: AgentsUpsertArgs) -> Result<Vec<ProjectAgent>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("agents.json");
    let mut existing: Vec<ProjectAgent> = read_json(&path)?;
    for a in args.agents.into_iter() {
        if let Some(slot) = existing.iter_mut().find(|x| x.code == a.code) {
            *slot = a;
        } else {
            existing.push(a);
        }
    }
    write_json(&path, &existing)?;
    Ok(existing)
}
#[derive(Deserialize)]
pub struct AgentsRemoveArgs { pub cwd: String, pub code: String }
#[tauri::command]
pub fn project_agents_remove(args: AgentsRemoveArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("agents.json");
    let mut list: Vec<ProjectAgent> = read_json(&path)?;
    list.retain(|a| a.code != args.code);
    write_json(&path, &list)
}

// Reports — daily summary.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReportsSummary {
    pub open: u32,
    pub in_progress: u32,
    pub in_review: u32,
    pub done_today: u32,
    pub by_agent: std::collections::HashMap<String, u32>,
}
#[derive(Deserialize)]
pub struct ReportsArgs { pub cwd: String }
#[tauri::command]
pub fn reports_summary(args: ReportsArgs) -> Result<ReportsSummary, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let tickets: Vec<Ticket> = read_json(&dir.join("tickets.json"))?;
    let mut summary = ReportsSummary::default();
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    for t in &tickets {
        match t.status.as_str() {
            "in_progress" => summary.in_progress += 1,
            "in_review" => summary.in_review += 1,
            "done" => {
                if t.updated_at.starts_with(&today) { summary.done_today += 1; }
            }
            "released" => {}
            _ => summary.open += 1,
        }
        if let Some(a) = &t.assignee_agent {
            if t.status != "done" && t.status != "released" {
                *summary.by_agent.entry(a.clone()).or_insert(0) += 1;
            }
        }
    }
    Ok(summary)
}
impl Default for ReportsSummary {
    fn default() -> Self {
        Self { open: 0, in_progress: 0, in_review: 0, done_today: 0, by_agent: std::collections::HashMap::new() }
    }
}

// Compliance — minimal: per-ticket eligible-actions + global kill-switch.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EligibleActions {
    pub can_start: bool,    pub start_reason: Option<String>,
    pub can_handoff: bool,  pub handoff_reason: Option<String>,
    pub can_done: bool,     pub done_reason: Option<String>,
    pub compliance_disabled: bool,
}
#[derive(Deserialize)]
pub struct EligibleArgs { pub cwd: String, pub id: String }
#[tauri::command]
pub fn eligible_actions(args: EligibleArgs) -> Result<EligibleActions, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let kill = read_kill_switch(&dir);
    let tickets: Vec<Ticket> = read_json(&dir.join("tickets.json"))?;
    let t = tickets.iter().find(|x| x.id == args.id).ok_or_else(|| "not found".to_string())?;
    let comments: Vec<Comment> = read_json(&dir.join("comments.json"))?;
    let lessons: Vec<Lesson> = read_json(&dir.join("lessons.json"))?;
    let mut e = EligibleActions {
        can_start: true, start_reason: None,
        can_handoff: true, handoff_reason: None,
        can_done: true, done_reason: None,
        compliance_disabled: kill,
    };
    if kill { return Ok(e); }
    // Single-task focus: agent assigned to this ticket can't /start if they
    // already have another in_progress ticket in this project.
    if t.status == "assigned" {
        if let Some(a) = &t.assignee_agent {
            let count = tickets.iter().filter(|x| x.id != t.id && x.status == "in_progress" && x.assignee_agent.as_deref() == Some(a.as_str())).count();
            if count > 0 {
                e.can_start = false;
                e.start_reason = Some(format!("Agent {} already has {} in_progress ticket{}.", a, count, if count==1 {""} else {"s"}));
            }
        }
    }
    // Bug close requires a Bug Lesson cited.
    if t.r#type == "bug" && t.status == "in_review" {
        let cited = lessons.iter().any(|l| l.ticket_id.as_deref() == Some(t.id.as_str()));
        if !cited {
            e.can_done = false;
            e.done_reason = Some("Bug ticket can't /done without a Bug Lesson — capture one first.".into());
        }
    }
    // Pretend-QA gate: bugs need a verdict comment matching ## QA — PASS.
    if t.r#type == "bug" && t.status == "in_review" && e.can_done {
        let qa_passed = comments.iter().any(|c| c.ticket_id == t.id && c.body_md.contains("## QA — ") && c.body_md.contains("PASS"));
        if !qa_passed {
            e.can_done = false;
            e.done_reason = Some("Bug ticket needs a `## QA — … — PASS` verdict comment.".into());
        }
    }
    Ok(e)
}

// Kill-switch: file-backed, reads each call (cheap).
fn kill_switch_path(dir: &PathBuf) -> PathBuf { dir.join("kill-switch.json") }
fn read_kill_switch(dir: &PathBuf) -> bool {
    let p = kill_switch_path(dir);
    if !p.exists() { return false; }
    if let Ok(raw) = fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            return v.get("disabled").and_then(|x| x.as_bool()).unwrap_or(false);
        }
    }
    false
}
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct KillSwitch {
    pub disabled: bool,
    pub disabled_at: Option<String>,
    pub disabled_by: Option<String>,
    pub reason: Option<String>,
}
#[derive(Deserialize)]
pub struct KillSwitchGetArgs { pub cwd: String }
#[tauri::command]
pub fn kill_switch_get(args: KillSwitchGetArgs) -> Result<KillSwitch, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let p = kill_switch_path(&dir);
    if !p.exists() { return Ok(KillSwitch::default()); }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
#[derive(Deserialize)]
pub struct KillSwitchSetArgs { pub cwd: String, pub disabled: bool, pub by: Option<String>, pub reason: Option<String> }
#[tauri::command]
pub fn kill_switch_set(args: KillSwitchSetArgs) -> Result<KillSwitch, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let ks = KillSwitch {
        disabled: args.disabled,
        disabled_at: if args.disabled { Some(now_iso()) } else { None },
        disabled_by: args.by,
        reason: args.reason,
    };
    fs::write(kill_switch_path(&dir), serde_json::to_string_pretty(&ks).unwrap()).map_err(|e| e.to_string())?;
    Ok(ks)
}

// Bug Lessons — file-backed per-project at lessons.json. Schema mirrors
// MC v0.3's lesson contract (symptom / root cause / fix / files / recognise /
// prevent + tags + severity).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Lesson {
    pub id: String,
    pub human_id: String,            // e.g. BL-001
    pub ticket_id: Option<String>,
    pub ticket_human_id: Option<String>,
    pub symptom: String,
    pub severity: String,            // low | medium | high | critical
    pub root_cause: String,
    pub fix: String,
    pub files_changed: String,
    pub recognise_pattern: String,
    pub prevent_action: String,
    pub tags: Vec<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct LessonsListArgs { pub cwd: String }

#[tauri::command]
pub fn lessons_list(args: LessonsListArgs) -> Result<Vec<Lesson>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("lessons.json");
    let lessons: Vec<Lesson> = read_json(&path)?;
    Ok(lessons)
}

#[derive(Deserialize)]
pub struct LessonCreateArgs {
    pub cwd: String,
    pub symptom: String,
    pub severity: Option<String>,
    pub ticket_id: Option<String>,
    pub ticket_human_id: Option<String>,
    pub root_cause: Option<String>,
    pub fix: Option<String>,
    pub files_changed: Option<String>,
    pub recognise_pattern: Option<String>,
    pub prevent_action: Option<String>,
    pub tags: Option<Vec<String>>,
    pub created_by: Option<String>,
}

#[tauri::command]
pub fn lessons_create(args: LessonCreateArgs) -> Result<Lesson, String> {
    if args.symptom.trim().is_empty() { return Err("symptom required".into()); }
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("lessons.json");
    let mut lessons: Vec<Lesson> = read_json(&path)?;
    let counter_path = dir.join("lessons-counter.txt");
    let next = fs::read_to_string(&counter_path).ok().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0) + 1;
    let _ = fs::write(&counter_path, next.to_string());
    let now = now_iso();
    let lesson = Lesson {
        id: new_uuid(),
        human_id: format!("BL-{:03}", next),
        ticket_id: args.ticket_id,
        ticket_human_id: args.ticket_human_id,
        symptom: args.symptom,
        severity: args.severity.unwrap_or_else(|| "medium".into()),
        root_cause: args.root_cause.unwrap_or_default(),
        fix: args.fix.unwrap_or_default(),
        files_changed: args.files_changed.unwrap_or_default(),
        recognise_pattern: args.recognise_pattern.unwrap_or_default(),
        prevent_action: args.prevent_action.unwrap_or_default(),
        tags: args.tags.unwrap_or_default(),
        created_by: args.created_by.unwrap_or_else(|| "user".into()),
        created_at: now.clone(),
        updated_at: now,
    };
    lessons.push(lesson.clone());
    write_json(&path, &lessons)?;
    write_audit(&dir, "lesson.created", lesson.ticket_id.as_deref().unwrap_or(""), &lesson.created_by,
                serde_json::json!({ "lesson_id": lesson.id, "human_id": lesson.human_id }))?;
    Ok(lesson)
}

#[derive(Deserialize)]
pub struct LessonPatchArgs {
    pub cwd: String,
    pub id: String,
    pub fields: serde_json::Map<String, serde_json::Value>,
}

#[tauri::command]
pub fn lessons_patch(args: LessonPatchArgs) -> Result<Lesson, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("lessons.json");
    let mut lessons: Vec<Lesson> = read_json(&path)?;
    let idx = lessons.iter().position(|l| l.id == args.id).ok_or_else(|| "lesson not found".to_string())?;
    let mut l = lessons[idx].clone();
    for (k, v) in args.fields.iter() {
        match k.as_str() {
            "symptom"          => if let Some(s) = v.as_str() { l.symptom = s.into(); },
            "severity"         => if let Some(s) = v.as_str() { l.severity = s.into(); },
            "root_cause"       => if let Some(s) = v.as_str() { l.root_cause = s.into(); },
            "fix"              => if let Some(s) = v.as_str() { l.fix = s.into(); },
            "files_changed"    => if let Some(s) = v.as_str() { l.files_changed = s.into(); },
            "recognise_pattern"=> if let Some(s) = v.as_str() { l.recognise_pattern = s.into(); },
            "prevent_action"   => if let Some(s) = v.as_str() { l.prevent_action = s.into(); },
            "tags"             => if let Some(arr) = v.as_array() { l.tags = arr.iter().filter_map(|x| x.as_str().map(String::from)).collect(); },
            _ => {}
        }
    }
    l.updated_at = now_iso();
    lessons[idx] = l.clone();
    write_json(&path, &lessons)?;
    Ok(l)
}

#[derive(Deserialize)]
pub struct LessonDeleteArgs { pub cwd: String, pub id: String }

#[tauri::command]
pub fn lessons_delete(args: LessonDeleteArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("lessons.json");
    let mut lessons: Vec<Lesson> = read_json(&path)?;
    lessons.retain(|l| l.id != args.id);
    write_json(&path, &lessons)
}

// Lead → tickets / agents bridge.
// Lead's onboarding kickoff writes proposals to two sentinel files; on
// Approve-brief, Yunomia ingests them into real tickets + agents.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProposedTicket {
    pub title: String,
    pub body_md: Option<String>,
    pub r#type: Option<String>,
    pub audience: Option<String>,
    pub assignee_agent: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProposedAgent {
    pub code: String,
    pub model: Option<String>,
    pub reason: Option<String>,
    pub wakeup_mode: Option<String>,    // "heartbeat" | "on-assignment"
}

#[derive(Deserialize)]
pub struct ProposalsReadArgs { pub cwd: String }

#[derive(Serialize)]
pub struct Proposals {
    pub tickets: Vec<ProposedTicket>,
    pub agents: Vec<ProposedAgent>,
}

#[tauri::command]
pub fn proposals_read(args: ProposalsReadArgs) -> Result<Proposals, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let tickets: Vec<ProposedTicket> = if dir.join("proposed-tickets.json").exists() {
        let raw = fs::read_to_string(dir.join("proposed-tickets.json")).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() { Vec::new() } else { serde_json::from_str(&raw).unwrap_or_default() }
    } else { Vec::new() };
    let agents: Vec<ProposedAgent> = if dir.join("proposed-agents.json").exists() {
        let raw = fs::read_to_string(dir.join("proposed-agents.json")).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() { Vec::new() } else { serde_json::from_str(&raw).unwrap_or_default() }
    } else { Vec::new() };
    Ok(Proposals { tickets, agents })
}

#[derive(Deserialize)]
pub struct ProposalsClearArgs { pub cwd: String }

#[tauri::command]
pub fn proposals_clear(args: ProposalsClearArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    for f in &["proposed-tickets.json", "proposed-agents.json"] {
        let p = dir.join(f);
        if p.exists() { let _ = fs::remove_file(p); }
    }
    Ok(())
}

fn write_audit(dir: &PathBuf, action: &str, ticket_id: &str, actor: &str, details: serde_json::Value) -> Result<(), String> {
    let path = dir.join("audit.json");
    let mut audit: Vec<AuditEntry> = read_json(&path)?;
    audit.push(AuditEntry {
        id: new_uuid(),
        ticket_id: Some(ticket_id.to_string()),
        action: action.into(),
        actor: actor.into(),
        details,
        created_at: now_iso(),
    });
    write_json(&path, &audit)
}
