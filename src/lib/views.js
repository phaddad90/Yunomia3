// Activity feed, Inbox, Reports, Agents config - read-only / lightweight views
// rendered into the dashboard sub-tab containers.

import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';

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
// Emoji table: starts with the same preset codes the rest of the UI uses,
// extended with common project-coined codes. Anything outside both is rendered
// with the ⬛ fallback. Projects are free to coin any uppercase code.
const AGENT_EMOJI = {
  LEAD:'🧭', CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠', PETER:'🎩',
  PLANNING:'🗺️', ADS:'📢', SEO:'🔍', CRM:'🤝', MERCHANT:'🛒',
  PRINTKITS:'🎨', DESIGN:'🖌', SALES:'💼', SUPPORT:'🛟', FE:'💠', INT:'🔌',
};
// Optional preset suggestions surfaced in the "+ Add preset" dropdown when the
// project doesn't yet have them. Users can also type any custom code directly
// into the free-text "or new code" input.
const PRESET_CODES = ['LEAD','CEO','SA','AD','WA','DA','QA','WD','TA','FE','INT'];
const MODELS = ['claude-sonnet-4-6','claude-opus-4-7','claude-haiku-4-5-20251001'];
const WAKEUP_MODES = ['heartbeat', 'on-assignment'];

// Notify dropdowns elsewhere in the UI (spawn modal, new-ticket assignee,
// kanban detail) that the roster changed and they should re-pull. Defined as
// a global hook by main.js's applyProjectAgentsToForms.
function notifyRosterChanged() {
  if (typeof window !== 'undefined' && typeof window.__applyProjectAgents === 'function') {
    window.__applyProjectAgents();
  }
}

export async function renderAgentsView(container, cwd) {
  let agents = [];
  try { agents = await invoke('project_agents_list', { args: { cwd } }) || []; } catch { agents = []; }
  const present = new Set(agents.map((a) => a.code));
  const missing = PRESET_CODES.filter((c) => !present.has(c));
  container.innerHTML = `
    <div class="agents-cfg">
      <header>
        <h3>Project agents</h3>
        <div class="agents-add-row">
          ${missing.length ? `<select id="agents-add">
            <option value="">+ Add preset…</option>
            ${missing.map((c) => `<option value="${c}">${AGENT_EMOJI[c]||''} ${c}</option>`).join('')}
          </select>` : ''}
          <input id="agents-add-custom" type="text" maxlength="32" placeholder="Or new code (e.g. PLANNING)" />
          <button id="agents-add-custom-btn" class="btn-secondary" type="button">Add</button>
        </div>
      </header>
      <ul class="agents-list">
        ${agents.map((a) => `<li class="agent-cfg-row" data-code="${a.code}">
          <header>
            <span class="agent-cfg-emoji">${AGENT_EMOJI[a.code]||'⬛'}</span>
            <span class="agent-cfg-code">${escapeHtml(a.code)}</span>
            <button class="btn-ghost agent-cfg-remove" data-code="${escapeHtml(a.code)}">Remove</button>
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
              <input type="number" min="5" max="10080" data-field="heartbeat_min" value="${a.heartbeat_min || 60}" />
            </label>
            <label class="agent-cfg-note">Description <span class="muted">(shows in spawn modal + assignee dropdowns; first sentence used as label)</span>
              <textarea data-field="note" rows="2" placeholder="e.g. Roadmap, calendar, attack-list. Owns docs/STATUS-summary.md.">${escapeHtml(a.note || '')}</textarea>
            </label>
            <details class="agent-files">
              <summary>📄 Kickoff / Goals / Soul (file-backed)</summary>
              <div class="agent-files-tabs">
                <button data-kind="kickoff" class="active">Kickoff</button>
                <button data-kind="goals">Goals</button>
                <button data-kind="soul">Soul</button>
              </div>
              <textarea class="agent-file-textarea" rows="10" data-code="${escapeHtml(a.code)}" data-kind="kickoff" placeholder="Loading…"></textarea>
              <button class="btn-secondary agent-file-save" data-code="${escapeHtml(a.code)}">Save</button>
            </details>
          </div>
        </li>`).join('')}
      </ul>
      ${agents.length === 0 ? `<div class="empty-pad">No agents yet. Use a preset or type a new code above.</div>` : ''}
    </div>
  `;
  // Helper - upsert a freshly-defined agent and re-render.
  const addAgent = async (rawCode) => {
    // Sanitise: uppercase, strip whitespace, allow only A-Z 0-9 _.
    const code = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!code) { alert('Agent code cannot be empty.'); return; }
    if (code.length > 32) { alert('Agent code too long (max 32 chars).'); return; }
    if (present.has(code)) { alert(`Agent ${code} already exists in this project.`); return; }
    await invoke('project_agents_upsert', { args: { cwd, agents: [{
      code, model: 'claude-sonnet-4-6', wakeup_mode: 'on-assignment', heartbeat_min: 60, note: null,
    }] }});
    notifyRosterChanged();
    await renderAgentsView(container, cwd);
  };
  // Add by preset dropdown
  const addSel = container.querySelector('#agents-add');
  if (addSel) addSel.addEventListener('change', async () => {
    if (!addSel.value) return;
    await addAgent(addSel.value);
  });
  // Add by custom-code text input
  const addCustom = container.querySelector('#agents-add-custom');
  const addCustomBtn = container.querySelector('#agents-add-custom-btn');
  const submitCustom = async () => {
    if (!addCustom?.value) return;
    await addAgent(addCustom.value);
  };
  addCustomBtn?.addEventListener('click', submitCustom);
  addCustom?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submitCustom(); } });
  // Per-row handlers
  container.querySelectorAll('.agent-cfg-row').forEach((row) => {
    const code = row.dataset.code;
    row.querySelector('[data-act="remove"], .agent-cfg-remove')?.addEventListener('click', async () => {
      // Tauri ask() instead of native confirm() - WebView2 on Windows
      // intercepts confirm() and routes it through a non-existent
      // dialog.confirm Tauri command, throwing "Command not found".
      const ok = await ask(`Remove ${code} from this project? Tickets assigned to this agent will be left unassigned.`, { title: 'Remove agent' });
      if (!ok) return;
      await invoke('project_agents_remove', { args: { cwd, code } });
      notifyRosterChanged();
      await renderAgentsView(container, cwd);
    });
    // Field-change persistence. Includes the new free-text note textarea so
    // dropdowns elsewhere can show a description next to each agent code.
    const persist = async () => {
      const fields = {};
      row.querySelectorAll('select[data-field], input[data-field], textarea[data-field]').forEach((x) => {
        if (x.tagName === 'TEXTAREA') {
          fields[x.dataset.field] = x.value;
        } else {
          fields[x.dataset.field] = x.type === 'number' ? parseInt(x.value, 10) || 60 : x.value;
        }
      });
      await invoke('project_agents_upsert', { args: { cwd, agents: [{
        code,
        model: fields.model,
        wakeup_mode: fields.wakeup_mode,
        heartbeat_min: fields.heartbeat_min || 60,
        note: fields.note ? fields.note.trim() : null,
      }] }});
      // Toggle heartbeat-min visibility based on mode.
      const hb = row.querySelector('.hb-min');
      if (hb) hb.hidden = fields.wakeup_mode !== 'heartbeat';
      notifyRosterChanged();
    };
    row.querySelectorAll('select[data-field], input[data-field]').forEach((el) => {
      el.addEventListener('change', persist);
    });
    // Note textarea persists on blur (saves keystroke noise) + on Ctrl/Cmd+Enter.
    const noteEl = row.querySelector('textarea[data-field="note"]');
    if (noteEl) {
      noteEl.addEventListener('blur', persist);
      noteEl.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void persist(); }
      });
    }
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
