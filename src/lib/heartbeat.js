// Yunomia — per-agent heartbeat config.
//
// Each agent in the project's roster has wakeup_mode = "heartbeat" or
// "on-assignment". Heartbeat agents fire a scheduled wake every
// heartbeat_min minutes if their pty is alive. on-assignment agents only
// wake when a ticket lands on them via mc-bridge.
//
// Layer 0 mechanical safety-net (zero-LLM) still runs alongside.
//
// Layer 0 — mechanical safety-net (zero LLM tokens). Every 30s, walks each
// running pty: if we wrote a wakeup AT_T and the pty produced no stdout in
// the 5 minutes following, re-fire the wakeup prompt. Catches fired-but-
// missed wakeups, crashed-restart races, and pty layer hiccups.
//
// Layer 1 — CEO judgement-required hourly check. Writes a brief heartbeat
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
    console.warn(`[heartbeat-L0] ${code} stalled — re-firing wakeup`);
    rewakeAgent(code, w.ticketHumanId, w.reason || 're-wakeup');
    // Reset the wakeup timestamp so we don't re-fire every 30s.
    wakeups.set(code, { ...w, lastWakeupAt: now });
  }
}

// Per-agent scheduler — only fires for agents whose project_agents.json
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
  for (const a of heartbeatAgents) {
    if (!running.has(a.code)) continue;
    const key = `${cwd}|${a.code}`;
    const last = lastFiredAt.get(key) || 0;
    const intervalMs = Math.max(5, a.heartbeat_min || 60) * 60_000;
    if (now - last < intervalMs) continue;
    lastFiredAt.set(key, now);
    const prompt = `\n\n[Yunomia heartbeat — ${a.code} — ${new Date().toISOString()}] Periodic check. Anything you should be doing? If queue empty, reply OK and go back to sleep.\n`;
    try { await writeToAgent(a.code, prompt); console.info(`[heartbeat] ${a.code} fired`); }
    catch (err) { console.warn(`[heartbeat] write failed for ${a.code}`, err); }
  }
}
