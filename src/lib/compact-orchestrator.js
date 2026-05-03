// Yunomia - auto-compact orchestrator.
//
// Two trigger paths per the locked spec:
//   • Hard ceiling at 50%: must compact regardless of task state.
//   • Opportunistic from 30%: fire on the 5 explicit task-boundary events.
//
// Today the per-session token-count signal isn't available (Claude Code hooks
// to write `~/.claude/projects/<proj>/<session>-stats.json` are not yet
// deployed). Until they are, we use a conservative heuristic: count
// task-boundary events per agent and trigger /pre-compact every N events
// (default N=8). The hard-ceiling path is wired but inert until stats arrive.
//
// /pre-compact → wait for sentinel `~/.printpepper/pre-compact-${agent}.done`
// (Rust watcher fires `compact://ready/<agent>` Tauri event) → /compact.

import { listen } from '@tauri-apps/api/event';
import { writeToAgent } from './mc-bridge.js';

const STUB_TRIGGER_EVERY = 8;          // task-boundary events between auto-compacts
const PENDING_TIMEOUT_MS = 5 * 60_000; // 5min fallback per spec

const state = {
  // agentCode → { boundaryCount, pendingPreCompact, pendingTimer, unlistens: [] }
  agents: new Map(),
};

export async function initCompactOrchestrator() {
  // Listen for the Rust watcher's "sentinel appeared" events.
  const unlisten = await listen('compact://ready', async (evt) => {
    const code = evt.payload?.agentCode;
    if (!code) return;
    const ent = state.agents.get(code);
    if (!ent || !ent.pendingPreCompact) return;
    console.info(`[compact] sentinel for ${code} → /compact`);
    clearTimeout(ent.pendingTimer);
    ent.pendingPreCompact = false;
    ent.boundaryCount = 0;
    try {
      await writeToAgent(code, '/compact\n');
    } catch (err) {
      console.warn(`[compact] /compact write failed for ${code}`, err);
    }
  });
  state.globalUnlisten = unlisten;
}

export function shutdownCompactOrchestrator() {
  state.globalUnlisten?.();
  for (const ent of state.agents.values()) {
    clearTimeout(ent.pendingTimer);
  }
  state.agents.clear();
}

// Stats-aware idle auto-compact: when context >= 50% AND agent has been
// idle (no stdout) for >= 30s, fire /pre-compact then /compact. Caller is
// responsible for telling the orchestrator the current context % via
// noteContextPercent.
const lastIdleCheck = new Map();   // agentCode → ms timestamp
export function noteContextPercent(agentCode, percent, isIdle) {
  if (!agentCode) return;
  if (percent < 50) return;
  if (!isIdle) return;
  // Don't fire more than once every 5 min for the same agent.
  const last = lastIdleCheck.get(agentCode) || 0;
  if (Date.now() - last < 5 * 60_000) return;
  if (state.agents.get(agentCode)?.pendingPreCompact) return;
  lastIdleCheck.set(agentCode, Date.now());
  console.info(`[compact] auto-fire for ${agentCode} (context ${percent}%, idle)`);
  void firePreCompact(agentCode);
}

// Called by mc-bridge on each task-boundary event.
export function noteTaskBoundary({ agentCode }) {
  if (!agentCode) return;
  if (!state.agents.has(agentCode)) {
    state.agents.set(agentCode, { boundaryCount: 0, pendingPreCompact: false, pendingTimer: null });
  }
  const ent = state.agents.get(agentCode);
  if (ent.pendingPreCompact) return;       // already mid-compact
  ent.boundaryCount += 1;
  if (ent.boundaryCount >= STUB_TRIGGER_EVERY) {
    void firePreCompact(agentCode);
  }
}

// Manual trigger from UI button (or auto-fire from noteContextPercent).
export async function fireCompact(agentCode) {
  // Send /compact directly (bypasses pre-compact).
  try { await writeToAgent(agentCode, '/compact\n'); }
  catch (err) { console.warn(`[compact] /compact write failed for ${agentCode}`, err); }
}

// Manual trigger from UI button (or from the hard-ceiling stats path
// once hooks are wired). Public so the dashboard / heartbeat can call it.
export async function firePreCompact(agentCode) {
  const ent = state.agents.get(agentCode) || { boundaryCount: 0 };
  if (ent.pendingPreCompact) return;
  ent.pendingPreCompact = true;
  state.agents.set(agentCode, ent);
  console.info(`[compact] /pre-compact for ${agentCode}`);
  try {
    await writeToAgent(agentCode, '/pre-compact\n');
  } catch (err) {
    console.warn(`[compact] /pre-compact write failed for ${agentCode}`, err);
    ent.pendingPreCompact = false;
    return;
  }
  // 5-min fallback per spec. If the agent crashed before writing the sentinel,
  // we time out and reset so manual pre-compact can be retried.
  ent.pendingTimer = setTimeout(() => {
    console.warn(`[compact] sentinel timeout for ${agentCode} - falling back to manual`);
    ent.pendingPreCompact = false;
  }, PENDING_TIMEOUT_MS);
}

export function compactStateFor(agentCode) {
  return state.agents.get(agentCode) || null;
}
