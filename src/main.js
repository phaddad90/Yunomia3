// Yunomia frontend - pane manager + xterm.js mounting per pty.
// Conventions:
//   • Each pty has a stable string id (typically the AGENT code: "CEO", "QA").
//   • Tauri events: `pty://output/<id>` carries stdout/stderr; `pty://exit/<id>` fires on child exit.
//   • Resize event triggers TIOCSWINSZ via `pty_resize` invoke.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { initCompactOrchestrator, noteTaskBoundary, firePreCompact, fireCompact, noteContextPercent } from './lib/compact-orchestrator.js';
import { startHeartbeat, noteWakeupSent, noteStdoutFromAgent } from './lib/heartbeat.js';
import { initKanban, setKanbanProject, startKanbanPoll, reconcileInFlightAssignments } from './lib/kanban.js';
import { loadOnboardingForProject, renderOnboardingView, reopenOnboarding } from './lib/onboarding.js';
import { refresh as refreshKanban, getTicketStats, setFilter as setKanbanFilter } from './lib/kanban.js';
import { renderLessonsView, bindLessonModal } from './lib/lessons.js';
import { renderActivityView, renderInboxView, renderReportsView, renderAgentsView, unprocessedInboxCount, renderGoalsView, renderQuestionsView, unansweredQuestionsCount } from './lib/views.js';
import { renderFileTree, openPath, revealPath, copyPath, showContextMenu } from './lib/files.js';
import { renderCredentials } from './lib/credentials.js';
import { renderDeploys } from './lib/deploys.js';
import { startGitCiPolling, refreshGit, refreshCi } from './lib/git-ci.js';
import { writeToAgent, startMcBridge, setAgentPtyResolver } from './lib/mc-bridge.js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { bootCheckForUpdates, installUpdate } from './lib/updater.js';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Platform detection — settings UI, path placeholders, and any other
// platform-conditional cosmetic strings should branch on this. Functional
// keyboard handlers already accept e.metaKey OR e.ctrlKey so the bindings
// work everywhere; this constant only governs what we *display*.
const IS_MAC = /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';
const PATH_HINT = IS_MAC
  ? '/Users/<you>/Projects/my-project'
  : 'C:\\Users\\<you>\\Projects\\my-project';

// Replace the Mac-only path placeholders that ship in static index.html with
// platform-appropriate hints. Done once at boot; the elements are static so
// no re-application needed.
(function applyPlatformHints() {
  const projPath = document.getElementById('proj-path');
  if (projPath) projPath.placeholder = PATH_HINT;
  const spawnCwd = document.getElementById('spawn-cwd');
  if (spawnCwd) spawnCwd.placeholder = PATH_HINT;
})();

const AGENT_MODELS_DEFAULT = {
  LEAD:'claude-opus-4-7',
  CEO: 'claude-opus-4-7',
  SA:  'claude-sonnet-4-6',
  AD:  'claude-sonnet-4-6',
  WA:  'claude-sonnet-4-6',
  DA:  'claude-sonnet-4-6',
  QA:  'claude-haiku-4-5-20251001',
  WD:  'claude-sonnet-4-6',
  TA:  'claude-opus-4-7',
};


const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

const state = {
  ptys: new Map(),         // key = `${cwd}|${code}` → { term, fit, unlistens, cwd, code, model, temp, lastStdoutAt, lastWriteAt, blockedReason }
  activePane: 'dashboard',
  stickyModels: {},        // PH-134 Phase 2: agent → model, persisted via Rust store
  maxConcurrent: 3,        // PH-134 Phase 3: concurrency limit slider
  tempAgents: new Set(),   // PH-134 Phase 3: agents flagged for auto-dispose after one task
  projects: [],            // PH-134: known project roots, persisted in localStorage
  selectedProject: '',     // current project cwd (drives spawn + resume)
};

// localStorage keys for projects.
const LS_PROJECTS = 'yunomia.projects';
const LS_SELECTED = 'yunomia.selectedProject';
const ADD_PROJECT_VALUE = '__add__';

function loadProjects() {
  try {
    state.projects = JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]');
  } catch { state.projects = []; }
  state.selectedProject = localStorage.getItem(LS_SELECTED) || state.projects[0] || '';
}
function saveProjects() {
  localStorage.setItem(LS_PROJECTS, JSON.stringify(state.projects));
  localStorage.setItem(LS_SELECTED, state.selectedProject || '');
}
function projectLabel(p) {
  // Show last path segment as label. Splits on both `/` and `\` so Windows
  // paths like `C:\app-marketing` resolve to `app-marketing` instead of
  // returning the whole path verbatim.
  if (!p) return '?';
  const parts = p.split(/[\/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
async function renderProjectPicker() {
  const sel = $('#project-picker');
  if (!sel) return;
  sel.innerHTML = '';
  if (!state.projects.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(none - click to add)'; opt.disabled = true; opt.selected = true;
    sel.appendChild(opt);
  } else {
    // Annotate with a 🔴 prefix when phase=onboarding for that project.
    for (const p of state.projects) {
      let prefix = '';
      try {
        const ps = await invoke('project_state_get', { args: { cwd: p } });
        if (ps?.phase !== 'active') prefix = '🔴 ';
      } catch { /* ignore */ }
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = `${prefix}${projectLabel(p)}`;
      opt.title = p;
      if (p === state.selectedProject) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  const addOpt = document.createElement('option');
  addOpt.value = ADD_PROJECT_VALUE; addOpt.textContent = '+ Add project…';
  sel.appendChild(addOpt);
}
function bindProjectPicker() {
  const sel = $('#project-picker');
  sel.addEventListener('change', () => {
    if (sel.value === ADD_PROJECT_VALUE) {
      openAddProjectModal();
      renderProjectPicker();   // restore previous selection visually until modal commits
      return;
    }
    state.selectedProject = sel.value;
    saveProjects();
    void refreshResumeBanner();
    void window.__renderProjectView?.();
    void refreshGit(state.selectedProject);
    void refreshCi(state.selectedProject);
    void window.__applyTaxonomy?.();
  });
}

function openAddProjectModal() {
  const modal = $('#project-modal');
  if (!modal) return;
  $('#proj-name').value = '';
  $('#proj-path').value = '';
  modal.classList.remove('hidden');
  setTimeout(() => $('#proj-path').focus(), 0);
}
function closeAddProjectModal() { $('#project-modal').classList.add('hidden'); }
function bindAddProjectModal() {
  $('#proj-cancel').addEventListener('click', closeAddProjectModal);
  $('#project-modal').addEventListener('click', (e) => { if (e.target.id === 'project-modal') closeAddProjectModal(); });
  $('#proj-browse').addEventListener('click', async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: 'Pick project root' });
      if (!picked) return;
      $('#proj-path').value = String(picked);
      // Default the name from the basename if user hasn't typed one.
      // Split on either separator so Windows paths (C:\foo\bar) and Unix
      // paths (/foo/bar) both yield the basename.
      if (!$('#proj-name').value.trim()) {
        const parts = String(picked).split(/[\/\\]/).filter(Boolean);
        $('#proj-name').value = parts[parts.length - 1] || '';
      }
    } catch (err) {
      console.warn('dialog open failed', err);
    }
  });
  $('#project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = $('#proj-path').value.trim().replace(/[\/\\]+$/, '');
    if (!path) return;
    // Accept Unix absolute paths (start with /) OR Windows absolute paths
    // (drive letter followed by colon then a separator, e.g. C:\foo or D:/bar).
    const isUnixAbs = path.startsWith('/');
    const isWinAbs = /^[A-Za-z]:[\/\\]/.test(path);
    if (!isUnixAbs && !isWinAbs) {
      alert('Use an absolute path. Examples: /Users/me/project (macOS/Linux) or C:\\Users\\me\\project (Windows)');
      return;
    }
    if (!state.projects.includes(path)) state.projects.push(path);
    state.selectedProject = path;
    saveProjects();
    renderProjectPicker();
    closeAddProjectModal();
    // Optional friendly name → write to project_state
    const name = $('#proj-name').value.trim();
    if (name) {
      try { await invoke('project_state_set', { args: { cwd: path, patch: { project_name: name } } }); } catch { /* ignore */ }
    }
    void refreshResumeBanner();
    void window.__renderProjectView?.();
  });
}

function setActivePane(id) {
  state.activePane = id;
  $$('#pane-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === id));
  $$('#panes .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === id));
  const ent = state.ptys.get(id);
  if (ent) {
    // The pane just transitioned from display:none to display:flex - its
    // clientHeight only resolves after layout. Fit at multiple delays so the
    // first paint, the first reflow, and a 250 ms-late paint all converge.
    const f = () => { try { ent.fit.fit(); } catch {} };
    requestAnimationFrame(() => requestAnimationFrame(f));
    setTimeout(f, 100);
    setTimeout(() => {
      f();
      // Focus the composer textarea by default so the user can just start
      // typing. Click on xterm itself focuses the terminal for slash commands.
      try { ent.composer?.focus(); } catch {}
    }, 300);
  }
}

// Show/hide tabs + panes based on currently selected project.
function applyProjectVisibility() {
  const cwd = state.selectedProject;
  $$('#pane-tabs .tab').forEach((t) => {
    if (t.dataset.pane === 'dashboard') return;     // always visible
    t.style.display = (t.dataset.cwd === cwd) ? '' : 'none';
  });
  $$('#panes .pane').forEach((p) => {
    if (p.dataset.pane === 'dashboard') return;
    if (p.dataset.cwd && p.dataset.cwd !== cwd && p.classList.contains('active')) {
      p.classList.remove('active');
      $$('#pane-tabs .tab').forEach((t) => t.classList.remove('active'));
      const dash = $('#pane-tabs .tab[data-pane="dashboard"]');
      const dashPane = $('#panes .pane[data-pane="dashboard"]');
      if (dash) dash.classList.add('active');
      if (dashPane) dashPane.classList.add('active');
      state.activePane = 'dashboard';
    }
  });
}

function bindUi() {
  $$('#pane-tabs .tab').forEach((t) => t.addEventListener('click', () => setActivePane(t.dataset.pane)));
  $('#spawn-agent').addEventListener('click', openSpawnModal);
  $('#spawn-cancel').addEventListener('click', closeSpawnModal);
  $('#spawn-form').addEventListener('submit', (e) => { e.preventDefault(); submitSpawn(); });
  $('#spawn-modal').addEventListener('click', (e) => { if (e.target.id === 'spawn-modal') closeSpawnModal(); });
  window.addEventListener('resize', () => {
    const ent = state.ptys.get(state.activePane);
    if (ent) ent.fit.fit();
  });
}

async function openSpawnModal() {
  // Pre-fill model from sticky persistence per agent code.
  try { state.stickyModels = await invoke('models_get'); } catch { /* ignore */ }
  syncSpawnModelDefault();
  // Pre-fill cwd from the picked project root.
  const cwdInput = $('#spawn-cwd');
  if (cwdInput) cwdInput.value = state.selectedProject || '';
  if (cwdInput) cwdInput.placeholder = state.selectedProject || 'absolute path';
  $('#spawn-code').addEventListener('change', syncSpawnModelDefault, { once: false });
  $('#spawn-modal').classList.remove('hidden');
}
function syncSpawnModelDefault() {
  const code = $('#spawn-code').value;
  const sticky = state.stickyModels?.[code];
  const fallback = AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
  $('#spawn-model').value = sticky || fallback;
}
function closeSpawnModal() { $('#spawn-modal').classList.add('hidden'); }

async function submitSpawn() {
  const code = $('#spawn-code').value;
  const model = $('#spawn-model').value || AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
  const cwd = ($('#spawn-cwd').value || state.selectedProject || '').trim();
  if (!cwd) { alert('Pick a project first (top-bar).'); return; }
  // Auto-add to project list if it's a new path.
  if (!state.projects.includes(cwd)) {
    state.projects.push(cwd);
    state.selectedProject = cwd;
    saveProjects();
    renderProjectPicker();
    void window.__renderProjectView?.();
  }
  const temp = $('#spawn-temp')?.checked || false;
  // PH-134 Phase 3 - concurrency limit guard.
  if (state.ptys.size >= state.maxConcurrent) {
    if (!confirm(`At concurrency limit (${state.maxConcurrent}). Spawn anyway?`)) return;
  }
  closeSpawnModal();
  try {
    await spawnAgent(code, model, cwd, { temp });
  } catch (err) {
    console.error('spawn failed', err);
    alert('Spawn failed: ' + (err?.message || err));
  }
}

// Context-window estimate poller. Runs every 5s for each running pty, stores
// the latest estimate on the pty entry. Tab head, pane overlay, and agent
// rail all read from there.
async function refreshContextStats() {
  for (const [, ent] of state.ptys.entries()) {
    if (ent.exited) continue;
    try {
      // Re-fire agent_session_record on every tick until the agent has a
      // pinned session_id. Agents started under pre-v0.1.33 builds had
      // their initial record silently rejected (camelCase bug), so without
      // this retry LEAD and CEO would both fall back to "newest jsonl in
      // proj_dir" and report identical context %.
      if (!ent.sessionPinned) {
        try {
          const sid = await invoke('agent_session_record', { args: {
            cwd: ent.cwd,
            agentCode: ent.code,
            sessionId: ent.recordedSession || null,
            sinceMs: (ent.spawnedAt || Date.now()) - 5000,
          } });
          if (sid) { ent.sessionPinned = true; ent.recordedSession = sid; }
        } catch { /* claude-code project dir may not exist yet on first tick */ }
      }
      const est = await invoke('agent_context_estimate', { args: { cwd: ent.cwd, agentCode: ent.code, model: ent.model || null } });
      ent.contextEstimate = est || null;
      // Auto-compact at 50% when idle.
      if (est && ent.cwd === state.selectedProject) {
        const status = deriveStatus(ent).state;
        noteContextPercent(ent.code, est.percent, status === 'idle');
      }
    } catch (e) { /* ignore - file probably not there yet */ }
  }
}
setInterval(refreshContextStats, 5000);
setTimeout(refreshContextStats, 1500);   // first reading shortly after boot

function contextChipHtml(est) {
  if (!est) return '';
  const p = est.percent ?? 0;
  const cls = p >= 50 ? 'cw-red' : p >= 30 ? 'cw-amber' : 'cw-green';
  return `<span class="cw-chip ${cls}" title="${est.tokens_estimated.toLocaleString()} tokens (~est) · session ${est.session_id.slice(0,8)}">${p}%</span>`;
}

// Composite key - same agent code can run independently per project.
// Must be Tauri-event-safe: only [A-Za-z0-9_-]. Slashes and pipes break
// the `pty://output/<id>` event channel silently → black-screen pty.
function ptyKey(cwd, code) {
  const safe = String(cwd).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe}__${code}`;
}
function visibleAgents() {
  const out = [];
  for (const [key, ent] of state.ptys.entries()) {
    if (ent.cwd === state.selectedProject) out.push({ key, ent });
  }
  return out;
}

// Spawn one agent in a new pty pane in the given project's cwd.
async function spawnAgent(code, model, cwd, opts = {}) {
  const key = ptyKey(cwd, code);
  if (state.ptys.has(key)) {
    setActivePane(key);
    return;
  }
  // Block until the bundled Nerd Font is ready: xterm measures the cell
  // grid at construction, so if the font hasn't loaded yet xterm uses a
  // fallback font for cell-width measurement and never re-measures, which
  // is what made claude code's box-drawing land on a different grid pitch
  // than the dashes.
  if (document.fonts && !state.nfReady) {
    try { await document.fonts.load('13px "JetBrains Mono NF"'); state.nfReady = true; }
    catch (e) { console.warn('NF font load skipped', e); state.nfReady = true; }
  }
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.pane = key;
  tabBtn.dataset.cwd = cwd;
  tabBtn.dataset.code = code;
  tabBtn.innerHTML = `<span class="tab-emoji">${tabEmoji(code)}</span> ${code} <span class="cw-slot"></span> <span class="tab-close" title="Kill" data-kill="1">×</span>`;
  tabBtn.addEventListener('click', (e) => {
    if (e.target.dataset.kill) { void killPty(key); return; }
    setActivePane(key);
  });
  $('#pane-tabs').appendChild(tabBtn);

  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.dataset.pane = key;
  pane.dataset.cwd = cwd;
  const overlay = document.createElement('div');
  overlay.className = 'pane-overlay';
  overlay.innerHTML = `<span class="pane-overlay-model">${escapeHtml(model)}</span> <span class="pane-overlay-cw"></span>`;
  pane.appendChild(overlay);
  const termWrap = document.createElement('div');
  termWrap.className = 'term-wrap';
  pane.appendChild(termWrap);

  // Composer - VS Code / Claude.ai-style multiline input. Pinned below the
  // terminal. Enter submits the buffer to the pty wrapped in bracketed-paste
  // markers (claude code respects bracketed paste for multiline content);
  // Shift+Enter inserts a newline in the textarea natively. Clicking the
  // terminal still focuses xterm directly so slash commands, Esc, arrow keys
  // still pass through to the TUI.
  const composer = document.createElement('div');
  composer.className = 'composer';
  composer.innerHTML = `
    <textarea class="composer-input" rows="1" placeholder="Message ${escapeHtml(code)}…  (Enter send · Shift+Enter newline · paste / drop images · Esc cancels claude · ↑↓ arrows pass through)"></textarea>
    <button class="composer-dismiss" type="button" title="Dismiss claude menu prompt (sends '0' raw)">0</button>
    <button class="composer-send" type="button" title="Send (Enter)">↵</button>
  `;
  pane.appendChild(composer);
  $('#panes').appendChild(pane);

  const composerInput = composer.querySelector('.composer-input');
  const composerSend = composer.querySelector('.composer-send');
  const composerDismiss = composer.querySelector('.composer-dismiss');
  const autoGrow = () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 180) + 'px';
  };
  const submitComposer = async () => {
    const text = composerInput.value;
    if (!text) return;
    // Prepend an ISO-8601 UTC timestamp so the agent's conversation log
    // captures *when* every user message arrived. Same `[Yunomia <thing> -
    // <iso>]` shape as wake / heartbeat so agents recognise the bracket
    // prefix as Yunomia metadata they can parse if they need to reason
    // about timing (e.g. "the user asked X at 13:45 UTC, then waited 20m
    // before sending Y, so Y is probably a follow-up").
    const ts = new Date().toISOString();
    const stamped = `[Yunomia user - ${ts}] ${text}`;
    // claude code's TUI auto-detects pasted input when bytes arrive in one
    // chunk: it strips the trailing CR from "<text>\r" and parks the text in
    // the input buffer waiting for a real Enter. That's why composer sends
    // were merging on the same line - first send sat in buffer, second send
    // landed on top of it, only the *last* CR after a typing-speed gap fired
    // submit. Fix: write payload, wait past the auto-paste threshold, then
    // send CR alone so the TUI sees it as a real keypress.
    // Multi-line messages still need bracketed paste so embedded newlines
    // become newlines-within-input rather than line-by-line submits.
    const payload = stamped.includes('\n') ? `\x1b[200~${stamped}\x1b[201~` : stamped;
    console.info('[composer]', code, 'submit', text.length, 'chars at', ts, ':', text.slice(0, 80) + (text.length > 80 ? '…' : ''));
    composerInput.value = '';
    autoGrow();
    // Snap viewport to the bottom on send so the user immediately sees
    // claude's response start streaming - xterm's auto-scroll-on-output
    // only fires once new bytes arrive, which can be 1-2s after submit
    // for thinking models.
    try { term.scrollToBottom(); } catch { /* no-op */ }
    try {
      await invoke('pty_write', { args: { id: key, data: payload } });
      await new Promise((r) => setTimeout(r, 150));
      await invoke('pty_write', { args: { id: key, data: '\r' } });
    } catch (e) { console.warn('composer send', e); }
  };
  composerInput.addEventListener('input', autoGrow);
  // Special-key passthrough: claude's TUI uses Esc/Ctrl+C/arrows/Tab. Since
  // xterm.disableStdin is true, the composer is the only path to the pty so
  // we forward these explicitly.
  const sendRaw = (data) => invoke('pty_write', { args: { id: key, data } }).catch(() => {});
  composerInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submitComposer();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (composerInput.value) { composerInput.value = ''; autoGrow(); return; }
      sendRaw('\x1b');                  // cancel claude's current op
      return;
    }
    if (ev.ctrlKey && ev.key === 'c' && !composerInput.selectionStart && !composerInput.selectionEnd) {
      ev.preventDefault();
      sendRaw('\x03');                  // SIGINT-style interrupt
      return;
    }
    if (ev.key === 'Tab' && !composerInput.value) {
      ev.preventDefault();
      sendRaw(ev.shiftKey ? '\x1b[Z' : '\t');
      return;
    }
    // Arrow keys when composer is empty → scroll claude's TUI history /
    // navigate its prompt.
    if (!composerInput.value) {
      if (ev.key === 'ArrowUp')   { ev.preventDefault(); sendRaw('\x1b[A'); return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); sendRaw('\x1b[B'); return; }
    }
  });
  composerSend.addEventListener('click', submitComposer);
  // Dismiss button: send a single raw "0" byte — bypasses bracketed paste so
  // claude's TUI menus (e.g. the post-session rating prompt) treat it as a
  // keypress instead of buffered text. Solves "I can't dismiss the rating
  // overlay because typing into the composer doesn't reach the menu."
  composerDismiss.addEventListener('click', () => {
    invoke('pty_write', { args: { id: key, data: '0' } }).catch(() => {});
  });

  // Image paste: capture clipboard image data, write to disk via Tauri,
  // insert the absolute path into the composer at the caret. When the user
  // submits, claude code receives the path and can ingest it via Read.
  composerInput.addEventListener('paste', async (ev) => {
    const items = ev.clipboardData?.items || [];
    for (const it of items) {
      if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
      ev.preventDefault();
      const file = it.getAsFile();
      if (!file) continue;
      const ext = (it.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      try {
        const path = await saveBlobToClipboard(file, ext);
        insertAtCursor(composerInput, (composerInput.value && !composerInput.value.endsWith('\n') ? '\n' : '') + `@${path}\n`);
        autoGrow();
      } catch (e) { console.warn('image paste save failed', e); }
      return;
    }
  });
  // Drag-drop image: same path.
  composerInput.addEventListener('dragover', (ev) => { ev.preventDefault(); composerInput.classList.add('composer-dropping'); });
  composerInput.addEventListener('dragleave', () => composerInput.classList.remove('composer-dropping'));
  composerInput.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    composerInput.classList.remove('composer-dropping');
    const files = ev.dataTransfer?.files || [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const ext = (f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      try {
        const path = await saveBlobToClipboard(f, ext);
        insertAtCursor(composerInput, (composerInput.value && !composerInput.value.endsWith('\n') ? '\n' : '') + `@${path}\n`);
        autoGrow();
      } catch (e) { console.warn('image drop save failed', e); }
    }
  });

  const term = new Terminal({
    cursorBlink: false,
    fontFamily: '"JetBrains Mono NF", Menlo, "SF Mono", Monaco, "Apple Symbols", "Apple Color Emoji", Consolas, monospace',
    fontSize: 13,
    theme: xtermTheme(),
    convertEol: true,
    scrollback: 10_000,
    // disableStdin: true was used previously to keep keystrokes routed to
    // the composer textarea instead of being captured by xterm. Side effect
    // discovered 2026-05-06 during Windows dogfood: it ALSO blocks xterm's
    // built-in responses to terminal protocol queries (DSR-CPR \x1b[6n,
    // primary device attributes, etc.) that claude's TUI emits and waits
    // on. With disableStdin: true, claude's first \x1b[6n query goes
    // unanswered, claude blocks indefinitely, no echo and no replies.
    // Solution: re-enable stdin so xterm's auto-responder fires, AND
    // filter user keystrokes via attachCustomKeyEventHandler so the
    // composer remains the single user-input path.
    disableStdin: false,
  });
  // Block ALL keyboard events from reaching xterm's input pipeline. Returns
  // false to xterm = "don't process this key, don't fire onData for it".
  // The composer textarea (a separate HTML element) is the user-input path.
  // xterm still emits onData for terminal protocol responses (DSR replies)
  // because those don't go through the keyboard handler — they come from
  // xterm's internal parser responding to escape codes received via
  // term.write().
  term.attachCustomKeyEventHandler(() => false);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termWrap);
  // DOM renderer (xterm 5.x default): measures cells with the configured
  // font but defers per-glyph rendering to the browser, which respects the
  // full font-family fallback chain. Canvas/WebGL renderers were tried
  // first but they cache glyph atlases at construction so PUA chars from
  // claude code's TUI rendered as `?` substitutes even after the Nerd
  // Font loaded.
  // xterm renders a `.xterm-helper-textarea` for IME / clipboard / paste
  // handling. Even with disableStdin: true it still captures keyboard
  // focus (the hidden textarea remains tabbable and click-focusable).
  // That's how v0.1.20 swallowed the user's typing - keystrokes landed
  // in the helper textarea while the composer was the visual focus.
  // Lock it down so xterm can't take focus from anything we render.
  const helperTa = termWrap.querySelector('.xterm-helper-textarea');
  if (helperTa) {
    helperTa.setAttribute('readonly', 'readonly');
    helperTa.setAttribute('tabindex', '-1');
    helperTa.setAttribute('aria-hidden', 'true');
    helperTa.style.pointerEvents = 'none';
  }
  // Use rAF + a small extra delay so the pane's flex layout has settled
  // before fit reads clientWidth/clientHeight. Without this, fit() runs
  // against a 0×0 container and the term never grows.
  requestAnimationFrame(() => requestAnimationFrame(() => { try { fit.fit(); } catch {} }));
  setTimeout(() => { try { fit.fit(); } catch {} }, 200);
  // Watch the container - any resize (window grows, devtools open, sidebar
  // collapses) re-fits the terminal to fill the pane.
  const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
  ro.observe(termWrap);
  // Clickable file paths in claude's output. Match absolute paths
  // (/Users/.., /home/.., /tmp/.., /var/.., C:\..) and bare filenames with
  // common extensions; left-click opens in OS default app, right-click
  // shows the same Open / Reveal / Copy menu the file tree uses.
  registerPathLinkProviders(term, cwd);
  // Don't steal focus on terminal mousedown - that would break click-and-
  // drag text selection in xterm. xterm.disableStdin is true so the
  // terminal can't receive keystrokes anyway; let it handle its own
  // selection + Cmd+C copy. Composer gets focus when explicitly clicked.
  // Mouse-wheel → scroll the terminal's scrollback. xterm normally hooks
  // wheel itself but the flex wrapper can swallow events; explicit listener
  // makes scrollback reliably reachable.
  termWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const linesPerPx = 1 / 16;
    const delta = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) * linesPerPx));
    try { term.scrollLines(delta); } catch {}
  }, { passive: false });

  setActivePane(key);

  // Wait for layout to settle so termWrap has real clientWidth/clientHeight,
  // then fit() so term.cols/rows reflect the actual pane size BEFORE we
  // spawn the pty. If we spawn at default 80x24 and resize after, claude's
  // TUI renders its chrome at the wrong width and leaves stale box-drawing
  // characters until the next keystroke triggers a redraw.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { fit.fit(); } catch {}

  // Stream stdout from the pty into xterm.
  const unlistenOut = await listen(`pty://output/${key}`, (evt) => {
    term.write(evt.payload);
    noteStdoutFromAgent(code);
    const ent = state.ptys.get(key);
    if (ent) ent.lastStdoutAt = Date.now();
    // Debug hook: capture codepoints outside basic ASCII so we can identify
    // which exotic Unicode claude code is emitting on those divider lines.
    // Open DevTools and run window.__yunomiaGlyphs to see frequencies.
    try {
      if (!window.__yunomiaGlyphs) window.__yunomiaGlyphs = {};
      const s = String(evt.payload);
      for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7f && cp !== 0x2026 && cp !== 0x2500 && cp !== 0x2502) {
          const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
          window.__yunomiaGlyphs[hex] = (window.__yunomiaGlyphs[hex] || 0) + 1;
        }
      }
    } catch { /* no-op */ }
  });
  const unlistenExit = await listen(`pty://exit/${key}`, (evt) => {
    const code = evt.payload?.code ?? '?';
    term.writeln(`\r\n\x1b[31m[pty exited code=${code}]\x1b[0m`);
    term.writeln(`\x1b[33mIf this happened immediately, the spawn args were rejected by claude. Check that the 'claude' CLI is on PATH and the --permission-mode flag is supported on this version.\x1b[0m`);
    const ent = state.ptys.get(key);
    if (ent) ent.exited = true;
  });

  // Stdin: forward xterm input.
  term.onData((data) => {
    invoke('pty_write', { args: { id: key, data } }).catch((e) => console.warn('pty_write', e));
    const ent = state.ptys.get(key);
    if (ent) ent.lastWriteAt = Date.now();
  });
  // TIOCSWINSZ on resize.
  term.onResize(({ cols, rows }) => {
    invoke('pty_resize', { args: { id: key, cols, rows } }).catch((e) => console.warn('pty_resize', e));
  });

  state.ptys.set(key, {
    term, fit, ro, unlistens: [unlistenOut, unlistenExit],
    composer: composerInput,
    cwd, code, model, temp: !!opts.temp,
    lastStdoutAt: 0, lastWriteAt: 0, blockedReason: null, exited: false,
    spawnedAt: Date.now(),
  });
  if (opts.temp) state.tempAgents.add(key);

  // Spawn the actual claude process. Args:
  //   --model <model>                 per-agent /model selection
  //   --permission-mode acceptEdits   tiered-allowlist autonomy (internal trust)
  //   (project dir is the cwd; claude infers session there)
  // Crash-recovery resume path uses --resume <session_id>; passed via opts.resume.
  // opts.kickoff = onboarding kickoff prompt - auto-pasted after spawn (Lead path).
  const args = ['--model', model, '--permission-mode', 'acceptEdits'];
  if (opts.resume) args.push('--resume', opts.resume);
  // Spawn the actual claude process with composite key as pty id.
  try {
    const spawnedAt = Date.now();
    await invoke('pty_spawn', {
      args: { id: key, command: 'claude', args, cwd, env: null, cols: term.cols, rows: term.rows },
    });
    // Hand keyboard focus to the composer so the user can just start typing.
    setTimeout(() => { try { composerInput.focus(); } catch {} }, 100);
    // Pin this agent's claude-code session_id so context % is per-agent
    // instead of "newest jsonl in cwd". claude-code creates the JSONL after
    // the first user/system event lands, so wait a few seconds before
    // discovery.
    if (code !== 'LEAD' || true) {
      setTimeout(async () => {
        try {
          await invoke('agent_session_record', { args: { cwd, agentCode: code, sessionId: opts.resume || null, sinceMs: spawnedAt - 5000 } });
        } catch (e) { /* often fires on first spawn before claude-code has written; ok */ }
      }, 5000);
    }
  } catch (e) {
    // Surface the error inside the xterm pane so it's not a silent black box.
    const msg = String(e?.message || e);
    term.writeln(`\x1b[31m[spawn failed]\x1b[0m ${msg}`);
    term.writeln(`\x1b[33mHints:\x1b[0m`);
    term.writeln('  • Is the `claude` CLI on your PATH? Try `which claude` in a normal terminal.');
    term.writeln('  • If --permission-mode is unsupported on this claude version, edit src/main.js');
    term.writeln('    and remove that flag.');
    return;
  }
  // Persist the sticky model so this agent re-spawns with the same one.
  try { await invoke('models_set', { args: { code, model } }); state.stickyModels[code] = model; }
  catch (e) { console.warn('models_set failed', e); }
  // PH-134 onboarding - auto-paste the lead kickoff after pty boot. Two-second
  // delay so claude has finished its TUI splash before we shove the prompt in.
  // Determine kickoff content: explicit opts.kickoff (Lead bootstrap) wins,
  // else read the per-agent kickoff.md from the project. If empty, no paste.
  //
  // When resuming an existing session (--resume flag), claude-code already
  // remembers the kickoff from the prior turn - re-pasting it wastes tokens
  // and confuses the agent into thinking it's a fresh boot.
  let kickoffContent = opts.resume ? '' : (opts.kickoff || '');
  if (!kickoffContent && !opts.resume && code !== 'LEAD') {
    try {
      kickoffContent = await invoke('agent_file_get', { args: { cwd, code, kind: 'kickoff' } }) || '';
    } catch { /* ignore */ }
  }
  if (kickoffContent && kickoffContent.trim()) {
    const ent = state.ptys.get(key);
    if (ent && !ent.kickoffFired) {
      ent.kickoffFired = true;
      setTimeout(async () => {
        try {
          // Explicit bracketed paste: every kickoff is multi-line markdown,
          // so embedded \n must be newlines-within-input, not line-by-line
          // submits. Then a typing-speed gap before the real CR so the TUI
          // doesn't fold the CR into the paste auto-detect window.
          const wrapped = `\x1b[200~${kickoffContent}\x1b[201~`;
          await invoke('pty_write', { args: { id: key, data: wrapped } });
          await new Promise((r) => setTimeout(r, 300));
          await invoke('pty_write', { args: { id: key, data: '\r' } });
        } catch (e) { console.warn('kickoff paste failed', e); }
      }, 2500);
    }
  }
}

// File-path link provider for xterm. Detects:
//   - absolute paths under /Users, /home, /tmp, /var, /opt, /etc
//   - quoted paths inside backticks or single/double quotes
//   - paths with common extensions (.html, .md, .png, .pdf, .json, ...)
// Bare relative paths are resolved against the agent's cwd. Click → OS
// default app; right-click → context menu (Open / Reveal / Copy).
const PATH_RE = /(?:^|[\s'"`(\[<])((?:\/(?:Users|home|tmp|var|opt|etc|private)\/[^\s'"`)\]<>]+)|(?:\.{0,2}\/[^\s'"`)\]<>]+\.[A-Za-z0-9]{1,8})|(?:[A-Za-z][A-Za-z0-9_\-]*(?:\/[A-Za-z0-9_\-.]+)+\.[A-Za-z0-9]{1,8}))/g;

function resolveAgainstCwd(match, cwd) {
  if (match.startsWith('/')) return match;
  if (!cwd) return null;
  if (match.startsWith('./')) return cwd.replace(/\/$/, '') + match.slice(1);
  if (match.startsWith('../')) return null;
  return cwd.replace(/\/$/, '') + '/' + match;
}

function registerPathLinkProviders(term, cwd) {
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(false);
      const links = [];
      let m;
      PATH_RE.lastIndex = 0;
      while ((m = PATH_RE.exec(text)) !== null) {
        const captured = m[1];
        if (!captured) continue;
        const startCol = m.index + (m[0].length - captured.length) + 1;
        const endCol = startCol + captured.length - 1;
        const abs = resolveAgainstCwd(captured, cwd);
        if (!abs) continue;
        links.push({
          range: { start: { x: startCol, y: lineNumber }, end: { x: endCol, y: lineNumber } },
          text: captured,
          activate: () => { void openPath(abs); },
          hover: (_ev, _t) => {},
          leave: () => {},
        });
      }
      callback(links);
    },
  });
  // Right-click in the terminal area → if cursor is on a recognised path,
  // show the open/reveal/copy menu. xterm doesn't expose linkProvider matches
  // via context-menu directly, so we re-scan the line under the click.
  term.element?.addEventListener('contextmenu', (ev) => {
    const rect = term.element.getBoundingClientRect();
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    if (!cell) return;
    const col = Math.floor((ev.clientX - rect.left) / cell.width) + 1;
    const row = Math.floor((ev.clientY - rect.top) / cell.height) + term.buffer.active.viewportY + 1;
    const line = term.buffer.active.getLine(row - 1);
    if (!line) return;
    const text = line.translateToString(false);
    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(text)) !== null) {
      const captured = m[1];
      if (!captured) continue;
      const startCol = m.index + (m[0].length - captured.length) + 1;
      const endCol = startCol + captured.length - 1;
      if (col >= startCol && col <= endCol) {
        const abs = resolveAgainstCwd(captured, cwd);
        if (!abs) return;
        ev.preventDefault();
        showContextMenu(ev.clientX, ev.clientY, [
          { label: 'Open with default app', action: () => openPath(abs) },
          { label: 'Reveal in Finder', action: () => revealPath(abs) },
          { label: 'Copy path', action: () => copyPath(abs) },
        ]);
        return;
      }
    }
  });
}

// PH-134 Phase 2 - wakeup prompt content.
// For an already-running agent (the v3 case), the wakeup is a short ping;
// the agent already loaded their full kickoff at spawn. Spawn-time kickoff
// content can be wired later by reading SaaS Architect/<AGENT>-kickoff.md
// (deferred - not strictly needed for Phase 2 smoke).
function buildWakeupPrompt({ ticketHumanId, reason, isBug }) {
  const ref = ticketHumanId ? ` (${ticketHumanId})` : '';
  const ts = new Date().toISOString();
  const base = `\n\n[Yunomia wakeup - ${reason}${ref} - ${ts}] Check your queue.`;
  // Comment cadence + canonical-status reminder — appended on every wake so
  // older agents (whose kickoff.md predates these sections) still get the
  // rules. Comments live in .yunomia/comments.json; agents must append on
  // start/blocker/handoff/done.
  const commentReminder = `\nReminder: leave a one-line comment in .yunomia/comments.json whenever you start, blocker, hand off, or finish a ticket. Schema is in your kickoff.md. ticket_id is the UUID from tickets.json, not the human_id.\nReminder: ticket status must be one of: triage, assigned, in_progress, in_review, done, released. Do not invent statuses like "open" or "closed" — they get silently dropped from the kanban.`;
  if (!isBug) return base + commentReminder + '\n';
  // Bug-specific enrichment - soul-level directive, restated at wake time.
  return base + commentReminder + `\n\nBUG PROTOCOL - MANDATORY before fix code:\n  1. Open lessons.json for this project. Search for parallels by symptom, files, tags.\n  2. Post an in_progress comment that includes ONE of:\n       Lesson cited: BL-NNN - <how it applies>\n       No matching lessons in N reviewed\n  3. /handoff and /done are blocked by Yunomia's compliance engine until that line exists.\n  4. After fix, write a NEW Bug Lesson via the pending-lessons sentinel (see your kickoff).\n`;
}

async function onWakeup(payload) {
  const { agentCode, ticketHumanId, reason } = payload;
  const cwd = state.selectedProject;
  if (!cwd) {
    console.warn(`[wakeup] no selected project - dropping ${agentCode}/${reason}`);
    return;
  }
  const key = ptyKey(cwd, agentCode);
  console.info(`[wakeup] received ${agentCode} reason=${reason} ticket=${ticketHumanId || '-'} ptyAlive=${state.ptys.has(key)}`);
  // Auto-spawn `on-assignment` agents when work first lands. Without this,
  // CEO's promotion of ERP-001 to INT silently no-op'd because INT wasn't
  // running yet and onWakeup just bailed - the orchestration chain dies
  // at the first hop. Pull the agent's model from project_agents_list so
  // we honour the brief's choice instead of hardcoding sonnet.
  let justSpawned = false;
  if (!state.ptys.has(key)) {
    try {
      const agents = await invoke('project_agents_list', { args: { cwd } }) || [];
      const cfg = agents.find((a) => a.code === agentCode);
      if (!cfg) {
        console.warn(`[wakeup] no project_agents entry for ${agentCode} - cannot auto-spawn`);
        return;
      }
      let resumeId = null;
      try { resumeId = await invoke('agent_session_get', { args: { cwd, agentCode } }); } catch { /* no prior session */ }
      console.info(`[wakeup] auto-spawning ${agentCode} (${cfg.model || 'sonnet'}) for ${ticketHumanId}${resumeId ? ` (resume ${resumeId.slice(0,8)})` : ''}`);
      await spawnAgent(agentCode, cfg.model || 'claude-sonnet-4-6', cwd, resumeId ? { resume: resumeId } : {});
      justSpawned = true;
      // spawnAgent fires the kickoff after a 2.5s pause; let that land
      // before we layer the wakeup prompt on top, otherwise the wakeup
      // gets concatenated into the kickoff paste buffer and submitted
      // as one mega-message.
      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      console.warn(`[wakeup] auto-spawn failed for ${agentCode}`, e);
      return;
    }
  }
  // Look up ticket type to enrich prompt for bugs.
  let isBug = false;
  if (ticketHumanId) {
    try {
      const tickets = await invoke('tickets_list', { args: { cwd } }) || [];
      const t = tickets.find((x) => x.human_id === ticketHumanId);
      if (t && t.type === 'bug') isBug = true;
    } catch { /* ignore */ }
  }
  try {
    // For an already-running agent, claude may be parked on a TUI menu (post-
    // session rating prompt, /resume picker, etc.). Anything we paste while a
    // menu is active gets eaten as menu input, so the wakeup prompt vanishes
    // and the agent stays asleep. Send a single ESC first to dismiss any
    // open menu — harmless when there's no menu (claude treats stray ESC as
    // a no-op at the prompt). Skip on freshly spawned agents because their
    // kickoff is still streaming and ESC could cancel the read.
    if (!justSpawned) {
      try { await invoke('pty_write', { args: { id: key, data: '\x1b' } }); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 80));
    }
    // Wrap in bracketed-paste markers so claude treats embedded \n as
    // newlines-within-input rather than line-by-line submits, then send \r
    // separately after the auto-paste threshold so the TUI sees a real Enter.
    // Without the trailing \r the prompt sat in the input buffer indefinitely
    // — that was the wake-on-assignment "isn't working" symptom.
    const wakeText = buildWakeupPrompt({ ...payload, isBug });
    await invoke('pty_write', { args: { id: key, data: `\x1b[200~${wakeText}\x1b[201~` } });
    await new Promise((r) => setTimeout(r, 150));
    await invoke('pty_write', { args: { id: key, data: '\r' } });
    noteWakeupSent(agentCode, ticketHumanId, reason);
    const ent = state.ptys.get(key);
    if (ent) ent.lastWriteAt = Date.now();
    console.info(`[wakeup] ${key} ← ${reason}${isBug ? ' (BUG)' : ''}${justSpawned ? ' (after spawn)' : ''}`);
  } catch (err) {
    console.warn(`[wakeup] write failed for ${key}`, err);
  }
}

function maybeDisposeTempAgent(agentCode) {
  const key = ptyKey(state.selectedProject, agentCode);
  if (!state.tempAgents.has(key)) return;
  console.info(`[temp-agent] ${key} completed first task - auto-disposing in 30s`);
  state.tempAgents.delete(key);
  setTimeout(() => { void killPty(key); }, 30_000);
}

async function killPty(key) {
  const ent = state.ptys.get(key);
  if (!ent) return;
  try { await invoke('pty_kill', { args: { id: key } }); } catch { /* ignore */ }
  ent.unlistens.forEach((u) => u());
  try { ent.ro?.disconnect(); } catch { /* ignore */ }
  ent.term.dispose();
  state.ptys.delete(key);
  state.tempAgents.delete(key);
  $$('#pane-tabs .tab').forEach((t) => { if (t.dataset.pane === key) t.remove(); });
  $$('#panes .pane').forEach((p) => { if (p.dataset.pane === key) p.remove(); });
  if (state.activePane === key) setActivePane('dashboard');
}

function tabEmoji(code) {
  const e = { LEAD:'🧭', CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠', PETER:'🎩' };
  return e[code] || '⬛';
}

// Project picker - load + render at boot, drives spawn cwd + resume banner.
loadProjects();
renderProjectPicker();
bindProjectPicker();
bindAddProjectModal();
void refreshResumeBanner();

// Status state machine - derived per pty from stdout/write timing + flags.
function deriveStatus(ent) {
  if (!ent || ent.exited) return { state: 'idle', label: 'exited' };
  if (ent.blockedReason) return { state: 'blocked', label: ent.blockedReason };
  const now = Date.now();
  const sinceOut = ent.lastStdoutAt ? now - ent.lastStdoutAt : Infinity;
  const sinceIn  = ent.lastWriteAt  ? now - ent.lastWriteAt  : Infinity;
  if (sinceOut < 3_000) return { state: 'working', label: 'working' };
  if (sinceIn  < 20_000 && sinceOut > sinceIn) return { state: 'waiting', label: 'waiting' };
  if (sinceOut < 30_000) return { state: 'waiting', label: 'thinking' };
  return { state: 'idle', label: 'idle' };
}

// Render the agent rail. Project-scoped - shows ONLY agents that actually
// exist for this project (currently running ptys). No phantom 9-slot fleet.
// New agents arrive via Lead's brief-approval flow OR explicit + Spawn agent.
function renderAgentRail() {
  const root = document.getElementById('agent-rail');
  if (!root) return;
  const cwd = state.selectedProject;
  const running = visibleAgents();      // [{ key, ent }] for this project
  const head = `<div class="ar-head">
    <span>Agents</span>
    <button id="ar-add" class="ar-add" title="Spawn agent">+</button>
  </div>`;
  if (!running.length) {
    root.innerHTML = `${head}<div class="ar-empty">No agents in this project yet. Click <b>+</b> to spawn one - or let the brief's proposed agents auto-populate after approval.</div>`;
  } else {
    let stats;
    try { stats = getTicketStats(); } catch { stats = { byAgent: {} }; }
    const noteByCode = state.agentNoteByCode || {};
    const list = running.map(({ key, ent }) => {
      const code = ent.code;
      const { state: stat, label } = deriveStatus(ent);
      const ticketCount = stats.byAgent[code] || 0;
      const ticketBadge = ticketCount > 0 ? `<span class="ar-tickets" title="${ticketCount} open ticket${ticketCount===1?'':'s'}">${ticketCount}</span>` : '';
      // Full name (first sentence of the agent's `note`) shown alongside the
      // short code so the operator doesn't have to memorise FE / SA / INT.
      // Falls back to just the code when no note exists.
      const fullName = noteByCode[code] || '';
      const codeBlock = fullName
        ? `<span class="ar-code">${code} ${ticketBadge}</span><span class="ar-fullname" title="${escapeHtml(fullName)}">${escapeHtml(fullName)}</span>`
        : `<span class="ar-code">${code} ${ticketBadge}</span>`;
      return `<li class="ar-row ar-${stat}" data-code="${code}" data-key="${key}" title="${escapeHtml(stat)}">
        <span class="ar-emoji">${tabEmoji(code)}</span>
        <div class="ar-mid">
          ${codeBlock}
          <span class="ar-label">${escapeHtml(label)} ${contextChipHtml(ent.contextEstimate)}</span>
          <span class="ar-cmpct-row">
            <button class="ar-cmpct" data-act="precompact" title="Run /pre-compact">PRE</button>
            <button class="ar-cmpct" data-act="compact" title="Run /compact">CMPCT</button>
          </span>
        </div>
        <span class="ar-dot" data-status="${stat}" title="${escapeHtml(stat)}"></span>
        <button class="ar-action" data-act="open" title="Open tab">↗</button>
        <button class="ar-action ar-kill" data-act="kill" title="Kill">✕</button>
      </li>`;
    }).join('');
    root.innerHTML = `${head}<ul class="ar-list">${list}</ul>`;
  }
  root.querySelector('#ar-add')?.addEventListener('click', () => {
    document.getElementById('spawn-agent')?.click();
  });
  root.querySelectorAll('.ar-row').forEach((row) => {
    const key = row.dataset.key;
    row.querySelector('[data-act="open"]')?.addEventListener('click', (e) => { e.stopPropagation(); setActivePane(key); });
    row.querySelector('[data-act="kill"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Kill ${row.dataset.code}?`)) return;
      void killPty(key);
    });
    row.querySelector('[data-act="precompact"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void firePreCompact(row.dataset.code);
    });
    row.querySelector('[data-act="compact"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void fireCompact(row.dataset.code);
    });
  });
}

// Refresh agent rail + tab context-% chips + pane overlay every second.
function statusLoopTick() {
  for (const [key, ent] of state.ptys.entries()) {
    const cwSlot = document.querySelector(`#pane-tabs .tab[data-pane="${CSS.escape(key)}"] .cw-slot`);
    if (cwSlot) cwSlot.innerHTML = contextChipHtml(ent.contextEstimate);
    const overlay = document.querySelector(`#panes .pane[data-pane="${CSS.escape(key)}"] .pane-overlay-cw`);
    if (overlay) overlay.innerHTML = ent.contextEstimate ? `${contextChipHtml(ent.contextEstimate)} <span class="pane-overlay-tok">${ent.contextEstimate.tokens_estimated.toLocaleString()} / 200K tok</span>` : '';
  }
  renderAgentRail();
}
setInterval(statusLoopTick, 1000);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Sub-tab switcher inside Dashboard pane.
function bindSubtabs() {
  document.querySelectorAll('#subtabs .subtab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#subtabs .subtab').forEach((x) => x.classList.toggle('active', x === b));
      const which = b.dataset.sub;
      document.querySelectorAll('.subview').forEach((v) => v.hidden = v.dataset.view !== which);
      // Filters bar only shows on Kanban.
      const filt = document.getElementById('kanban-filters');
      if (filt) filt.hidden = which !== 'kanban';
      // Right rail "new ticket" form only on Kanban.
      const railRight = document.querySelector('.rail-right');
      if (railRight) railRight.hidden = which !== 'kanban';
      void renderSubview(which);
    });
  });
}
async function renderSubview(which) {
  const cwd = state.selectedProject;
  if (!cwd) return;
  if (which === 'kanban')   { /* kanban renders itself via initKanban */ }
  if (which === 'goals')    await renderGoalsView(document.getElementById('goals-root'), cwd);
  if (which === 'questions'){ await renderQuestionsView(document.getElementById('questions-root'), cwd); refreshQuestionsBadge(); }
  if (which === 'activity') await renderActivityView(document.getElementById('activity-root'), cwd);
  if (which === 'inbox')    { await renderInboxView(document.getElementById('inbox-root'), cwd); refreshInboxBadge(); }
  if (which === 'lessons')  await renderLessonsView(document.getElementById('lessons-root'), cwd);
  if (which === 'reports')  await renderReportsView(document.getElementById('reports-root'), cwd);
  if (which === 'agents')   await renderAgentsView(document.getElementById('agents-root'), cwd);
  if (which === 'files')        await renderFileTree(document.getElementById('files-root'), cwd);
  if (which === 'credentials')  await renderCredentials(document.getElementById('credentials-root'), cwd);
  if (which === 'deploys')      await renderDeploys(document.getElementById('deploys-root'), cwd);
}
async function refreshInboxBadge() {
  const cwd = state.selectedProject;
  const badge = document.getElementById('sub-badge-inbox');
  if (!cwd || !badge) return;
  const n = await unprocessedInboxCount(cwd);
  if (n > 0) { badge.hidden = false; badge.textContent = String(n); }
  else { badge.hidden = true; }
}
async function refreshQuestionsBadge() {
  const cwd = state.selectedProject;
  const badge = document.getElementById('sub-badge-questions');
  if (!cwd || !badge) return;
  const n = await unansweredQuestionsCount(cwd);
  if (n > 0) { badge.hidden = false; badge.textContent = String(n); }
  else { badge.hidden = true; }
}
// Poll the open-questions count every 10s so the tab badge stays current
// even when the operator isn't on the Questions tab. Same cadence as the
// inbox badge implicitly is — they're both "human attention required" signals.
setInterval(() => { void refreshQuestionsBadge(); }, 10_000);
window.__refreshInboxBadge = refreshInboxBadge;
window.__renderLessons = () => renderSubview('lessons');
bindSubtabs();
bindLessonModal(() => state.selectedProject);

// Kanban filter wiring.
document.getElementById('filter-q')?.addEventListener('input', (e) => setKanbanFilter('q', e.target.value));
document.getElementById('filter-assignee')?.addEventListener('change', (e) => setKanbanFilter('assignee', e.target.value));
document.getElementById('filter-type')?.addEventListener('change', (e) => setKanbanFilter('type', e.target.value));
document.getElementById('filter-due')?.addEventListener('change', (e) => setKanbanFilter('due', e.target.value));

// Agent proposal poller - Lead writes agent-proposal.json mid-project; we
// surface it as a modal. User approves → ingests, spawns, clears the file.
async function proposalTick() {
  const cwd = state.selectedProject;
  if (!cwd) return;
  if (!document.getElementById('proposal-modal').classList.contains('hidden')) return; // already open
  let p = null;
  try { p = await invoke('agent_proposal_read', { args: { cwd } }); } catch { return; }
  if (!p) return;
  showProposalModal(p);
}
setInterval(proposalTick, 5000);
setTimeout(proposalTick, 1500);

function showProposalModal(p) {
  const modal = document.getElementById('proposal-modal');
  modal.querySelector('.proposal-summary').innerHTML = `
    <div class="proposal-row"><b>Code</b> ${escapeHtml(p.code)}</div>
    <div class="proposal-row"><b>Model</b> ${escapeHtml(p.model || 'claude-sonnet-4-6')}</div>
    <div class="proposal-row"><b>Wakeup</b> ${escapeHtml(p.wakeup_mode || 'on-assignment')}${p.heartbeat_min ? ` · ${p.heartbeat_min} min` : ''}</div>
    <div class="proposal-row"><b>Why</b> ${escapeHtml(p.reason || '(no reason)')}</div>
  `;
  modal.querySelectorAll('.proposal-pre').forEach((el) => {
    el.textContent = p[el.dataset.field] || '(default - Yunomia will fill in)';
  });
  document.getElementById('proposal-approve').onclick = async () => {
    try {
      const agent = await invoke('agent_proposal_approve', { args: { cwd: state.selectedProject, proposal: p } });
      modal.classList.add('hidden');
      // Auto-spawn if heartbeat (orchestrator); else stay dormant until ticket assigned.
      if (agent.wakeup_mode === 'heartbeat') {
        try { await spawnAgent(agent.code, agent.model, state.selectedProject, {}); } catch {}
      }
      void renderProjectView();
    } catch (err) { alert('Approve failed: ' + (err?.message || err)); }
  };
  document.getElementById('proposal-reject').onclick = async () => {
    if (!confirm(`Reject ${p.code} proposal? Lead will need to write a new one.`)) return;
    try { await invoke('agent_proposal_clear', { args: { cwd: state.selectedProject } }); } catch {}
    modal.classList.add('hidden');
  };
  modal.classList.remove('hidden');
}

// Schedule poller - every 30s checks schedules_due_now; appends to inbox + osascript.
async function scheduleTick() {
  const cwd = state.selectedProject;
  if (!cwd) return;
  try {
    const due = await invoke('schedules_due_now', { args: { cwd } }) || [];
    for (const d of due) {
      await invoke('inbox_append', { args: {
        cwd, kind: 'schedule.due',
        ticketHumanId: d.ticket_human_id,
        summary: `${d.ticket_human_id} scheduled time hit - ${d.ticket_title}`,
      }});
    }
    if (due.length) refreshInboxBadge();
  } catch { /* ignore */ }
}
setInterval(scheduleTick, 30_000);
setTimeout(scheduleTick, 3000);

// Pending-lessons poller - agents drop JSON into pending-lessons/, Yunomia
// ingests them via lessons_create + deletes the file. 10 s tick.
async function pendingLessonsTick() {
  const cwd = state.selectedProject;
  if (!cwd) return;
  try {
    const ingested = await invoke('pending_lessons_scan', { args: { cwd } }) || [];
    if (ingested.length) {
      for (const l of ingested) {
        await invoke('inbox_append', { args: {
          cwd, kind: 'bug.lesson',
          ticketHumanId: l.ticket_human_id || null,
          summary: `${l.human_id}: ${l.symptom}`.slice(0, 200),
        }}).catch(() => {});
      }
      refreshInboxBadge();
      // If user is on the Lessons sub-tab, re-render.
      if (typeof window.__renderLessons === 'function') window.__renderLessons();
    }
  } catch { /* ignore */ }
}
setInterval(pendingLessonsTick, 10_000);
setTimeout(pendingLessonsTick, 4000);

// Brief auto-refresh poll - preserves form inputs by only updating the
// brief <pre> content, not re-running the whole render.
setInterval(async () => {
  if (document.getElementById('onboarding-root')?.hidden) return;
  const cwd = state.selectedProject;
  if (!cwd) return;
  try {
    const fresh = await invoke('brief_get', { args: { cwd } });
    const pre = document.querySelector('.onb-brief');
    if (pre && fresh) {
      // Only update if changed - avoids cursor jump if user is selecting text.
      if (pre.textContent !== fresh) pre.textContent = fresh;
    }
  } catch { /* ignore */ }
}, 3000);

// Project view switcher - onboarding (no project, or phase=onboarding) vs
// active (full kanban). Re-renders on project change + after brief approval.
async function renderProjectView() {
  applyProjectVisibility();
  const onbRoot    = document.getElementById('onboarding-root');
  const activeRoot = document.getElementById('dashboard-active');
  const spawnBtn   = document.getElementById('spawn-agent');
  const cwd = state.selectedProject;
  if (!cwd) {
    if (onbRoot)   { onbRoot.hidden = false; onbRoot.innerHTML = `<div class="onb-empty">Pick or add a project (top bar) to begin.</div>`; }
    if (activeRoot) activeRoot.hidden = true;
    if (spawnBtn)   spawnBtn.hidden = true;     // no project → no manual spawn
    return;
  }
  const { state: projState, brief } = await loadOnboardingForProject(cwd);
  if (projState.phase !== 'active') {
    if (activeRoot) activeRoot.hidden = true;
    if (onbRoot)    onbRoot.hidden = false;
    if (spawnBtn)   spawnBtn.hidden = true;     // onboarding spawns Lead via the onb CTA
    const leadKey = ptyKey(cwd, 'LEAD');
    const leadRunning = state.ptys.has(leadKey);
    renderOnboardingView({
      container: onbRoot,
      cwd,
      state: projState,
      brief,
      spawnAgent: (code, model, cwd, opts) => spawnAgent(code, model, cwd, opts),
      onApproved: () => renderProjectView(),
      leadRunning,
    });
  } else {
    if (onbRoot)    onbRoot.hidden = true;
    if (activeRoot) activeRoot.hidden = false;
    if (spawnBtn)   spawnBtn.hidden = false;    // active → manual spawn allowed
    initKanban({
      cwd,
      onWakeup: (payload) => onWakeup(payload),
    });
    startKanbanPoll();
    // Sweep for in-flight assignments after the first tickets_list completes
    // (initKanban kicks off an async refresh). 800ms is enough for the first
    // refresh to land in dev; on slow disks the poller picks them up next tick.
    setTimeout(() => {
      try {
        reconcileInFlightAssignments({
          getRunningAgentCodes: () => Array.from(state.ptys.values())
            .filter((e) => e.cwd === cwd && !e.exited)
            .map((e) => e.code),
        });
      } catch (err) { console.warn('boot reconcile failed', err); }
    }, 800);
    // Auto-resume heartbeat agents (LEAD, CEO, anything declared as
    // wakeup_mode=heartbeat) when the project loads. These are the
    // orchestrators that need to be alive to drive the project; without
    // this the operator had to click + Spawn agent on every app restart.
    //
    // Pass --resume <session_id> when we have one pinned for the agent so
    // claude-code re-loads the prior session instead of fresh-reading
    // kickoff/soul/brief/tickets every restart - that re-read costs ~10k
    // tokens per agent.
    void (async () => {
      try {
        const projectAgents = await invoke('project_agents_list', { args: { cwd } }) || [];
        for (const a of projectAgents) {
          if (a.wakeup_mode !== 'heartbeat') continue;
          const k = ptyKey(cwd, a.code);
          if (state.ptys.has(k)) continue;
          let resumeId = null;
          try { resumeId = await invoke('agent_session_get', { args: { cwd, agentCode: a.code } }); } catch { /* no record yet */ }
          console.info(`[boot] auto-resuming heartbeat agent ${a.code}${resumeId ? ` (resume ${resumeId.slice(0,8)})` : ' (fresh - no session pinned)'}`);
          try { await spawnAgent(a.code, a.model || 'claude-sonnet-4-6', cwd, resumeId ? { resume: resumeId } : {}); }
          catch (e) { console.warn(`[boot] auto-resume failed for ${a.code}`, e); }
        }
      } catch (e) { console.warn('[boot] heartbeat resume sweep failed', e); }
    })();
    // Render brief preview panel above kanban (collapsed by default).
    document.getElementById('brief-name').textContent = projState.project_name || projectLabel(cwd);
    document.getElementById('brief-content').textContent = brief || '(empty - Lead never wrote a brief?)';
    const reopenBtn = document.getElementById('brief-reopen');
    if (reopenBtn && !reopenBtn.dataset.bound) {
      reopenBtn.dataset.bound = '1';
      reopenBtn.addEventListener('click', async () => {
        if (!confirm('Re-open onboarding? Kanban will be hidden until you re-approve the brief.')) return;
        await reopenOnboarding(state.selectedProject);
        await renderProjectView();
      });
    }
    const reingestBtn = document.getElementById('proposals-reingest');
    if (reingestBtn && !reingestBtn.dataset.bound) {
      reingestBtn.dataset.bound = '1';
      reingestBtn.addEventListener('click', async () => {
        const cwdNow = state.selectedProject;
        if (!cwdNow) return;
        let proposals = { tickets: [], agents: [], diagnostics: [] };
        try { proposals = await invoke('proposals_read', { args: { cwd: cwdNow } }); }
        catch (e) { alert(`Couldn't read proposals: ${e}`); return; }
        const diagText = (proposals.diagnostics || []).length
          ? `\n\nIssues:\n  • ${proposals.diagnostics.join('\n  • ')}`
          : '';
        if (!proposals.tickets.length && !proposals.agents.length) {
          alert(`No tickets or agents could be ingested.${diagText}\n\nLead writes proposed-tickets.json / proposed-agents.json to <cwd>/.yunomia/. If Lead claims it wrote tickets, ask it to re-write to that exact path with shape: [{"title": "...", "body_md": "...", "type": "...", "audience": "...", "assignee_agent": "..."}].`);
          return;
        }
        if (!confirm(`Found ${proposals.tickets.length} ticket(s) + ${proposals.agents.length} agent(s) to ingest.${diagText}\n\nContinue?`)) return;
        let createdTickets = 0;
        const ticketErrors = [];
        for (let i = 0; i < proposals.tickets.length; i++) {
          const pt = proposals.tickets[i];
          try {
            await invoke('tickets_create', { args: {
              cwd: cwdNow,
              title: pt.title || '(untitled)',
              bodyMd: pt.body_md || '',
              type: pt.type || 'feature',
              status: 'triage',
              audience: pt.audience || 'admin',
              assigneeAgent: pt.assignee_agent || null,
            }});
            createdTickets += 1;
          } catch (e) {
            const msg = (e && (e.message || e.toString())) || String(e);
            ticketErrors.push(`ticket[${i}] "${(pt.title || '').slice(0,60)}": ${msg}`);
            console.warn('reingest ticket create failed', i, pt.title, e);
          }
        }
        if (proposals.agents.length) {
          const agents = proposals.agents.map((a) => ({
            code: a.code,
            model: a.model || 'claude-sonnet-4-6',
            wakeup_mode: a.wakeup_mode || (a.code === 'LEAD' || a.code === 'CEO' ? 'heartbeat' : 'on-assignment'),
            heartbeat_min: 60,
            note: a.reason || null,
          }));
          try { await invoke('project_agents_upsert', { args: { cwd: cwdNow, agents } }); } catch {}
          let briefText = '';
          try { briefText = await invoke('brief_get', { args: { cwd: cwdNow } }) || ''; } catch {}
          const briefExcerpt = briefText.length > 1500 ? briefText.slice(0, 1500) + '\n\n…' : briefText;
          for (const a of proposals.agents) {
            try {
              await invoke('agent_files_scaffold', { args: {
                cwd: cwdNow, code: a.code,
                role: a.reason || `${a.code} agent`,
                projectName: projState.project_name || projectLabel(cwdNow),
                briefExcerpt,
              }});
            } catch (e) { console.warn('scaffold failed', a.code, e); }
          }
        }
        // Only clear the source proposals files if EVERY ticket was created.
        // Partial success would orphan the un-ingested entries; total failure
        // (the v0.1.30 destructive bug) deleted Lead's only copy and left the
        // user with nothing.
        const allTicketsCreated = createdTickets === proposals.tickets.length;
        if (allTicketsCreated) {
          try { await invoke('proposals_clear', { args: { cwd: cwdNow } }); } catch {}
        }
        const errSection = ticketErrors.length
          ? `\n\nFailed:\n  • ${ticketErrors.slice(0, 10).join('\n  • ')}${ticketErrors.length > 10 ? `\n  …(+${ticketErrors.length - 10} more)` : ''}`
          : '';
        const sourceNote = allTicketsCreated
          ? '\n\nproposed-*.json cleared.'
          : '\n\nproposed-*.json kept so Lead\'s work is not lost. Fix the errors and re-ingest.';
        alert(`Ingested ${createdTickets} of ${proposals.tickets.length} ticket(s) + ${proposals.agents.length} agent(s).${errSection}${sourceNote}`);
        await renderProjectView();
      });
    }
  }
  // Dashboard tab badge: open ticket count for the current project.
  setTimeout(() => {
    try {
      const stats = getTicketStats();
      const tab = document.querySelector('#pane-tabs .tab[data-pane="dashboard"]');
      if (tab) {
        let badge = tab.querySelector('.tab-badge');
        if (stats.totalOpen > 0) {
          if (!badge) { badge = document.createElement('span'); badge.className = 'tab-badge'; tab.appendChild(badge); }
          badge.textContent = String(stats.totalOpen);
        } else if (badge) {
          badge.remove();
        }
      }
    } catch { /* kanban may not be hydrated yet */ }
  }, 200);
}

// Expose so the project picker triggers re-render too.
window.__renderProjectView = renderProjectView;
void renderProjectView();

// ─── Drag-to-resize rails ───
// Saves widths to localStorage; restores on boot. Min 180px, max 50vw.
const LS_RAIL_LEFT  = 'yunomia.railLeftW';
const LS_RAIL_RIGHT = 'yunomia.railRightW';
function applyRailWidths() {
  const left  = parseInt(localStorage.getItem(LS_RAIL_LEFT)  || '240', 10);
  const right = parseInt(localStorage.getItem(LS_RAIL_RIGHT) || '320', 10);
  document.documentElement.style.setProperty('--rail-left-w',  `${left}px`);
  document.documentElement.style.setProperty('--rail-right-w', `${right}px`);
}
applyRailWidths();
function bindResizers() {
  document.querySelectorAll('.resizer').forEach((r) => {
    r.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const side = r.dataset.resize;
      const startX = e.clientX;
      const startLeft  = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rail-left-w'), 10) || 240;
      const startRight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rail-right-w'), 10) || 320;
      document.body.style.cursor = 'col-resize';
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (side === 'left') {
          const next = Math.max(180, Math.min(window.innerWidth * 0.5, startLeft + dx));
          document.documentElement.style.setProperty('--rail-left-w', `${next}px`);
          localStorage.setItem(LS_RAIL_LEFT, String(Math.round(next)));
        } else {
          const next = Math.max(180, Math.min(window.innerWidth * 0.5, startRight - dx));
          document.documentElement.style.setProperty('--rail-right-w', `${next}px`);
          localStorage.setItem(LS_RAIL_RIGHT, String(Math.round(next)));
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}
bindResizers();

// ─── Theme ───
const LS_THEME = 'yunomia.theme';
function applyTheme() {
  const pref = localStorage.getItem(LS_THEME) || 'light';
  let resolved = pref;
  if (pref === 'auto') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = resolved;
  // Re-apply xterm theme to every running pty so the terminal pane follows.
  const t = xtermTheme();
  for (const ent of state.ptys?.values?.() || []) {
    try { ent.term.options.theme = t; } catch { /* xterm v5 API */ }
  }
  // Term-wrap background (the area outside the canvas) too.
  document.querySelectorAll('.pane .term-wrap').forEach((w) => { w.style.background = t.background; });
}

function xtermTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (dark) return {
    background: '#0a0a0b', foreground: '#ededed',
    cursor: '#ff5722', selectionBackground: '#3a1f17',
    black: '#3f3f46', red: '#f87171', green: '#4ade80', yellow: '#facc15',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d8',
    brightBlack: '#71717a', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa',
  };
  return {
    background: '#ffffff', foreground: '#1a1a1a',
    cursor: '#d93a00', selectionBackground: '#ffe4d6',
    black: '#1a1a1a', red: '#d93a00', green: '#16a34a', yellow: '#a16207',
    blue: '#1d4ed8', magenta: '#7e22ce', cyan: '#0891b2', white: '#525252',
    brightBlack: '#525252', brightRed: '#dc2626', brightGreen: '#15803d', brightYellow: '#854d0e',
    brightBlue: '#1e40af', brightMagenta: '#6b21a8', brightCyan: '#0e7490', brightWhite: '#1a1a1a',
  };
}
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem(LS_THEME) || 'light') === 'auto') applyTheme();
});

// ─── Settings modal ───
function bindSettings() {
  const btn   = document.getElementById('settings-btn');
  const modal = document.getElementById('settings-modal');
  if (!btn || !modal) return;
  btn.addEventListener('click', () => openSettings());
  document.getElementById('settings-close').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target.id === 'settings-modal') modal.classList.add('hidden'); });
}
async function openSettings() {
  const modal = document.getElementById('settings-modal');
  // Keyboard shortcuts — render with platform-appropriate modifier so Windows
  // / Linux users see Ctrl-prefixed shortcuts and Mac users see ⌘. Ctrl+Tab
  // is shown literally on every platform because it's the same key on all of
  // them (xterm + window.addEventListener both treat it as ctrlKey).
  const shortcutsTbl = document.getElementById('settings-shortcuts-table');
  if (shortcutsTbl) {
    shortcutsTbl.innerHTML = `
      <tr><td><kbd>${MOD_KEY}T</kbd></td><td>Spawn agent (active phase)</td></tr>
      <tr><td><kbd>${MOD_KEY}W</kbd></td><td>Close current tab</td></tr>
      <tr><td><kbd>${MOD_KEY}1</kbd>–<kbd>${MOD_KEY}9</kbd></td><td>Switch to tab N</td></tr>
      <tr><td><kbd>${MOD_KEY}R</kbd></td><td>Reload Yunomia</td></tr>
      <tr><td><kbd>Ctrl+Tab</kbd> / <kbd>Ctrl+Shift+Tab</kbd></td><td>Cycle agent panes</td></tr>
    `;
  }
  // Theme toggle (icon buttons)
  const pref = localStorage.getItem(LS_THEME) || 'light';
  modal.querySelectorAll('#theme-toggle button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === pref);
    btn.onclick = () => {
      localStorage.setItem(LS_THEME, btn.dataset.theme);
      applyTheme();
      modal.querySelectorAll('#theme-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
    };
  });
  // Max concurrent
  const slider = document.getElementById('settings-max-concurrent');
  const val    = document.getElementById('settings-max-concurrent-val');
  slider.value = String(state.maxConcurrent);
  val.textContent = String(state.maxConcurrent);
  slider.oninput = () => {
    state.maxConcurrent = parseInt(slider.value, 10) || 3;
    val.textContent = String(state.maxConcurrent);
    localStorage.setItem('yunomia.maxConcurrent', String(state.maxConcurrent));
  };
  // App version + Check-for-updates button
  try {
    const v = await getVersion();
    document.getElementById('settings-version').textContent = `Yunomia v${v}`;
  } catch { /* ignore */ }
  const upBtn = document.getElementById('settings-check-updates');
  const upStatus = document.getElementById('settings-update-status');
  if (upBtn && !upBtn.dataset.bound) {
    upBtn.dataset.bound = '1';
    const setStatus = (msg, kind) => {
      if (!upStatus) return;
      upStatus.textContent = msg || '';
      upStatus.className = 'settings-update-status' + (kind ? ' status-' + kind : '');
    };
    const reset = () => { upBtn.disabled = false; upBtn.textContent = 'Check for updates'; };
    const becomeInstall = (update) => {
      upBtn.disabled = false;
      upBtn.textContent = `Install v${update.version} & restart`;
      upBtn.classList.add('btn-primary');
      upBtn.classList.remove('btn-ghost');
      setStatus(`Update available — released ${update.date ? update.date.slice(0, 10) : 'recently'}.`, 'available');
      // Replace the click handler to install instead of re-check.
      const installHandler = async () => {
        upBtn.removeEventListener('click', installHandler);
        upBtn.disabled = true;
        try {
          await installUpdate(update, (p) => {
            if (p.stage === 'downloading')      upBtn.textContent = p.pct ? `Downloading ${p.pct}%` : 'Downloading…';
            else if (p.stage === 'restarting')  upBtn.textContent = 'Restarting…';
          });
        } catch (err) {
          setStatus('Update failed: ' + (err?.message || err), 'error');
          reset();
        }
      };
      upBtn.addEventListener('click', installHandler, { once: true });
    };
    upBtn.addEventListener('click', async () => {
      upBtn.disabled = true;
      upBtn.textContent = 'Checking…';
      setStatus('', '');
      // Skip the floating banner - we render the install UI inline here.
      const res = await bootCheckForUpdates({ silent: false, showBanner: false });
      if (res.kind === 'error') {
        setStatus('Update check failed: ' + res.error, 'error');
        reset();
      } else if (res.kind === 'none') {
        setStatus('You are on the latest version.', 'ok');
        reset();
      } else if (res.kind === 'available') {
        becomeInstall(res.update);
      }
    });
  }
  // Compliance kill-switch (project-scoped)
  const killToggle = document.getElementById('settings-killswitch');
  const killReason = document.getElementById('settings-killswitch-reason');
  if (killToggle && state.selectedProject) {
    try {
      const ks = await invoke('kill_switch_get', { args: { cwd: state.selectedProject } });
      killToggle.checked = !!ks?.disabled;
      killReason.value = ks?.reason || '';
    } catch { /* ignore */ }
    killToggle.onchange = async () => {
      try {
        await invoke('kill_switch_set', { args: {
          cwd: state.selectedProject,
          disabled: killToggle.checked,
          by: 'PETER',
          reason: killReason.value || null,
        }});
      } catch (err) { alert('Failed: ' + (err?.message || err)); }
    };
  }
  modal.classList.remove('hidden');
}
bindSettings();

// Restore maxConcurrent on boot.
state.maxConcurrent = parseInt(localStorage.getItem('yunomia.maxConcurrent') || '3', 10);

// Surface any uncaught error / promise rejection so we don't lose them
// silently in release builds where DevTools isn't always open.
window.addEventListener('error', (e) => {
  console.error('window.error', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandledrejection', e.reason);
});

// Auto-update check (silent, throttled to once per 6 hours).
setTimeout(() => { void bootCheckForUpdates({ silent: true }); }, 4000);

// Claude Code presence gate — first thing on launch.
async function checkClaudeInstalled() {
  let status = null;
  try { status = await invoke('claude_status'); } catch { return; }
  const modal = document.getElementById('claude-missing-modal');
  if (!modal) return;
  if (status?.found) {
    modal.classList.add('hidden');
  } else {
    modal.classList.remove('hidden');
  }
}
function bindClaudeMissingModal() {
  document.getElementById('claude-recheck')?.addEventListener('click', () => checkClaudeInstalled());
  document.getElementById('claude-dismiss')?.addEventListener('click', () => {
    document.getElementById('claude-missing-modal').classList.add('hidden');
  });
}
bindClaudeMissingModal();
void checkClaudeInstalled();

// Kill-switch banner — polls every 30 s when a project is active.
async function killSwitchTick() {
  const cwd = state.selectedProject;
  const existing = document.querySelector('.killswitch-banner');
  if (!cwd) { if (existing) existing.remove(); return; }
  let ks = null;
  try { ks = await invoke('kill_switch_get', { args: { cwd } }); } catch { return; }
  if (!ks?.disabled) { if (existing) existing.remove(); return; }
  if (existing) return;
  const banner = document.createElement('div');
  banner.className = 'killswitch-banner';
  const reason = ks.reason ? ` - ${ks.reason}` : '';
  const by = ks.disabled_by ? ks.disabled_by : 'admin';
  const when = ks.disabled_at ? new Date(ks.disabled_at).toLocaleString() : '';
  banner.innerHTML = `<span>⚠ Compliance disabled by ${escapeHtml(by)} ${escapeHtml(when ? `(${when})` : '')}${escapeHtml(reason)}</span>`;
  document.body.insertBefore(banner, document.body.firstChild);
}
setInterval(killSwitchTick, 30_000);
setTimeout(killSwitchTick, 2000);

// Keyboard shortcuts - match IDE muscle memory.
//   Cmd+T          = open spawn-agent modal (when active phase)
//   Cmd+W          = close current tab (if not Dashboard)
//   Cmd+1..9       = switch to nth tab
//   Ctrl+Tab       = next agent pane
//   Ctrl+Shift+Tab = previous agent pane
window.addEventListener('keydown', (e) => {
  // Ctrl+Tab cycles panes — handled before the meta-only short-circuit because
  // Ctrl+Tab on macOS doesn't fire metaKey, only ctrlKey, and we want it to
  // work on every platform regardless of which modifier maps to "meta".
  if (e.ctrlKey && e.key === 'Tab') {
    const tabs = $$('#pane-tabs .tab').filter((t) => t.style.display !== 'none');
    if (!tabs.length) return;
    const currentIdx = tabs.findIndex((t) => t.dataset.pane === state.activePane);
    const dir = e.shiftKey ? -1 : 1;
    const nextIdx = ((currentIdx === -1 ? 0 : currentIdx) + dir + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[nextIdx].click();
    return;
  }
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  // Cmd+T → spawn
  if (e.key === 't' && !e.shiftKey) {
    const btn = document.getElementById('spawn-agent');
    if (btn && !btn.hidden) { e.preventDefault(); btn.click(); }
    return;
  }
  // Cmd+W → close current pane (skip Dashboard)
  if (e.key === 'w') {
    if (state.activePane && state.activePane !== 'dashboard') {
      e.preventDefault();
      void killPty(state.activePane);
    }
    return;
  }
  // Cmd+1..9 → switch tab
  if (e.key >= '1' && e.key <= '9') {
    const tabs = $$('#pane-tabs .tab').filter((t) => t.style.display !== 'none');
    const idx = parseInt(e.key, 10) - 1;
    if (tabs[idx]) { e.preventDefault(); tabs[idx].click(); }
  }
});

bindUi();

// Global keystroke safety net. If a printable key fires while focus is on
// document.body / a non-input element / xterm, route it into the active
// pane's composer so the user's typing can never disappear into a hidden
// xterm helper textarea or a focused button.
document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  // Only act on keystrokes that would normally produce input.
  const isPrintable = ev.key.length === 1;
  const isComposerKey = ev.key === 'Enter' || ev.key === 'Backspace' || ev.key === 'Delete';
  if (!isPrintable && !isComposerKey) return;
  const target = ev.target;
  const tag = (target && target.tagName) || '';
  // Don't poach keystrokes from real text inputs anywhere in the UI.
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
  const active = state.ptys.get(state.activePane);
  if (!active?.composer) return;
  active.composer.focus();
  // Don't preventDefault - the focused composer will receive this same
  // keystroke naturally on the next event loop tick.
}, true);

// Git status + CI badge polling (60 s tick).
startGitCiPolling(() => state.selectedProject);

// Native file-drop listener. Tauri's webview gets file paths from the OS
// here that the HTML5 dataTransfer API doesn't expose (WKWebView strips
// them). When a file is dropped anywhere over the window, we insert the
// real absolute path into the currently-active agent's composer. Images
// pasted via clipboard still take the FileReader → clipboard-dir path
// because those have no source file on disk.
(async () => {
  try {
    const win = getCurrentWindow();
    await win.onDragDropEvent((event) => {
      if (event.payload?.type !== 'drop') return;
      const paths = event.payload.paths || [];
      if (paths.length === 0) return;
      const active = state.ptys.get(state.activePane);
      const target = active?.composer;
      if (!target) return;
      // claude code reads files referenced by @<absolute-path> - bare paths
      // are sent to the model as plain text and never attached. Images and
      // any other dropped file should always go in via the @-prefix so the
      // model actually receives the content.
      const lead = target.value && !target.value.endsWith('\n') ? '\n' : '';
      const block = paths.map((p) => `@${p}`).join('\n') + '\n';
      insertAtCursor(target, lead + block);
      target.dispatchEvent(new Event('input'));
    });
  } catch (e) { console.warn('file-drop listener', e); }
})();

// Populate the new-ticket type/audience dropdowns from this project's
// taxonomy.json (Lead writes one during onboarding). Falls back to the
// generic default served by the rust side if no file exists.
async function applyTaxonomyToForms() {
  const cwd = state.selectedProject;
  if (!cwd) return;
  let tax;
  try { tax = await invoke('taxonomy_get', { args: { cwd } }); } catch { return; }
  const typeSel = document.getElementById('nt-type');
  const audSel  = document.getElementById('nt-audience');
  if (typeSel && Array.isArray(tax?.ticket_types) && tax.ticket_types.length) {
    const current = typeSel.value;
    typeSel.innerHTML = tax.ticket_types.map((t) =>
      `<option value="${escapeHtmlAttr(t)}"${t === current ? ' selected' : ''}>${escapeHtmlAttr(t)}</option>`).join('');
  }
  if (audSel && Array.isArray(tax?.audiences) && tax.audiences.length) {
    const current = audSel.value;
    audSel.innerHTML = tax.audiences.map((a) =>
      `<option value="${escapeHtmlAttr(a)}"${a === current ? ' selected' : ''}>${escapeHtmlAttr(a)}</option>`).join('');
  }
}
function escapeHtmlAttr(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// Save a clipboard / dropped image to ~/.yunomia/clipboard/ and return its
// absolute path. Insert that path into the composer so the user's message
// references a real file claude code can Read.
async function saveBlobToClipboard(file, ext) {
  const buf = new Uint8Array(await file.arrayBuffer());
  // Send as base64 to keep the Tauri argument JSON-safe.
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  const base64 = btoa(bin);
  return await invoke('clipboard_image_save', { args: { base64, ext } });
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  const newPos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = newPos;
  textarea.focus();
}
window.__applyTaxonomy = applyTaxonomyToForms;
applyTaxonomyToForms();

// Fill the new-ticket "Assignee" + spawn-modal "Agent code" dropdowns from
// the project's actual proposed/upserted agents. Without this, the UI still
// showed the legacy PrintPepper roster (AD/WA/DA/WD/TA/PETER) which had
// nothing to do with the current project's brief.
const AGENT_EMOJI_FALLBACK = {
  LEAD:'🧭', CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠',
  FE:'💠', INT:'🔌', PETER:'🎩',
  PLANNING:'🗺️', ADS:'📢', SEO:'🔍', CRM:'🤝', MERCHANT:'🛒',
  PRINTKITS:'🎨', DESIGN:'🖌', SALES:'💼', SUPPORT:'🛟',
};
// Truncate a long note to a single short, dropdown-friendly summary. Splits
// on the first sentence terminator or newline, then caps the result so long
// scope-defining notes don't blow out the option width.
function noteSummary(note) {
  if (!note) return '';
  const first = String(note).split(/[.\n]/)[0].trim();
  if (!first) return '';
  return first.length > 60 ? first.slice(0, 57) + '…' : first;
}
async function applyProjectAgentsToForms() {
  const cwd = state.selectedProject;
  if (!cwd) return;
  let agents = [];
  try { agents = await invoke('project_agents_list', { args: { cwd } }) || []; } catch { agents = []; }
  const codes = agents.map((a) => a.code);
  // Map code -> note for label decoration. Spawn modal uses descriptive
  // labels so users can tell PLANNING from MERCHANT without memorising
  // every project's coined codes.
  const noteByCode = Object.fromEntries(agents.map((a) => [a.code, noteSummary(a.note)]));
  // Cache for renderAgentRail (sync) so the rail can show full names without
  // having to invoke project_agents_list on every redraw.
  state.agentNoteByCode = noteByCode;
  renderAgentRail();
  const nt = document.getElementById('nt-assignee');
  if (nt) {
    const current = nt.value;
    nt.innerHTML = `<option value="">- unassigned</option>` + codes.map((c) =>
      `<option value="${escapeHtmlAttr(c)}"${c === current ? ' selected' : ''}>${AGENT_EMOJI_FALLBACK[c] || ''} ${escapeHtmlAttr(c)}</option>`).join('');
  }
  const sp = document.getElementById('spawn-code');
  if (sp) {
    const current = sp.value;
    // Always include LEAD so user can re-spawn the orchestrator if killed.
    const spawnCodes = codes.includes('LEAD') ? codes : ['LEAD', ...codes];
    sp.innerHTML = spawnCodes.map((c) => {
      const desc = noteByCode[c];
      const label = desc ? `${AGENT_EMOJI_FALLBACK[c] || ''} ${c} — ${desc}` : `${AGENT_EMOJI_FALLBACK[c] || ''} ${c}`;
      return `<option value="${escapeHtmlAttr(c)}"${c === current ? ' selected' : ''}>${escapeHtmlAttr(label)}</option>`;
    }).join('');
  }
}
window.__applyProjectAgents = applyProjectAgentsToForms;
applyProjectAgentsToForms();

// PH-134 Phase 2 - bridge to MC + auto-compact orchestrator.
// Register the bare-code → ptyKey resolver so writeToAgent (used by
// /pre-compact, /compact, heartbeat prompts) can find the right pty. Without
// this, writes silently no-op'd because pty_write keys ptys by the full
// `<sanitised-cwd>__<code>` form, not the bare code.
setAgentPtyResolver((code) => {
  const cwd = state.selectedProject;
  if (!cwd || !code) return null;
  const key = ptyKey(cwd, code);
  return state.ptys.has(key) ? key : null;
});
void initCompactOrchestrator();
startMcBridge({
  getRunningAgents: () => Array.from(state.ptys.keys()),
  onWakeup,
  onTaskBoundary: (evt) => {
    noteTaskBoundary(evt);
    maybeDisposeTempAgent(evt.agentCode);
  },
});

// Heartbeat - per-agent. Agents with wakeup_mode=heartbeat fire on cron.
startHeartbeat({
  getRunningAgents: () => visibleAgents().map(({ ent }) => ent.code),
  rewakeAgent: (code, ticketHumanId, reason) => onWakeup({ agentCode: code, ticketHumanId, reason }),
});

// PH-134 Phase 3 - crash recovery. Enumerates recent Claude sessions for the
// currently-selected project root and renders a banner offering Resume.
async function refreshResumeBanner() {
  document.querySelectorAll('.resume-banner').forEach((b) => b.remove());
  const cwd = state.selectedProject;
  if (!cwd) return;
  let sessions = [];
  try {
    sessions = await invoke('enumerate_sessions', { args: { cwd, limit: 8 } }) || [];
  } catch (err) { console.warn('enumerate_sessions failed', err); return; }
  if (!sessions.length) return;
  const recent = sessions.slice(0, 3);
  const html = recent.map((s) => {
    const when = s.modified ? new Date(s.modified).toLocaleString() : '?';
    return `<span class="resume-pill" data-sid="${s.session_id}">
      <button class="resume-btn" data-sid="${s.session_id}">Resume ${s.session_id.slice(0,8)} · ${when}</button>
      <button class="resume-kill" data-sid="${s.session_id}" title="Delete this session">🗑</button>
    </span>`;
  }).join(' ');
  const banner = document.createElement('div');
  banner.className = 'resume-banner';
  banner.innerHTML = `<span>Recent sessions in <b>${projectLabel(cwd)}</b>:</span> ${html} <button class="resume-dismiss" type="button">✕</button>`;
  document.body.insertBefore(banner, document.body.firstChild);
  banner.querySelectorAll('.resume-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const sid = b.dataset.sid;
      const code = 'LEAD';
      banner.remove();
      const model = state.stickyModels?.[code] || AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
      await spawnAgent(code, model, cwd, { resume: sid });
    });
  });
  banner.querySelectorAll('.resume-kill').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = b.dataset.sid;
      if (!confirm(`Delete session ${sid.slice(0,8)}? Conversation history will be lost permanently.`)) return;
      try {
        await invoke('delete_session', { args: { cwd, session_id: sid } });
        b.closest('.resume-pill')?.remove();
        // If banner now empty, remove it.
        if (!banner.querySelectorAll('.resume-pill').length) banner.remove();
      } catch (err) { alert('Delete failed: ' + (err?.message || err)); }
    });
  });
  banner.querySelector('.resume-dismiss').addEventListener('click', () => banner.remove());
}

// Expose for console debugging during dogfood.
window.yunomia = { state, firePreCompact };
