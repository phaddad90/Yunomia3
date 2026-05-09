// Deploys subtab. List/edit/run deploy targets. Live-streams stdout/stderr
// from a running deploy via Tauri events.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';

const KINDS = ['command', 'ssh', 'rsync', 's3', 'vercel'];
const APPROVALS = [
  { value: 'auto',            label: 'auto (no gate)' },
  { value: 'requires-peter',  label: 'requires PETER' },
  { value: 'requires-qa',     label: 'requires QA verdict on ticket' },
  { value: 'requires-tag',    label: 'requires deploy-approved tag' },
];

export async function renderDeploys(container, cwd) {
  if (!container) return;
  if (!cwd) { container.innerHTML = '<div class="files-empty">Pick a project first.</div>'; return; }
  const [targets, creds] = await Promise.all([
    invoke('deploys_list', { args: { cwd } }).catch(() => []),
    invoke('credentials_list', { args: { cwd } }).catch(() => []),
  ]);
  container.innerHTML = `
    <div class="creds-header">
      <h3>Deploy targets</h3>
      <p class="muted">Each target runs as a shell command in the project root. Approval rules gate the run.</p>
      <button id="dep-new" class="btn-primary" type="button">+ Add target</button>
    </div>
    <div class="deploy-list">
      ${targets.length === 0
        ? '<div class="files-empty">No deploy targets yet.</div>'
        : targets.map(targetCard).join('')}
    </div>
    <div id="dep-runner" class="deploy-runner" hidden>
      <div class="deploy-runner-head">
        <strong id="dep-runner-name"></strong>
        <span id="dep-runner-status" class="muted">running…</span>
        <button class="btn-ghost" type="button" id="dep-runner-close">Close</button>
      </div>
      <pre id="dep-runner-output"></pre>
    </div>
    <div id="dep-modal-host"></div>
  `;
  container.querySelector('#dep-new')?.addEventListener('click', () => openModal(container, cwd, null, creds));
  container.querySelectorAll('.dep-edit').forEach((b) => b.addEventListener('click', () => {
    const t = targets.find((x) => x.id === b.dataset.id);
    openModal(container, cwd, t, creds);
  }));
  container.querySelectorAll('.dep-delete').forEach((b) => b.addEventListener('click', async () => {
    if (!(await ask('Delete this deploy target?', { title: 'Delete deploy target' }))) return;
    await invoke('deploys_delete', { args: { cwd, id: b.dataset.id } });
    renderDeploys(container, cwd);
  }));
  container.querySelectorAll('.dep-run').forEach((b) => b.addEventListener('click', () => runTarget(container, cwd, b.dataset.id, false)));
  container.querySelectorAll('.dep-dryrun').forEach((b) => b.addEventListener('click', () => runTarget(container, cwd, b.dataset.id, true)));
  container.querySelector('#dep-runner-close')?.addEventListener('click', () => {
    container.querySelector('#dep-runner').hidden = true;
  });
}

function targetCard(t) {
  return `
    <div class="deploy-card">
      <div class="deploy-card-head">
        <strong>${esc(t.name)}</strong>
        <span class="badge">${esc(t.kind)}</span>
        <span class="badge approval-${esc(t.approval)}">${esc(t.approval)}</span>
        ${t.cred_name ? `<span class="badge cred-ref">cred: ${esc(t.cred_name)}</span>` : ''}
      </div>
      <pre class="deploy-cmd">${esc(t.command)}</pre>
      ${t.preflight ? `<div class="deploy-pre"><span class="muted">preflight:</span> <code>${esc(t.preflight)}</code></div>` : ''}
      ${t.note ? `<div class="muted">${esc(t.note)}</div>` : ''}
      <div class="deploy-actions">
        <button class="btn-primary dep-run" data-id="${esc(t.id)}" type="button">▶ Run</button>
        <button class="btn-ghost dep-dryrun" data-id="${esc(t.id)}" type="button">Dry-run</button>
        <button class="btn-ghost dep-edit" data-id="${esc(t.id)}" type="button">Edit</button>
        <button class="btn-ghost dep-delete" data-id="${esc(t.id)}" type="button">Delete</button>
      </div>
    </div>
  `;
}

async function runTarget(container, cwd, id, dryRun) {
  const runnerEl = container.querySelector('#dep-runner');
  const out = container.querySelector('#dep-runner-output');
  const status = container.querySelector('#dep-runner-status');
  const nameEl = container.querySelector('#dep-runner-name');
  const card = container.querySelector(`.dep-run[data-id="${id}"]`)?.closest('.deploy-card');
  nameEl.textContent = card?.querySelector('strong')?.textContent || 'deploy';
  out.textContent = '';
  status.textContent = dryRun ? 'dry-run…' : 'running…';
  status.className = '';
  runnerEl.hidden = false;

  let result;
  try {
    result = await invoke('deploys_run', { args: { cwd, targetId: id, actor: 'PETER', dryRun } });
  } catch (e) {
    status.textContent = `blocked: ${e}`;
    status.className = 'error';
    return;
  }
  const runId = result.run_id;
  const offOut = await listen(`deploy://output/${runId}`, (ev) => {
    out.textContent += ev.payload;
    out.scrollTop = out.scrollHeight;
  });
  const offExit = await listen(`deploy://exit/${runId}`, (ev) => {
    const code = ev.payload?.code ?? 'unknown';
    status.textContent = code === 0 ? 'done ✓' : `failed (exit ${code})${ev.payload?.stage ? ` at ${ev.payload.stage}` : ''}`;
    status.className = code === 0 ? 'success' : 'error';
    offOut(); offExit();
  });
}

function openModal(container, cwd, target, creds) {
  const host = container.querySelector('#dep-modal-host');
  const isEdit = !!target;
  host.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal modal-wide">
        <h2>${isEdit ? 'Edit target' : 'New deploy target'}</h2>
        <form id="dep-form">
          <label>Name <input id="df-name" type="text" required value="${esc(target?.name || '')}" placeholder="production-app" /></label>
          <div class="form-row">
            <label>Kind
              <select id="df-kind">${KINDS.map((k) => `<option value="${k}" ${target?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
            </label>
            <label>Approval
              <select id="df-approval">${APPROVALS.map((a) => `<option value="${a.value}" ${target?.approval === a.value ? 'selected' : ''}>${a.label}</option>`).join('')}</select>
            </label>
          </div>
          <label>Command
            <textarea id="df-command" rows="3" required placeholder="rsync -av ./dist/ user@host:/srv/app/">${esc(target?.command || '')}</textarea>
          </label>
          <label>Preflight (optional, blocks deploy if it fails)
            <input id="df-pre" type="text" value="${esc(target?.preflight || '')}" placeholder="npm run test && npm run build" />
          </label>
          <label>Credential (optional, injected as env var)
            <select id="df-cred">
              <option value="">— none —</option>
              ${creds.map((c) => `<option value="${esc(c.name)}" ${target?.cred_name === c.name ? 'selected' : ''}>${esc(c.name)}${c.env_var ? ` → ${esc(c.env_var)}` : ''}</option>`).join('')}
            </select>
          </label>
          <label>Note (optional)
            <input id="df-note" type="text" value="${esc(target?.note || '')}" />
          </label>
          <div class="modal-actions">
            <button type="button" class="btn-ghost" id="df-cancel">Cancel</button>
            <button type="submit" class="btn-primary">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  const close = () => host.innerHTML = '';
  host.querySelector('#df-cancel').addEventListener('click', close);
  host.querySelector('#dep-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      cwd,
      id: target?.id || null,
      name: host.querySelector('#df-name').value.trim(),
      kind: host.querySelector('#df-kind').value,
      command: host.querySelector('#df-command').value.trim(),
      preflight: host.querySelector('#df-pre').value.trim() || null,
      credName: host.querySelector('#df-cred').value || null,
      approval: host.querySelector('#df-approval').value,
      note: host.querySelector('#df-note').value.trim() || null,
    };
    if (!payload.name || !payload.command) { alert('Name and command required.'); return; }
    try { await invoke('deploys_upsert', { args: payload }); }
    catch (err) { alert(`Save failed: ${err}`); return; }
    close();
    renderDeploys(container, cwd);
  });
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
