// File tree view + the OS-default-app open helpers shared by the tree and
// the xterm clickable-link provider. Lazy-loads each directory on click;
// the rust side returns just one level so we never walk a huge tree.

import { invoke } from '@tauri-apps/api/core';

export async function openPath(absPath) {
  try { await invoke('open_path', { args: { path: absPath } }); }
  catch (e) { console.warn('open_path failed', absPath, e); alert(`Couldn't open: ${e}`); }
}

export async function revealPath(absPath) {
  try { await invoke('reveal_path', { args: { path: absPath } }); }
  catch (e) { console.warn('reveal_path failed', absPath, e); alert(`Couldn't reveal: ${e}`); }
}

export async function copyPath(absPath) {
  try { await navigator.clipboard.writeText(absPath); }
  catch (e) { console.warn('clipboard write failed', e); }
}

// One-shot context menu rendered at click coords. Auto-dismisses on outside
// click or Escape. Items: [{ label, action }].
export function showContextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-item';
    btn.textContent = it.label;
    btn.addEventListener('click', () => { menu.remove(); it.action(); });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  // Position; flip if it would go off-screen.
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;
  const dismiss = (ev) => {
    if (ev && menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', dismiss, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') dismiss(); };
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function fileMenuItems(absPath, isDir) {
  return [
    { label: isDir ? 'Open folder' : 'Open with default app', action: () => openPath(absPath) },
    { label: 'Reveal in Finder', action: () => revealPath(absPath) },
    { label: 'Copy path', action: () => copyPath(absPath) },
  ];
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}

export async function renderFileTree(container, cwd) {
  if (!container) return;
  if (!cwd) {
    container.innerHTML = '<div class="files-empty">Pick a project first.</div>';
    return;
  }
  container.innerHTML = `
    <div class="files-header">
      <div class="files-cwd" title="${escapeHtml(cwd)}">${escapeHtml(cwd)}</div>
      <button class="btn-ghost files-refresh" type="button" title="Refresh">↻</button>
    </div>
    <ul class="file-tree" data-rel="" data-depth="0"></ul>
  `;
  const root = container.querySelector('.file-tree');
  await loadInto(root, cwd, '');
  container.querySelector('.files-refresh').addEventListener('click', () => renderFileTree(container, cwd));
}

async function loadInto(ul, cwd, relPath) {
  ul.innerHTML = '<li class="file-row file-loading">Loading…</li>';
  let entries = [];
  try { entries = await invoke('list_dir', { args: { cwd, relPath } }) || []; }
  catch (e) { ul.innerHTML = `<li class="file-row file-error">Error: ${escapeHtml(String(e))}</li>`; return; }
  ul.innerHTML = '';
  if (entries.length === 0) {
    ul.innerHTML = '<li class="file-row file-empty">empty</li>';
    return;
  }
  const depth = parseInt(ul.dataset.depth || '0', 10);
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'file-row' + (e.is_dir ? ' is-dir' : ' is-file');
    li.dataset.path = e.path;
    li.dataset.isDir = e.is_dir ? '1' : '0';
    li.style.paddingLeft = `${depth * 14 + 8}px`;
    li.innerHTML = `
      <span class="file-icon">${e.is_dir ? '▸' : iconFor(e.name)}</span>
      <span class="file-name">${escapeHtml(e.name)}</span>
      ${e.is_dir ? '' : `<span class="file-size">${fmtBytes(e.size)}</span>`}
    `;
    li.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (e.is_dir) {
        // Toggle expansion: if a child <ul> exists below us, collapse;
        // otherwise fetch + insert one.
        const nextRel = relPath ? `${relPath}/${e.name}` : e.name;
        const next = li.nextElementSibling;
        if (next && next.classList.contains('file-tree') && next.dataset.parent === li.dataset.path) {
          next.remove();
          li.querySelector('.file-icon').textContent = '▸';
        } else {
          const childUl = document.createElement('ul');
          childUl.className = 'file-tree';
          childUl.dataset.depth = String(depth + 1);
          childUl.dataset.parent = li.dataset.path;
          li.after(childUl);
          li.querySelector('.file-icon').textContent = '▾';
          await loadInto(childUl, cwd, nextRel);
        }
      } else {
        openPath(e.path);
      }
    });
    li.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showContextMenu(ev.clientX, ev.clientY, fileMenuItems(e.path, e.is_dir));
    });
    ul.appendChild(li);
  }
}

function iconFor(name) {
  const lower = name.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/.test(lower)) return '🖼';
  if (/\.(mp4|mov|webm|mkv)$/.test(lower)) return '🎬';
  if (/\.(mp3|wav|flac|m4a)$/.test(lower)) return '🔊';
  if (/\.(pdf)$/.test(lower)) return '📕';
  if (/\.(html?|md|markdown)$/.test(lower)) return '📄';
  if (/\.(zip|tar|gz|tgz|7z|rar)$/.test(lower)) return '📦';
  if (/\.(json|ya?ml|toml|env)$/.test(lower)) return '⚙';
  return '·';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
