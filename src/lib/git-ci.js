// Git status + CI status pollers for the topbar badges.
// Cheap: re-fetches when project switches and on a 60 s tick.

import { invoke } from '@tauri-apps/api/core';

let timer = null;

export function startGitCiPolling(getCwd) {
  const tick = async () => {
    const cwd = getCwd();
    if (!cwd) { hideAll(); return; }
    await Promise.all([refreshGit(cwd), refreshCi(cwd)]);
  };
  tick();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 60_000);
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}

export async function refreshGit(cwd) {
  const badge = document.getElementById('git-badge');
  if (!badge) return;
  let s;
  try { s = await invoke('git_status', { args: { cwd } }); }
  catch { hideEl(badge); return; }
  if (!s?.is_repo) { hideEl(badge); return; }
  const parts = [];
  parts.push(`<span class="gb-branch">⎇ ${escapeHtml(s.branch || 'HEAD')}</span>`);
  if (s.dirty) parts.push('<span class="gb-dirty" title="Uncommitted changes">●</span>');
  if (s.ahead) parts.push(`<span class="gb-ahead" title="commits ahead of upstream">↑${s.ahead}</span>`);
  if (s.behind) parts.push(`<span class="gb-behind" title="commits behind upstream">↓${s.behind}</span>`);
  badge.innerHTML = parts.join(' ');
  badge.hidden = false;
}

export async function refreshCi(cwd) {
  const badge = document.getElementById('ci-badge');
  if (!badge) return;
  let r;
  try { r = await invoke('ci_last_run', { args: { cwd } }); }
  catch { hideEl(badge); return; }
  if (!r || r.status === 'unknown') { hideEl(badge); return; }
  let icon = '·', cls = 'ci-unknown', label = r.status;
  if (r.status === 'completed') {
    if (r.conclusion === 'success') { icon = '✓'; cls = 'ci-success'; label = 'pass'; }
    else if (r.conclusion === 'failure') { icon = '✗'; cls = 'ci-failure'; label = 'fail'; }
    else { icon = '○'; cls = 'ci-other'; label = r.conclusion || 'done'; }
  } else if (r.status === 'in_progress') { icon = '◐'; cls = 'ci-running'; label = 'running'; }
  else if (r.status === 'queued') { icon = '◌'; cls = 'ci-running'; label = 'queued'; }
  badge.className = `ci-badge ${cls}`;
  badge.innerHTML = `<span class="ci-icon">${icon}</span> CI ${escapeHtml(label)}`;
  badge.title = r.workflow ? `${r.workflow} — click to open` : 'open in browser';
  badge.hidden = false;
  badge.onclick = () => { if (r.url) invoke('open_path', { args: { path: r.url } }).catch(() => {}); };
}

function hideAll() {
  hideEl(document.getElementById('git-badge'));
  hideEl(document.getElementById('ci-badge'));
}
function hideEl(el) { if (el) { el.hidden = true; el.innerHTML = ''; } }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
