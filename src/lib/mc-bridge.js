// Yunomia - Mission Control bridge.
//
// Connects to the MC server WS (localhost:4600/ws) and dispatches events:
//   • ticket.changed → if a running agent was just assigned a ticket, write a
//     wakeup prompt to their pty stdin.
//   • ticket.changed | comment.added | audit_event → forward to the auto-compact
//     orchestrator's task-boundary trigger registry.
//
// Public API:
//   startMcBridge({ getRunningAgents, onWakeup, onTaskBoundary })
//   stopMcBridge()

import { invoke } from '@tauri-apps/api/core';

// PH-134 - read MC base from localStorage (set by main.js MC_BASE) so the WS
// URL inherits whatever the dashboard iframe is pointed at. NEVER hardcode 4600.
function mcWsUrl() {
  const base = localStorage.getItem('mc.base') || '';
  if (!base) return '';
  return base.replace(/^http/, 'ws') + '/ws';
}

let ws = null;
let reconnectTimer = null;
let cfg = null;

const VERDICT_RE = /^##\s+\S+\s+\w+\s+-\s+.+\s+-\s+\w+/m;

export function startMcBridge(opts = {}) {
  cfg = opts;
  connect();
}

export function stopMcBridge() {
  cfg = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
}

function connect() {
  if (!cfg) return;
  const url = mcWsUrl();
  if (!url) {
    console.info('[mc-bridge] no MC URL configured - bridge inactive');
    return;
  }
  ws = new WebSocket(url);
  ws.addEventListener('open', () => console.info(`[mc-bridge] connected → ${url}`));
  ws.addEventListener('close', () => {
    console.warn('[mc-bridge] disconnected - reconnect in 2s');
    if (cfg) reconnectTimer = setTimeout(connect, 2000);
  });
  ws.addEventListener('message', (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch (err) { console.warn('[mc-bridge] parse', err); }
  });
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'ticket.changed':   handleTicketChanged(msg.data); break;
    case 'ticket.created':   handleTicketCreated(msg.data); break;
    case 'comment.added':    handleCommentAdded(msg.data); break;
    case 'audit_event':      handleAuditEvent(msg.data); break;
    default: break;
  }
}

// PH-134 Phase 2 - programmatic wakeup pipeline.
// Wakeup fires when a ticket transitions into a state the agent should
// act on: status flips to "assigned" with assignee=X, or status flips to
// "in_progress" while assigneeAgent=X (the agent themselves moved it),
// or a new comment arrives on a ticket assigned to them.
function handleTicketChanged(data) {
  if (!data?.after) return;
  const fields = new Set(data.fields_changed || []);
  const after = data.after;
  const assignee = after.assignee_agent;
  if (!assignee) return;
  // Trigger wakeup if assignee just changed (someone got new work) OR
  // status just flipped to "assigned" / "in_progress" on a ticket they own.
  if (fields.has('assignee_agent') || fields.has('status')) {
    if (after.status === 'assigned' || after.status === 'in_progress') {
      cfg?.onWakeup?.({
        agentCode: assignee,
        ticketHumanId: data.ticket_human_id,
        reason: fields.has('assignee_agent') ? 'assigned' : 'status',
      });
    }
  }
  // Task-boundary trigger #1 - ticket transition.
  if (fields.has('status') && (after.status === 'in_review' || after.status === 'done')) {
    cfg?.onTaskBoundary?.({
      agentCode: assignee,
      kind: 'ticket-transition',
      ticketHumanId: data.ticket_human_id,
      newStatus: after.status,
    });
  }
}

function handleTicketCreated(data) {
  const t = data?.ticket;
  if (!t) return;
  if (t.assignee_agent && (t.status === 'assigned' || t.status === 'in_progress')) {
    cfg?.onWakeup?.({
      agentCode: t.assignee_agent,
      ticketHumanId: t.ticket_human_id,
      reason: 'created',
    });
  }
}

// Task-boundary trigger #2 - verdict comment posted (regex match).
function handleCommentAdded(data) {
  const c = data?.comment;
  if (!c) return;
  if (VERDICT_RE.test(c.body_md || '')) {
    // Author is the verdict-poster; that's the agent whose context advanced.
    cfg?.onTaskBoundary?.({
      agentCode: c.author_label?.split(' ').pop() || null,
      kind: 'verdict-comment',
      ticketHumanId: data.ticket_human_id,
      commentId: c.id,
    });
  }
}

// Task-boundary triggers #3-5 come from audit events:
// deploy.success, lesson.created, merge.success.
function handleAuditEvent(row) {
  const action = row?.action || '';
  const actor = row?.actor_id || row?.details?.agent_code || null;
  if (action === 'deploy.success' || action === 'lessons.created' || action === 'merge.success') {
    cfg?.onTaskBoundary?.({
      agentCode: actor,
      kind: action.split('.')[0],
      auditId: row?.id,
    });
  }
}

// Resolver injected by main.js: turns a bare agent code (e.g. "CEO") into the
// real pty id (e.g. "_Users_peter_Desktop_Websites_ERPrintable__CEO"). Without
// this, writeToAgent was passing the bare code straight to pty_write, which
// keys ptys by the full sanitised-cwd__code form — so every /pre-compact,
// /compact, and heartbeat write missed the lookup and silently no-op'd. That
// was why auto-compact at 50% and the heartbeat scheduler appeared dead even
// though their schedulers were firing.
let resolveAgentToPtyId = (code) => code;
export function setAgentPtyResolver(fn) { resolveAgentToPtyId = typeof fn === 'function' ? fn : ((c) => c); }

// Helper: write to an agent's pty. Centralised so wakeup/compact share path.
// `data` is the prompt text. We wrap it in bracketed-paste markers and send
// \r separately after the 150ms auto-paste threshold — claude's TUI parks
// pasted text in its input buffer until a real Enter key arrives. Callers
// should NOT include trailing \n / \r — this function adds the submit byte.
export async function writeToAgent(agentCode, data) {
  const id = resolveAgentToPtyId(agentCode);
  if (!id) {
    console.warn(`[writeToAgent] no pty id for ${agentCode} — write dropped`);
    return;
  }
  // Strip a trailing newline if the caller still passes one (legacy callers
  // — /pre-compact\n, /compact\n, heartbeat prompts). We submit via \r below.
  const text = String(data).replace(/[\r\n]+$/, '');
  const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  await invoke('pty_write', { args: { id, data: payload } });
  await new Promise((r) => setTimeout(r, 150));
  await invoke('pty_write', { args: { id, data: '\r' } });
}
