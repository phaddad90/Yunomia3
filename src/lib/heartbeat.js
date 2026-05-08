// Yunomia - per-agent heartbeat config.
//
// Each agent in the project's roster has wakeup_mode = "heartbeat" or
// "on-assignment". Heartbeat agents fire a scheduled wake every
// heartbeat_min minutes if their pty is alive. on-assignment agents only
// wake when a ticket lands on them via mc-bridge.
//
// Layer 0 mechanical safety-net (zero-LLM) still runs alongside.
//
// Layer 0 - mechanical safety-net (zero LLM tokens). Every 30s, walks each
// running pty: if we wrote a wakeup AT_T and the pty produced no stdout in
// the 5 minutes following, re-fire the wakeup prompt. Catches fired-but-
// missed wakeups, crashed-restart races, and pty layer hiccups.
//
// Layer 1 - CEO judgement-required hourly check. Writes a brief heartbeat
// prompt to the CEO pty if running, asking it to scan for stuck agents and
// reassign / nudge as needed. ~200-500 tokens/tick on Sonnet/Opus.

import { writeToAgent } from './mc-bridge.js';

const LAYER0_INTERVAL_MS = 30_000;
const LAYER0_STALL_MS    = 5 * 60_000;
const LAYER1_INTERVAL_MS = 60_000;     // tick every minute; per-agent cadence honoured inside

// agentCode → { lastWakeupAt: epoch_ms, lastStdoutAt: epoch_ms, ticketHumanId, reason }
const wakeups = new Map();
let l0Timer = null;
let l1Timer = null;

export function noteWakeupSent(agentCode, ticketHumanId, reason) {
  const prev = wakeups.get(agentCode) || {};
  wakeups.set(agentCode, {
    ...prev,
    lastWakeupAt: Date.now(),
    ticketHumanId,
    reason,
  });
}

export function noteStdoutFromAgent(agentCode) {
  const prev = wakeups.get(agentCode) || {};
  wakeups.set(agentCode, { ...prev, lastStdoutAt: Date.now() });
}

export function startHeartbeat({ getRunningAgents, rewakeAgent }) {
  l0Timer = setInterval(() => layer0Tick({ getRunningAgents, rewakeAgent }), LAYER0_INTERVAL_MS);
  l1Timer = setInterval(() => layer1Tick({ getRunningAgents }), LAYER1_INTERVAL_MS);
}

export function stopHeartbeat() {
  if (l0Timer) clearInterval(l0Timer);
  if (l1Timer) clearInterval(l1Timer);
  l0Timer = null; l1Timer = null;
}

function layer0Tick({ getRunningAgents, rewakeAgent }) {
  const running = new Set(getRunningAgents());
  const now = Date.now();
  for (const [code, w] of wakeups.entries()) {
    if (!running.has(code)) continue;
    if (!w.lastWakeupAt) continue;
    if (w.lastStdoutAt && w.lastStdoutAt >= w.lastWakeupAt) continue;  // already responded
    if (now - w.lastWakeupAt < LAYER0_STALL_MS) continue;               // still in grace
    console.warn(`[heartbeat-L0] ${code} stalled - re-firing wakeup`);
    rewakeAgent(code, w.ticketHumanId, w.reason || 're-wakeup');
    // Reset the wakeup timestamp so we don't re-fire every 30s.
    wakeups.set(code, { ...w, lastWakeupAt: now });
  }
}

// Per-agent scheduler - only fires for agents whose project_agents.json
// entry has wakeup_mode = "heartbeat". Reads the project agents list every
// minute, schedules a wake for each at heartbeat_min cadence.
import { invoke } from '@tauri-apps/api/core';
const lastFiredAt = new Map();   // `${cwd}|${code}` → epoch ms
async function layer1Tick({ getRunningAgents }) {
  const cwd = window.yunomia?.state?.selectedProject;
  if (!cwd) return;
  let agents = [];
  try { agents = await invoke('project_agents_list', { args: { cwd } }) || []; } catch { return; }
  const heartbeatAgents = agents.filter((a) => a.wakeup_mode === 'heartbeat');
  if (!heartbeatAgents.length) return;
  const running = new Set(getRunningAgents());
  const now = Date.now();
  // Pull tickets.json once per tick so we can build an actionable summary
  // for orchestrator agents. Without this the heartbeat prompt was too
  // passive ("anything you should be doing?") and orchestrators would
  // describe what they were *waiting on* instead of taking the obvious
  // next move (transition triage, reassign orphans, etc.).
  let tickets = [];
  try { tickets = await invoke('tickets_list', { args: { cwd } }) || []; } catch { /* keep empty */ }
  const triage = tickets.filter((t) => t.status === 'triage');
  const inProgress = tickets.filter((t) => t.status === 'in_progress');
  const orphanInProgress = inProgress.filter((t) => t.assignee_agent && !running.has(t.assignee_agent));
  let goals = [];
  let questions = [];
  try { goals = await invoke('goals_list', { args: { cwd } }) || []; } catch { /* keep empty */ }
  try { questions = await invoke('questions_list', { args: { cwd } }) || []; } catch { /* keep empty */ }
  const openGoals = goals.filter((g) => g.status === 'pending' || g.status === 'in_progress' || g.status === 'blocked');
  const openQuestions = questions.filter((q) => !q.answer_md);
  // Recently-answered (last 24h) — CEO needs to see and act on these.
  const dayAgo = Date.now() - 24 * 3600_000;
  const recentlyAnswered = questions.filter((q) => {
    if (!q.answer_md || !q.answered_at) return false;
    const t = Date.parse(q.answered_at);
    return Number.isFinite(t) && t >= dayAgo;
  });
  const isOrchestrator = (code) => code === 'CEO' || code === 'LEAD';
  for (const a of heartbeatAgents) {
    if (!running.has(a.code)) continue;
    const key = `${cwd}|${a.code}`;
    const last = lastFiredAt.get(key) || 0;
    const intervalMs = Math.max(5, a.heartbeat_min || 60) * 60_000;
    if (now - last < intervalMs) continue;
    lastFiredAt.set(key, now);
    let prompt;
    if (isOrchestrator(a.code)) {
      const triageList = triage.length
        ? triage.slice(0, 8).map((t) => `${t.human_id} (${t.assignee_agent || 'unassigned'}): ${t.title}`).join('; ')
        : '(none)';
      const orphanList = orphanInProgress.length
        ? orphanInProgress.slice(0, 8).map((t) => `${t.human_id} → ${t.assignee_agent} not running`).join('; ')
        : '(none)';
      const goalsList = openGoals.length
        ? openGoals.slice(0, 8).map((g) => `[${g.status}] ${g.title}${g.ticket_human_ids?.length ? ` (tickets: ${g.ticket_human_ids.join(', ')})` : ''}`).join('; ')
        : '(none — propose some, ask the operator if unclear what we are driving toward)';
      const openQList = openQuestions.length
        ? openQuestions.slice(0, 8).map((q) => `${q.id.slice(0,8)} [${q.agent_code}${q.context_ticket ? `/${q.context_ticket}` : ''}]: ${q.body_md.slice(0, 120)}`).join(' | ')
        : '(none)';
      const answeredList = recentlyAnswered.length
        ? recentlyAnswered.slice(0, 8).map((q) => `${q.id.slice(0,8)} Q="${q.body_md.slice(0,80)}" A="${(q.answer_md || '').slice(0,120)}"`).join(' | ')
        : '(none)';
      prompt = `\n\n[Yunomia heartbeat - ${a.code} - ${new Date().toISOString()}] Orchestrator check. You drive this project toward goals — you are NOT idle if any goal is open and unblocked. Take the action, do NOT just describe state.\n\nGoals (file: .yunomia/goals.json — your file edits ARE goal management): ${goalsList}\nTriage tickets needing routing/assignment: ${triageList}\nIn_progress tickets orphaned (assignee not running): ${orphanList}\nOpen questions awaiting your answer (you wrote them — operator hasn't replied yet): ${openQList}\nRecently-answered questions (act on these now if relevant): ${answeredList}\n\nDecision tree:\n- A goal is open AND you can advance it (create a ticket, route a ticket, mark progress in goals.json): do it now via Edit on tickets.json / goals.json.\n- A goal is open AND you genuinely cannot advance without operator input: append to .yunomia/questions.json a clear, specific question. Schema: {id, agent_code, body_md, context_ticket?, options?, asked_at}. Use uuidgen + ISO date. The operator sees these in the Questions tab and replies; you'll see the answer next heartbeat.\n- A recently-answered question is in your list above: read the answer and act on it (create the ticket the operator approved, set the rollback delegate they named, etc.). Don't re-ask.\n- A triage ticket has a clear owner: edit tickets.json to assigned/in_progress for the right worker.\n- An orphaned in_progress ticket: reassign or fire on-demand wake. If the assignee is dead and shouldn't be revived, reassign in tickets.json.\n- Genuinely nothing actionable across goals, triage, orphans, and questions: reply "OK" and sleep.\n\nCanonical statuses: triage, assigned, in_progress, in_review, done, released. Don't invent statuses. Don't ask permission for orchestration moves — your file edits ARE the orchestration.\n`;
    } else {
      prompt = `\n\n[Yunomia heartbeat - ${a.code} - ${new Date().toISOString()}] Periodic check. If you have an in_progress ticket assigned to you, resume it. If your queue is empty, reply "OK" and sleep. Don't reply with status descriptions — take action or sleep.\n`;
    }
    try { await writeToAgent(a.code, prompt); console.info(`[heartbeat] ${a.code} fired (${isOrchestrator(a.code) ? `triage=${triage.length} orphan=${orphanInProgress.length}` : 'worker'})`); }
    catch (err) { console.warn(`[heartbeat] write failed for ${a.code}`, err); }
  }
}
