// Yunomia - onboarding view.
//
// New project = no tickets, no agents, no kanban. Just the lead-agent flow:
// user chats with a Lead pty, Lead writes brief.md, when ready user clicks
// "Approve brief - go active" and the dashboard flips to kanban mode.

import { invoke } from '@tauri-apps/api/core';

const FOUNDER_KICKOFF = (projectName, projectPath, briefPath) => `\
You are the LEAD agent for a brand-new Yunomia project.

Project: ${projectName}
Path: ${projectPath}
Brief file: ${briefPath}

Right now there is no brief, no tickets, no other agents. Your job is the
onboarding interview. You will:

1. Interview the user about the project.
   Ask, in order, with brief follow-ups:
   - One-liner: in one sentence, what is this project?
   - Primary goals: what does "done" look like? Be concrete - list outcomes.
   - Stakeholders: who uses this? Who cares about it shipping?
   - Constraints: deadlines, must-use tech, hard non-negotiables.
   - Deploy targets: local-only, staging, production, internal-tool, public SaaS?
   - Current state: greenfield, or building on existing code?
   - Open questions: anything you (the user) are unsure about?

2. As the conversation goes, write your evolving understanding to
   ${briefPath}
   using this template:

   # ${projectName}
   ## One-liner
   ## Primary goals
   ## Stakeholders
   ## Constraints
   ## Deploy targets
   ## Current state
   ## Open questions

   Use the Write tool to update the file. Update incrementally, don't wait
   for the full interview to finish.

3. When you and the user agree the brief is solid, write TWO machine-readable
   proposal files (not just a markdown section):

   FILE A - ${cwd}/.yunomia-proposals/proposed-agents.json (note: actually
   written to ~/.yunomia/projects/<sanitised>/proposed-agents.json - Yunomia
   reads from there). Schema:

     [
       { "code": "CEO",  "model": "claude-opus-4-7",  "reason": "orchestrator",       "wakeup_mode": "heartbeat" },
       { "code": "SA",   "model": "claude-sonnet-4-6","reason": "backend + db",      "wakeup_mode": "on-assignment" },
       { "code": "QA",   "model": "claude-haiku-4-5-20251001", "reason": "verifications","wakeup_mode": "on-assignment" }
     ]

   wakeup_mode: "heartbeat" for orchestrators that should wake on a cron;
   "on-assignment" for workers that wake only when given a ticket.

   FILE B - proposed-tickets.json. Schema:

     [
       { "title": "Schema migration for orders", "body_md": "…", "type": "migration", "audience": "admin", "assignee_agent": "SA" },
       { "title": "Login flow E2E test",          "body_md": "…", "type": "feature",   "audience": "app",   "assignee_agent": "QA" }
     ]

   Use the Write tool to create both files. Paths are relative to:
   ~/.yunomia/projects/<sanitised-cwd>/

   Where <sanitised-cwd> = the project path with / replaced by - and spaces
   replaced by _. For this project the sanitised path is:
   ${cwd.trim().replace(/^\//,'').replace(/\//g,'-').replace(/ /g,'_')}

   So the absolute paths are:
   ~/.yunomia/projects/${cwd.trim().replace(/^\//,'').replace(/\//g,'-').replace(/ /g,'_')}/proposed-agents.json
   ~/.yunomia/projects/${cwd.trim().replace(/^\//,'').replace(/\//g,'-').replace(/ /g,'_')}/proposed-tickets.json

   Don't create agents or tickets via any other method. Yunomia ingests
   these files when the user clicks Approve. You can rewrite either file
   anytime - the user always sees the latest before approving.

4. Be a real lead, not a yes-bot:
   - Push back when scope is fuzzy.
   - Flag when the user is conflating goals with implementation.
   - Surface tradeoffs the user hasn't seen.

Talk to the user now. Start with question 1.
`;

export async function loadOnboardingForProject(cwd) {
  const [stateRes, briefRes] = await Promise.all([
    invoke('project_state_get', { args: { cwd } }).catch(() => null),
    invoke('brief_get', { args: { cwd } }).catch(() => ''),
  ]);
  return { state: stateRes || { phase: 'onboarding' }, brief: briefRes || '' };
}

export async function setProjectName(cwd, name) {
  return invoke('project_state_set', { args: { cwd, patch: { project_name: name } } });
}

export async function approveBrief(cwd) {
  return invoke('project_state_set', { args: { cwd, patch: { phase: 'active', brief_finalised_at: new Date().toISOString() } } });
}

export async function reopenOnboarding(cwd) {
  return invoke('project_state_set', { args: { cwd, patch: { phase: 'onboarding', brief_finalised_at: null } } });
}

export async function markLeadSpawned(cwd) {
  return invoke('project_state_set', { args: { cwd, patch: { lead_spawned_at: new Date().toISOString() } } });
}

// Render the onboarding view into a container element.
// `spawnAgent(code, model, cwd, opts)` is the spawn function from main.js.
// `leadRunning` is the live pty status, NOT the stored flag - pty dies on app
// restart, so we check the actual registry every render instead of trusting
// state.lead_spawned_at (which was useful once but now misleads after a quit).
export function renderOnboardingView({ container, cwd, state, brief, spawnAgent, onApproved, leadRunning = false }) {
  if (!container) return;
  const projectName = state.project_name || projectLabel(cwd);
  const briefPath = `~/.yunomia/projects/${cwd.replace(/^\//, '').replace(/\//g, '-').replace(/ /g, '_')}/brief.md`;
  const briefHasContent = (brief || '').trim().length > 50;
  container.innerHTML = `
    <div class="onb">
      <header class="onb-header">
        <h1>${escapeHtml(projectName)}</h1>
        <div class="onb-stage">stage: <b>onboarding</b></div>
      </header>
      <div class="onb-grid">
        <section class="onb-left">
          <h3>Lead agent</h3>
          ${leadRunning
            ? `<p>Lead is running in the <b>LEAD</b> tab. Talk to them about your goals - they'll write the brief here as you go.</p>`
            : `<p>The lead agent will interview you about goals, scope, and constraints, then write the brief and propose an initial agent fleet + ticket list.</p>
               <div class="onb-form">
                 <label>Project name</label>
                 <input id="onb-project-name" type="text" value="${escapeHtml(projectName)}" />
                 <button id="onb-spawn-lead" class="btn-primary" type="button">Spawn lead agent</button>
               </div>`}
          <h3 style="margin-top:24px">Brief</h3>
          <pre class="onb-brief">${brief ? escapeHtml(brief) : '<span class="onb-brief-empty">Brief will appear here as the lead agent writes it.</span>'}</pre>
          <button id="onb-refresh-brief" class="btn-ghost" type="button">↻ Refresh brief</button>
        </section>
        <aside class="onb-right">
          <h3>What happens here</h3>
          <ol class="onb-steps">
            <li><b>Spawn lead.</b> A Claude Code session opens in the LEAD tab.</li>
            <li><b>Interview.</b> Lead asks you about goals, scope, constraints, deploy targets.</li>
            <li><b>Brief written.</b> Lead writes <code>brief.md</code> incrementally as you talk.</li>
            <li><b>Proposals.</b> Lead suggests agent fleet + initial tickets in the brief.</li>
            <li><b>Approve.</b> You click "Approve brief" - Yunomia switches to active mode and the kanban becomes available.</li>
          </ol>
          <div class="onb-approve-row">
            <button id="onb-approve" class="btn-primary" type="button" ${briefHasContent ? '' : 'disabled'}>Approve brief - go active</button>
            ${briefHasContent ? '' : '<small>Available once the brief has real content (>50 chars).</small>'}
          </div>
        </aside>
      </div>
    </div>
  `;
  // Wire handlers
  const spawnBtn = container.querySelector('#onb-spawn-lead');
  if (spawnBtn) {
    spawnBtn.addEventListener('click', async () => {
      const name = container.querySelector('#onb-project-name')?.value.trim() || projectLabel(cwd);
      await setProjectName(cwd, name);
      const kickoff = FOUNDER_KICKOFF(name, cwd, briefPath);
      await spawnAgent('LEAD', 'claude-opus-4-7', cwd, { kickoff });
      await markLeadSpawned(cwd);
      // Re-render
      const fresh = await loadOnboardingForProject(cwd);
      renderOnboardingView({ container, cwd, state: fresh.state, brief: fresh.brief, spawnAgent, onApproved, leadRunning: true });
    });
  }
  const refreshBtn = container.querySelector('#onb-refresh-brief');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const fresh = await loadOnboardingForProject(cwd);
      renderOnboardingView({ container, cwd, state: fresh.state, brief: fresh.brief, spawnAgent, onApproved, leadRunning });
    });
  }
  const approveBtn = container.querySelector('#onb-approve');
  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      // Ingest Lead's proposals if present.
      let proposals = { tickets: [], agents: [] };
      try { proposals = await invoke('proposals_read', { args: { cwd } }); } catch {}
      let summary = `Approve brief for "${projectName}" and go active?`;
      if (proposals.tickets.length || proposals.agents.length) {
        summary += `\n\nLead proposed ${proposals.tickets.length} ticket(s) + ${proposals.agents.length} agent(s). These will be created automatically.`;
      }
      if (!confirm(summary)) return;
      for (const pt of proposals.tickets) {
        try {
          await invoke('tickets_create', { args: { cwd,
            title: pt.title || '(untitled)',
            bodyMd: pt.body_md || '',
            type: pt.type || 'feature',
            status: 'triage',
            audience: pt.audience || 'admin',
            assigneeAgent: pt.assignee_agent || null,
          }});
        } catch (err) { console.warn('proposed ticket create failed', err); }
      }
      if (proposals.agents.length) {
        const agents = proposals.agents.map((a) => ({
          code: a.code,
          model: a.model || 'claude-sonnet-4-6',
          wakeup_mode: a.wakeup_mode || (a.code === 'LEAD' || a.code === 'CEO' ? 'heartbeat' : 'on-assignment'),
          heartbeat_min: 60,
          note: a.reason || null,
        }));
        try { await invoke('project_agents_upsert', { args: { cwd, agents } }); } catch {}
      }
      try { await invoke('proposals_clear', { args: { cwd } }); } catch {}
      // Auto-spawn the proposed heartbeat agents (orchestrators) so they
      // come up live. on-assignment workers stay dormant until a ticket lands.
      const heartbeatAgents = (proposals.agents || []).filter((a) =>
        (a.wakeup_mode || (a.code === 'LEAD' || a.code === 'CEO' ? 'heartbeat' : 'on-assignment')) === 'heartbeat'
      );
      for (const a of heartbeatAgents) {
        if (a.code === 'LEAD') continue;   // Lead is already running
        try {
          await spawnAgent(a.code, a.model || 'claude-sonnet-4-6', cwd, {});
        } catch (err) { console.warn('auto-spawn failed', a.code, err); }
      }
      await approveBrief(cwd);
      onApproved && onApproved();
      return;
    });
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function projectLabel(p) {
  if (!p) return '?';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}
