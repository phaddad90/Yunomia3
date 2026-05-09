// Credentials subtab. Lists per-project credential metas (names + types
// only - the value lives in the OS keychain). Add / edit / delete and
// reveal-on-demand.

import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';

const KINDS = ['ssh-key', 'password', 'token', 'env', 'json'];

export async function renderCredentials(container, cwd) {
  if (!container) return;
  if (!cwd) { container.innerHTML = '<div class="files-empty">Pick a project first.</div>'; return; }
  const list = await invoke('credentials_list', { args: { cwd } }).catch((e) => { container.innerHTML = `<div class="file-error">Error: ${esc(e)}</div>`; return null; });
  if (!list) return;
  container.innerHTML = `
    <div class="creds-header">
      <h3>Credentials</h3>
      <p class="muted">Stored in your OS keychain. The list is local; values never sync to disk.</p>
      <button id="cred-new" class="btn-primary" type="button">+ Add credential</button>
    </div>
    <div class="creds-table">
      ${list.length === 0
        ? '<div class="files-empty">No credentials yet.</div>'
        : `
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Env var</th><th>Note</th><th>Actions</th></tr></thead>
            <tbody>${list.map(rowHtml).join('')}</tbody>
          </table>`}
    </div>
    <div id="cred-modal-host"></div>
  `;
  container.querySelector('#cred-new')?.addEventListener('click', () => openModal(container, cwd, null));
  container.querySelectorAll('.cred-edit').forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.name;
    const meta = list.find((c) => c.name === name);
    openModal(container, cwd, meta);
  }));
  container.querySelectorAll('.cred-reveal').forEach((b) => b.addEventListener('click', async () => {
    const name = b.dataset.name;
    try {
      const value = await invoke('credentials_reveal', { args: { cwd, name } });
      const cell = b.closest('tr').querySelector('.cred-value');
      if (cell.dataset.shown === '1') {
        cell.textContent = '••••••••';
        cell.dataset.shown = '0';
        b.textContent = 'Show';
      } else {
        cell.textContent = value;
        cell.dataset.shown = '1';
        b.textContent = 'Hide';
      }
    } catch (e) { alert(`Reveal failed: ${e}`); }
  }));
  container.querySelectorAll('.cred-delete').forEach((b) => b.addEventListener('click', async () => {
    const name = b.dataset.name;
    if (!(await ask(`Delete credential "${name}"? This removes it from the keychain too.`, { title: 'Delete credential' }))) return;
    try { await invoke('credentials_delete', { args: { cwd, name } }); }
    catch (e) { alert(`Delete failed: ${e}`); return; }
    renderCredentials(container, cwd);
  }));
}

function rowHtml(c) {
  return `
    <tr data-name="${esc(c.name)}">
      <td><code>${esc(c.name)}</code></td>
      <td>${esc(c.kind)}</td>
      <td>${c.env_var ? `<code>${esc(c.env_var)}</code>` : '<span class="muted">—</span>'}</td>
      <td>${c.note ? esc(c.note) : '<span class="muted">—</span>'}</td>
      <td class="cred-actions">
        <span class="cred-value muted" data-shown="0">••••••••</span>
        <button class="btn-ghost cred-reveal" data-name="${esc(c.name)}" type="button">Show</button>
        <button class="btn-ghost cred-edit" data-name="${esc(c.name)}" type="button">Edit</button>
        <button class="btn-ghost cred-delete" data-name="${esc(c.name)}" type="button">Delete</button>
      </td>
    </tr>
  `;
}

function openModal(container, cwd, meta) {
  const host = container.querySelector('#cred-modal-host');
  const isEdit = !!meta;
  host.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h2>${isEdit ? 'Edit credential' : 'New credential'}</h2>
        <form id="cred-form">
          <label>Name <input id="cf-name" type="text" required value="${esc(meta?.name || '')}" ${isEdit ? 'readonly' : ''} placeholder="prod-ssh-key" /></label>
          <label>Type
            <select id="cf-kind">${KINDS.map((k) => `<option value="${k}" ${meta?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
          </label>
          <label>Env var (optional, used when target injects this cred)
            <input id="cf-env" type="text" value="${esc(meta?.env_var || '')}" placeholder="DEPLOY_KEY" />
          </label>
          <label>Value
            <textarea id="cf-value" rows="5" placeholder="${isEdit ? '(leave empty to keep current)' : 'paste here'}"></textarea>
          </label>
          <label>Note (optional)
            <input id="cf-note" type="text" value="${esc(meta?.note || '')}" />
          </label>
          <div class="modal-actions">
            <button type="button" class="btn-ghost" id="cf-cancel">Cancel</button>
            <button type="submit" class="btn-primary">${isEdit ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  const close = () => host.innerHTML = '';
  host.querySelector('#cf-cancel').addEventListener('click', close);
  host.querySelector('#cred-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = host.querySelector('#cf-name').value.trim();
    const kind = host.querySelector('#cf-kind').value;
    const envVar = host.querySelector('#cf-env').value.trim() || null;
    const value = host.querySelector('#cf-value').value;
    const note = host.querySelector('#cf-note').value.trim() || null;
    if (!name) { alert('Name required.'); return; }
    if (!isEdit && !value) { alert('Value required for new credentials.'); return; }
    try {
      // For edit with empty value, fetch current then re-write so the meta
      // updates without changing the secret. Simpler than a separate "edit
      // meta only" path.
      let actualValue = value;
      if (isEdit && !value) {
        actualValue = await invoke('credentials_reveal', { args: { cwd, name, reader: 'PETER' } });
      }
      await invoke('credentials_upsert', { args: { cwd, name, kind, value: actualValue, envVar, note } });
    } catch (err) { alert(`Save failed: ${err}`); return; }
    close();
    renderCredentials(container, cwd);
  });
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
