// Bug Lessons — capture + browse, mirrors MC v0.3 BL flow.
//
// Capture is triggered:
//   - Manually via Lessons tab "+ New lesson"
//   - Automatically (bug-close hook) when a type=bug ticket transitions to done.

import { invoke } from '@tauri-apps/api/core';

let cachedCwd = null;

export async function loadLessonsForProject(cwd) {
  cachedCwd = cwd;
  try { return await invoke('lessons_list', { args: { cwd } }) || []; }
  catch { return []; }
}

export async function createLesson(cwd, payload) {
  return invoke('lessons_create', { args: { cwd, ...payload } });
}

export async function deleteLesson(cwd, id) {
  return invoke('lessons_delete', { args: { cwd, id } });
}

export function openLessonModal({ ticket = null, prefill = {} } = {}) {
  const modal = document.getElementById('lesson-modal');
  const title = document.getElementById('lesson-modal-title');
  title.textContent = ticket
    ? `Capture lesson from ${ticket.human_id}`
    : 'New Bug Lesson';
  document.getElementById('lesson-symptom').value   = prefill.symptom || (ticket?.title || '');
  document.getElementById('lesson-severity').value  = prefill.severity || 'medium';
  document.getElementById('lesson-ticket').value    = ticket?.human_id || prefill.ticket_human_id || '';
  document.getElementById('lesson-root').value      = prefill.root_cause || '';
  document.getElementById('lesson-fix').value       = prefill.fix || '';
  document.getElementById('lesson-files').value     = prefill.files_changed || '';
  document.getElementById('lesson-recognise').value = prefill.recognise_pattern || '';
  document.getElementById('lesson-prevent').value   = prefill.prevent_action || '';
  document.getElementById('lesson-tags').value      = (prefill.tags || []).join(', ');
  modal.dataset.ticketId = ticket?.id || '';
  modal.dataset.ticketHumanId = ticket?.human_id || '';
  modal.classList.remove('hidden');
}
function closeLessonModal() { document.getElementById('lesson-modal').classList.add('hidden'); }

export function bindLessonModal(getCwd) {
  document.getElementById('lesson-cancel').addEventListener('click', closeLessonModal);
  document.getElementById('lesson-modal').addEventListener('click', (e) => {
    if (e.target.id === 'lesson-modal') closeLessonModal();
  });
  document.getElementById('lesson-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cwd = getCwd();
    if (!cwd) return;
    const modal = document.getElementById('lesson-modal');
    const tags = document.getElementById('lesson-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await createLesson(cwd, {
        symptom:           document.getElementById('lesson-symptom').value.trim(),
        severity:          document.getElementById('lesson-severity').value,
        ticket_id:         modal.dataset.ticketId || null,
        ticket_human_id:   modal.dataset.ticketHumanId || null,
        root_cause:        document.getElementById('lesson-root').value,
        fix:               document.getElementById('lesson-fix').value,
        files_changed:     document.getElementById('lesson-files').value,
        recognise_pattern: document.getElementById('lesson-recognise').value,
        prevent_action:    document.getElementById('lesson-prevent').value,
        tags,
        created_by: 'PETER',
      });
      closeLessonModal();
      // Re-render Lessons tab if visible.
      if (typeof window.__renderLessons === 'function') window.__renderLessons();
    } catch (err) {
      alert('Failed: ' + (err?.message || err));
    }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

export async function renderLessonsView(container, cwd) {
  const lessons = await loadLessonsForProject(cwd);
  if (!lessons.length) {
    container.innerHTML = `<div class="lessons-empty">
      <h3>No bug lessons yet</h3>
      <p>Captured automatically when a bug ticket → done. Or click below.</p>
      <button class="btn-primary" id="lessons-new">+ New Lesson</button>
    </div>`;
    container.querySelector('#lessons-new').addEventListener('click', () => openLessonModal());
    return;
  }
  const ordered = lessons.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  container.innerHTML = `
    <div class="lessons-toolbar">
      <input id="lessons-search" type="text" placeholder="Search symptom / fix / tags…" />
      <button class="btn-primary" id="lessons-new">+ New Lesson</button>
    </div>
    <ul id="lessons-list" class="lessons-list">${ordered.map(renderLessonRow).join('')}</ul>
  `;
  container.querySelector('#lessons-new').addEventListener('click', () => openLessonModal());
  const search = container.querySelector('#lessons-search');
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    const items = ordered.filter((l) => {
      if (!q) return true;
      const hay = `${l.symptom} ${l.fix} ${l.root_cause} ${l.tags.join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
    container.querySelector('#lessons-list').innerHTML = items.map(renderLessonRow).join('');
  });
}

function renderLessonRow(l) {
  const tags = (l.tags || []).map((t) => `<span class="lesson-tag">${escapeHtml(t)}</span>`).join('');
  const link = l.ticket_human_id ? `<span class="lesson-linked">↪ ${escapeHtml(l.ticket_human_id)}</span>` : '';
  return `<li class="lesson-row">
    <div class="lesson-head">
      <span class="lesson-id">${escapeHtml(l.human_id)}</span>
      <span class="lesson-sev sev-${l.severity}">${escapeHtml(l.severity)}</span>
      ${link}
      <span class="lesson-when">${escapeHtml((l.created_at||'').slice(0,10))}</span>
    </div>
    <div class="lesson-symptom">${escapeHtml(l.symptom)}</div>
    ${l.root_cause ? `<div class="lesson-rc"><b>Root cause</b> ${escapeHtml(l.root_cause)}</div>` : ''}
    ${l.fix ? `<div class="lesson-fix"><b>Fix</b> ${escapeHtml(l.fix)}</div>` : ''}
    ${l.recognise_pattern ? `<div class="lesson-rec"><b>Recognise</b> ${escapeHtml(l.recognise_pattern)}</div>` : ''}
    ${tags ? `<div class="lesson-tags">${tags}</div>` : ''}
  </li>`;
}
