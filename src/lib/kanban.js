// Yunomia - native vanilla-JS kanban for the dashboard tab.
//
// Reads tickets/comments via Tauri commands backed by file storage at
// ~/.yunomia/projects/<sanitised-cwd>/. No external server. No iframe.
// Driven by `state.selectedProject` from main.js.

import { invoke } from '@tauri-apps/api/core';
import { noteTaskBoundary } from './compact-orchestrator.js';
import { openLessonModal } from './lessons.js';

const COLUMNS = [
  { id: 'backlog',     label: 'Backlog' },
  { id: 'triage',      label: 'Triage' },
  { id: 'assigned',    label: 'Assigned' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review',   label: 'In Review' },
  { id: 'done',        label: 'Done' },
  { id: 'released',    label: 'Released' },
];

const AGENT_EMOJI = { CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠', PETER:'🎩' };

const k = {
  cwd: '',
  tickets: [],
  selected: null,         // selected ticket id
  comments: [],
  schedules: {},          // ticket_id → schedule entry
  filters: { q: '', assignee: '', type: '', due: '' },
  onWakeup: null,         // callback fired when a transition routes work to a running pty
  onTicketCreate: null,   // optional hook for ticket creation
};

// Public API
export function initKanban({ cwd, onWakeup }) {
  k.cwd = cwd;
  k.onWakeup = onWakeup || null;
  bindUi();
  void refresh();
}

export async function setKanbanProject(cwd) {
  k.cwd = cwd;
  k.selected = null;
  await refresh();
}

// Stats for badges on Dashboard tab + agent rail.
export function getTicketStats() {
  const open = k.tickets.filter((t) => !['done','released'].includes(t.status));
  const byAgent = {};
  for (const t of open) {
    const a = t.assignee_agent || '__unassigned';
    byAgent[a] = (byAgent[a] || 0) + 1;
  }
  return { totalOpen: open.length, byAgent };
}

export async function refresh() {
  if (!k.cwd) {
    renderEmpty('Pick a project (top bar) to see its kanban.');
    return;
  }
  try {
    k.tickets = await invoke('tickets_list', { args: { cwd: k.cwd } });
  } catch (err) {
    console.warn('tickets_list', err);
    k.tickets = [];
  }
  try {
    const schedList = await invoke('schedules_list', { args: { cwd: k.cwd } }) || [];
    k.schedules = {};
    for (const s of schedList) k.schedules[s.ticket_id] = s;
  } catch { k.schedules = {}; }
  render();
}

export function setFilter(key, val) {
  k.filters[key] = val;
  render();
}

function ticketMatchesFilters(t) {
  const f = k.filters;
  if (f.q) {
    const hay = `${t.title} ${t.body_md || ''} ${t.human_id}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  if (f.assignee && t.assignee_agent !== f.assignee) return false;
  if (f.type && t.type !== f.type) return false;
  if (f.due) {
    const sched = k.schedules?.[t.id];
    if (!sched) return false;
    const when = new Date(sched.scheduled_for).getTime();
    const now  = Date.now();
    const endOfToday = (() => { const d = new Date(); d.setHours(23,59,59,999); return d.getTime(); })();
    const endOfWeek = (() => { const d = new Date(); const day = d.getDay(); d.setDate(d.getDate() + ((7 - day) % 7)); d.setHours(23,59,59,999); return d.getTime(); })();
    if (f.due === 'overdue' && when > now) return false;
    if (f.due === 'today' && when > endOfToday) return false;
    if (f.due === 'week' && when > endOfWeek) return false;
  }
  return true;
}

// Internal
function $(s, root = document) { return root.querySelector(s); }
function $$(s, root = document) { return Array.from(root.querySelectorAll(s)); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function render() {
  const root = $('#kanban-root');
  if (!root) return;
  if (!k.tickets.length) {
    renderEmpty(`<div class="k-empty-h">Nothing here yet</div>
      <div class="k-empty-sub">Lead's proposed tickets land here after you approve, or use the form on the right to file one manually.</div>`);
    return;
  }
  const filtered = k.tickets.filter(ticketMatchesFilters);
  const cols = COLUMNS.map((c) => {
    const cards = filtered.filter((t) => t.status === c.id);
    return `
      <div class="k-col" data-col="${c.id}">
        <div class="k-col-head"><span>${c.label}</span><span class="k-count">${cards.length}</span></div>
        <div class="k-col-body">${cards.map(renderCard).join('') || '<div class="k-col-empty">·</div>'}</div>
      </div>
    `;
  }).join('');
  root.innerHTML = `<div class="kanban">${cols}</div>`;
  $$('#kanban-root .k-card').forEach((el) => el.addEventListener('click', () => openTicket(el.dataset.id)));
}

function renderEmpty(msg) {
  const root = $('#kanban-root');
  if (!root) return;
  root.innerHTML = `<div class="kanban-empty">${msg}</div>`;
}

function renderCard(t) {
  const ag = t.assignee_agent ? `${AGENT_EMOJI[t.assignee_agent] || ''} ${escapeHtml(t.assignee_agent)}` : '<span class="k-unassigned">unassigned</span>';
  const sched = k.schedules?.[t.id];
  const schedBadge = sched ? scheduleBadgeHtml(sched) : '';
  return `
    <div class="k-card" data-id="${escapeHtml(t.id)}">
      <div class="k-card-head">
        <span class="k-id">${escapeHtml(t.human_id)}</span>
        <span class="k-assignee">${ag}</span>
      </div>
      <div class="k-card-title">${escapeHtml(t.title)}</div>
      <div class="k-card-foot">
        <span class="k-pill k-pill-${t.audience}">${escapeHtml(t.audience)}</span>
        <span class="k-pill k-pill-${t.type}">${escapeHtml(t.type)}</span>
        ${schedBadge}
      </div>
    </div>
  `;
}

function scheduleBadgeHtml(s) {
  const when = new Date(s.scheduled_for);
  const overdue = when.getTime() <= Date.now();
  const cls = overdue ? 'sched-badge overdue' : 'sched-badge';
  return `<span class="${cls}" title="Scheduled ${escapeHtml(s.scheduled_for)}">🔔 ${formatRel(when)}</span>`;
}
function formatRel(when) {
  const ms = when.getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs/60000), h = Math.round(abs/3600000), d = Math.round(abs/86400000);
  if (ms <= 0) return m < 60 ? `${m}m overdue` : h < 48 ? `${h}h overdue` : `${d}d overdue`;
  return m < 60 ? `in ${m}m` : h < 48 ? `in ${h}h` : `in ${d}d`;
}

function toLocalDt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function projectLabel(p) {
  if (!p) return '?';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

// Side panel
async function openTicket(id) {
  const t = k.tickets.find((x) => x.id === id);
  if (!t) return;
  k.selected = id;
  try {
    k.comments = await invoke('comments_list', { args: { cwd: k.cwd, ticketId: id } });
  } catch { k.comments = []; }
  renderSide(t);
  $('#k-side').classList.remove('hidden');
}

function closeSide() {
  $('#k-side').classList.add('hidden');
  k.selected = null;
}

function renderSide(t) {
  const types = ['bug','feature','doc','gate','migration','ops'].map((v) => `<option value="${v}"${v===t.type?' selected':''}>${v}</option>`).join('');
  const auds = ['app','admin'].map((v) => `<option value="${v}"${v===t.audience?' selected':''}>${v}</option>`).join('');
  const stats = COLUMNS.map((c) => `<option value="${c.id}"${c.id===t.status?' selected':''}>${c.label}</option>`).join('');
  const agents = ['', 'CEO','SA','AD','WA','DA','QA','WD','TA','PETER'].map((a) => `<option value="${a}"${a===(t.assignee_agent||'')?' selected':''}>${a ? `${AGENT_EMOJI[a]||''} ${a}` : '- unassigned'}</option>`).join('');
  const commentsHtml = k.comments
    .slice()
    .sort((a, b) => (a.created_at||'').localeCompare(b.created_at||''))
    .map((c) => `<div class="k-comment"><div class="k-comment-who">${escapeHtml(c.author_label)} · ${escapeHtml(c.created_at)}</div><div class="k-comment-body">${escapeHtml(c.body_md)}</div></div>`)
    .join('');
  $('#k-side').innerHTML = `
    <header>
      <button class="btn-ghost" id="k-side-close">✕</button>
      <span class="k-side-id">${escapeHtml(t.human_id)}</span>
      <select id="k-side-status" class="k-side-status">${stats}</select>
    </header>
    <div class="k-side-body">
      <h2 id="k-side-title" title="Click to edit">${escapeHtml(t.title)}</h2>
      <div class="k-side-meta">
        <select id="k-side-assignee">${agents}</select>
        <select id="k-side-audience">${auds}</select>
        <select id="k-side-type">${types}</select>
      </div>
      <div class="k-side-body-row">
        <pre id="k-side-bodypre">${escapeHtml(t.body_md)}</pre>
        <button class="btn-ghost k-side-bodyedit" id="k-side-bodyedit" type="button" title="Edit body">✏</button>
      </div>
      <h4>Scheduled for</h4>
      <div class="k-side-sched">
        <input type="datetime-local" id="k-side-sched-input" value="${k.schedules?.[t.id] ? toLocalDt(k.schedules[t.id].scheduled_for) : ''}" />
        <button class="btn-secondary" id="k-side-sched-save" type="button">Save</button>
        <button class="btn-ghost" id="k-side-sched-clear" type="button" ${k.schedules?.[t.id] ? '' : 'disabled'}>Clear</button>
      </div>
      <h4>Comments (${k.comments.length})</h4>
      <div class="k-comments">${commentsHtml || '<div class="k-comments-empty">No comments yet.</div>'}</div>
      <form id="k-comment-form" class="k-comment-form">
        <textarea id="k-comment-body" rows="3" placeholder="Add a comment…"></textarea>
        <div class="k-comment-form-row">
          <input id="k-comment-author" type="text" value="🎩 PETER" />
          <button class="btn-primary" type="submit">Comment</button>
        </div>
      </form>
    </div>
    <footer class="k-side-actions">
      <button id="k-side-start" class="btn-secondary">Start</button>
      <button id="k-side-handoff" class="btn-secondary">Handoff</button>
      <button id="k-side-done" class="btn-secondary">Done</button>
    </footer>
  `;
  $('#k-side-close').addEventListener('click', closeSide);
  $('#k-side-status').addEventListener('change', (e) => patchAndPing(t.id, { status: e.target.value }));
  $('#k-side-assignee').addEventListener('change', (e) => patchAndPing(t.id, { assignee_agent: e.target.value || null }));
  $('#k-side-audience').addEventListener('change', (e) => patchAndPing(t.id, { audience: e.target.value }));
  $('#k-side-type').addEventListener('change', (e) => patchAndPing(t.id, { type: e.target.value }));
  $('#k-side-title').addEventListener('click', () => editTitleInline(t));
  $('#k-side-bodyedit').addEventListener('click', () => editBodyInline(t));
  $('#k-side-start').addEventListener('click', () => transition(t.id, 'start'));
  $('#k-side-handoff').addEventListener('click', () => transition(t.id, 'handoff'));
  // Compliance UI: read eligible_actions and gate the buttons.
  void applyEligibility(t.id);
  $('#k-side-done').addEventListener('click', async () => {
    if (!confirm(`Mark ${t.human_id} as done?`)) return;
    const res = await transition(t.id, 'done');
    // Bug-close hook: if this was a bug ticket, prompt to capture a Lesson.
    if (res && res.type === 'bug') {
      setTimeout(() => {
        if (confirm(`${res.human_id} closed. Capture a Bug Lesson?`)) {
          openLessonModal({ ticket: res });
        }
      }, 200);
    }
  });
  // Schedule picker
  const schedInput = $('#k-side-sched-input');
  const schedSave  = $('#k-side-sched-save');
  const schedClear = $('#k-side-sched-clear');
  if (schedInput && schedSave && schedClear) {
    schedSave.addEventListener('click', async () => {
      const v = schedInput.value;
      if (!v) return;
      const when = new Date(v);
      try {
        await invoke('schedules_set', { args: { cwd: k.cwd, ticketId: t.id, scheduledFor: when.toISOString(), setBy: 'PETER' } });
        await refresh();
        if (k.selected === t.id) await openTicket(t.id);
      } catch (err) { alert('Schedule failed: ' + (err?.message || err)); }
    });
    schedClear.addEventListener('click', async () => {
      try {
        await invoke('schedules_clear', { args: { cwd: k.cwd, ticketId: t.id } });
        await refresh();
        if (k.selected === t.id) await openTicket(t.id);
      } catch (err) { alert('Clear failed: ' + (err?.message || err)); }
    });
  }
  $('#k-comment-form').addEventListener('submit', (e) => { e.preventDefault(); submitComment(t.id); });
}

async function patchAndPing(id, fields) {
  try {
    const updated = await invoke('tickets_patch', { args: { cwd: k.cwd, id, fields } });
    if (k.onWakeup && updated.assignee_agent && (updated.status === 'assigned' || updated.status === 'in_progress')) {
      k.onWakeup({ agentCode: updated.assignee_agent, ticketHumanId: updated.human_id, reason: 'kanban-update' });
    }
    await refresh();
    if (k.selected === id) await openTicket(id);
  } catch (err) {
    alert('Update failed: ' + (err?.message || err));
  }
}

async function applyEligibility(ticketId) {
  let e;
  try { e = await invoke('eligible_actions', { args: { cwd: k.cwd, id: ticketId } }); }
  catch { return; }
  const apply = (sel, can, reason) => {
    const btn = document.querySelector(sel);
    if (!btn) return;
    btn.disabled = !can;
    btn.title = !can && reason ? reason : '';
    btn.classList.toggle('btn-disabled', !can);
  };
  apply('#k-side-start',   e.can_start,   e.start_reason);
  apply('#k-side-handoff', e.can_handoff, e.handoff_reason);
  apply('#k-side-done',    e.can_done,    e.done_reason);
}

async function transition(id, action) {
  try {
    const updated = await invoke('tickets_transition', { args: { cwd: k.cwd, id, action } });
    if (k.onWakeup && updated.assignee_agent && updated.status === 'in_progress') {
      k.onWakeup({ agentCode: updated.assignee_agent, ticketHumanId: updated.human_id, reason: action });
    }
    if (updated.assignee_agent) {
      noteTaskBoundary({ agentCode: updated.assignee_agent, kind: 'ticket-transition', ticketHumanId: updated.human_id });
    }
    await refresh();
    if (k.selected === id) await openTicket(id);
    return updated;
  } catch (err) {
    alert(action + ' failed: ' + (err?.message || err));
    return null;
  }
}

function editTitleInline(t) {
  const h = $('#k-side-title');
  if (h.dataset.editing === '1') return;
  h.dataset.editing = '1';
  const original = t.title;
  const input = document.createElement('input');
  input.type = 'text'; input.value = original; input.maxLength = 280;
  input.className = 'k-side-title-input';
  h.replaceWith(input);
  input.focus(); input.select();
  const finish = async (commit) => {
    const next = input.value.trim();
    if (commit && next && next !== original) await patchAndPing(t.id, { title: next });
    else if (k.selected === t.id) await openTicket(t.id);
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = original; finish(false); }
  });
}

function editBodyInline(t) {
  const pre = $('#k-side-bodypre');
  if (pre.dataset.editing === '1') return;
  pre.dataset.editing = '1';
  const original = t.body_md || '';
  const wrap = document.createElement('div');
  wrap.className = 'k-body-edit';
  wrap.innerHTML = `
    <textarea class="k-body-textarea" rows="14"></textarea>
    <div class="k-body-actions">
      <button class="btn-secondary" type="button" data-act="save">Save</button>
      <button class="btn-ghost" type="button" data-act="cancel">Cancel</button>
    </div>
  `;
  pre.replaceWith(wrap);
  const ta = wrap.querySelector('textarea'); ta.value = original; ta.focus();
  wrap.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const next = ta.value;
    if (next === original) { await openTicket(t.id); return; }
    await patchAndPing(t.id, { body_md: next });
  });
  wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => openTicket(t.id));
}

async function submitComment(ticketId) {
  const body = $('#k-comment-body').value.trim();
  const author = $('#k-comment-author').value.trim() || 'user';
  if (!body) return;
  try {
    await invoke('comments_create', { args: { cwd: k.cwd, ticketId, bodyMd: body, authorLabel: author } });
    $('#k-comment-body').value = '';
    await openTicket(ticketId);
  } catch (err) {
    alert('Comment failed: ' + (err?.message || err));
  }
}

// "Drop a note" form on the right rail
function bindUi() {
  const form = $('#new-ticket-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!k.cwd) { alert('Pick a project first'); return; }
    const title = $('#nt-title').value.trim() || $('#nt-body').value.split('\n')[0].slice(0, 180).trim();
    const body  = $('#nt-body').value.trim();
    if (!body) return;
    const args = {
      cwd: k.cwd,
      title,
      bodyMd: body,
      type: $('#nt-type').value,
      status: 'triage',
      audience: $('#nt-audience').value,
      assigneeAgent: $('#nt-assignee').value || null,
    };
    try {
      const ticket = await invoke('tickets_create', { args });
      $('#nt-body').value = '';
      $('#nt-title').value = '';
      await refresh();
      if (k.onWakeup && ticket.assignee_agent && (ticket.status === 'assigned' || ticket.status === 'in_progress')) {
        k.onWakeup({ agentCode: ticket.assignee_agent, ticketHumanId: ticket.human_id, reason: 'created' });
      }
    } catch (err) {
      alert('Create failed: ' + (err?.message || err));
    }
  });
}
