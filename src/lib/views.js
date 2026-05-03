// Activity feed, Inbox, Reports, Agents config - read-only / lightweight views
// rendered into the dashboard sub-tab containers.

import { invoke } from '@tauri-apps/api/core';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtTime(iso) {
  if (!iso) return '?';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// ─── Activity feed ───
export async function renderActivityView(container, cwd) {
  let rows = [];
  try { rows = await invoke('audit_list', { args: { cwd, limit: 200 } }) || []; } catch { rows = []; }
  if (!rows.length) {
    container.innerHTML = `<div class="empty-pad">No activity yet.</div>`;
    return;
  }
  container.innerHTML = `<ul class="activity">${rows.map((r) => `
    <li class="activity-row">
      <span class="activity-time">${escapeHtml(fmtTime(r.created_at))}</span>
      <span class="activity-actor">${escapeHtml(r.actor)}</span>
      <span class="activity-action">${escapeHtml(r.action)}</span>
      <span class="activity-target">${escapeHtml(r.ticket_id || '')}</span>
    </li>`).join('')}</ul>`;
}

// ─── Inbox ───
export async function renderInboxView(container, cwd) {
  let rows = [];
  try { rows = await invoke('inbox_list', { args: { cwd } }) || []; } catch { rows = []; }
  if (!rows.length) {
    container.innerHTML = `<div class="empty-pad">Inbox empty.</div>`;
    return;
  }
  const unprocessed = rows.filter((r) => !r.processed).length;
  container.innerHTML = `
    <div class="inbox-toolbar">
      <span>${unprocessed} unprocessed / ${rows.length} total</span>
      <button id="inbox-mark-all" class="btn-secondary" type="button">Mark all processed</button>
    </div>
    <ul class="inbox-list">${rows.map((r) => `
      <li class="inbox-row ${r.processed ? 'processed' : ''}">
        <button class="inbox-mark" data-id="${r.id}" title="Mark processed">${r.processed ? '✓' : '○'}</button>
        <span class="inbox-time">${escapeHtml(fmtTime(r.created_at))}</span>
        <span class="inbox-kind kind-${r.kind.replace('.', '-')}">${escapeHtml(r.kind)}</span>
        <span class="inbox-summary">${escapeHtml(r.summary)}</span>
      </li>`).join('')}</ul>`;
  container.querySelector('#inbox-mark-all').addEventListener('click', async () => {
    await invoke('inbox_mark_all', { args: { cwd } });
    await renderInboxView(container, cwd);
    if (typeof window.__refreshInboxBadge === 'function') window.__refreshInboxBadge();
  });
  container.querySelectorAll('.inbox-mark').forEach((b) => {
    b.addEventListener('click', async () => {
      await invoke('inbox_mark_processed', { args: { cwd, id: b.dataset.id } });
      await renderInboxView(container, cwd);
      if (typeof window.__refreshInboxBadge === 'function') window.__refreshInboxBadge();
    });
  });
}

export async function unprocessedInboxCount(cwd) {
  try {
    const rows = await invoke('inbox_list', { args: { cwd } }) || [];
    return rows.filter((r) => !r.processed).length;
  } catch { return 0; }
}

// ─── Reports ───
export async function renderReportsView(container, cwd) {
  let s = null;
  try { s = await invoke('reports_summary', { args: { cwd } }); } catch { s = null; }
  if (!s) { container.innerHTML = `<div class="empty-pad">No data.</div>`; return; }
  const byAgent = Object.entries(s.by_agent || {})
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `<li><b>${escapeHtml(a)}</b> <span class="muted">${n} active</span></li>`)
    .join('');
  container.innerHTML = `
    <div class="reports">
      <h3>Today</h3>
      <ul class="report-stats">
        <li><b>${s.open}</b> open</li>
        <li><b>${s.in_progress}</b> in progress</li>
        <li><b>${s.in_review}</b> in review</li>
        <li><b>${s.done_today}</b> done today</li>
      </ul>
      <h3>By agent (active)</h3>
      <ul class="report-by-agent">${byAgent || '<li class="muted">No active assignments.</li>'}</ul>
    </div>`;
}

// ─── Agents config ───
const AGENT_EMOJI = { LEAD:'🧭', CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠', PETER:'🎩' };
const ALL_CODES = ['LEAD','CEO','SA','AD','WA','DA','QA','WD','TA'];
const MODELS = ['claude-sonnet-4-6','claude-opus-4-7','claude-haiku-4-5-20251001'];
const WAKEUP_MODES = ['heartbeat', 'on-assignment'];

export async function renderAgentsView(container, cwd) {
  let agents = [];
  try { agents = await invoke('project_agents_list', { args: { cwd } }) || []; } catch { agents = []; }
  const present = new Set(agents.map((a) => a.code));
  const missing = ALL_CODES.filter((c) => !present.has(c));
  container.innerHTML = `
    <div class="agents-cfg">
      <header><h3>Project agents</h3>
        ${missing.length ? `<select id="agents-add">
          <option value="">+ Add agent…</option>
          ${missing.map((c) => `<option value="${c}">${AGENT_EMOJI[c]||''} ${c}</option>`).join('')}
        </select>` : ''}
      </header>
      <ul class="agents-list">
        ${agents.map((a) => `<li class="agent-cfg-row" data-code="${a.code}">
          <header>
            <span class="agent-cfg-emoji">${AGENT_EMOJI[a.code]||''}</span>
            <span class="agent-cfg-code">${a.code}</span>
            <button class="btn-ghost agent-cfg-remove" data-code="${a.code}">Remove</button>
          </header>
          <div class="agent-cfg-body">
            <label>Model
              <select data-field="model">
                ${MODELS.map((m) => `<option value="${m}"${m===a.model?' selected':''}>${m}</option>`).join('')}
              </select>
            </label>
            <label>Wakeup mode
              <select data-field="wakeup_mode">
                ${WAKEUP_MODES.map((m) => `<option value="${m}"${m===a.wakeup_mode?' selected':''}>${m}</option>`).join('')}
              </select>
            </label>
            <label class="hb-min" ${a.wakeup_mode==='heartbeat'?'':'hidden'}>Heartbeat (min)
              <input type="number" min="5" max="240" data-field="heartbeat_min" value="${a.heartbeat_min || 60}" />
            </label>
            <details class="agent-files">
              <summary>📄 Kickoff / Goals / Soul (file-backed)</summary>
              <div class="agent-files-tabs">
                <button data-kind="kickoff" class="active">Kickoff</button>
                <button data-kind="goals">Goals</button>
                <button data-kind="soul">Soul</button>
              </div>
              <textarea class="agent-file-textarea" rows="10" data-code="${a.code}" data-kind="kickoff" placeholder="Loading…"></textarea>
              <button class="btn-secondary agent-file-save" data-code="${a.code}">Save</button>
            </details>
          </div>
        </li>`).join('')}
      </ul>
      ${agents.length === 0 ? `<div class="empty-pad">No agents yet. ${missing.length ? 'Use the dropdown above.' : ''}</div>` : ''}
    </div>
  `;
  // Add new agent
  const addSel = container.querySelector('#agents-add');
  if (addSel) addSel.addEventListener('change', async () => {
    if (!addSel.value) return;
    const code = addSel.value;
    await invoke('project_agents_upsert', { args: { cwd, agents: [{
      code, model: 'claude-sonnet-4-6', wakeup_mode: 'on-assignment', heartbeat_min: 60, note: null,
    }] }});
    await renderAgentsView(container, cwd);
  });
  // Per-row handlers
  container.querySelectorAll('.agent-cfg-row').forEach((row) => {
    const code = row.dataset.code;
    row.querySelector('[data-act="remove"], .agent-cfg-remove')?.addEventListener('click', async () => {
      if (!confirm(`Remove ${code} from this project?`)) return;
      await invoke('project_agents_remove', { args: { cwd, code } });
      await renderAgentsView(container, cwd);
    });
    row.querySelectorAll('select[data-field], input[data-field]').forEach((el) => {
      el.addEventListener('change', async () => {
        const fields = {};
        row.querySelectorAll('select[data-field], input[data-field]').forEach((x) => {
          fields[x.dataset.field] = x.type === 'number' ? parseInt(x.value, 10) || 60 : x.value;
        });
        await invoke('project_agents_upsert', { args: { cwd, agents: [{
          code, model: fields.model, wakeup_mode: fields.wakeup_mode, heartbeat_min: fields.heartbeat_min || 60, note: null,
        }] }});
        // Toggle heartbeat-min visibility based on mode.
        const hb = row.querySelector('.hb-min');
        if (hb) hb.hidden = fields.wakeup_mode !== 'heartbeat';
      });
    });
    // Agent files (kickoff/goals/soul) tabs
    const ta = row.querySelector('.agent-file-textarea');
    const loadFile = async (kind) => {
      ta.dataset.kind = kind;
      ta.value = '';
      ta.placeholder = 'Loading…';
      try { ta.value = await invoke('agent_file_get', { args: { cwd, code, kind } }); ta.placeholder = '(empty)'; }
      catch { ta.placeholder = '(failed to load)'; }
    };
    void loadFile('kickoff');
    row.querySelectorAll('.agent-files-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.agent-files-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
        void loadFile(btn.dataset.kind);
      });
    });
    row.querySelector('.agent-file-save').addEventListener('click', async () => {
      try {
        await invoke('agent_file_write', { args: { cwd, code, kind: ta.dataset.kind, markdown: ta.value } });
      } catch (err) { alert('Save failed: ' + (err?.message || err)); }
    });
  });
}
