// Yunomia - onboarding view.
//
// New project = no tickets, no agents, no kanban. Just the lead-agent flow:
// user chats with a Lead pty, Lead writes brief.md, when ready user clicks
// "Approve brief - go active" and the dashboard flips to kanban mode.

import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';

const FOUNDER_KICKOFF = (projectName, cwd, briefPath) => `\
You are the LEAD agent for a brand-new Yunomia project.

Project: ${projectName}
Path: ${cwd}
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

3. When you and the user agree the brief is solid, write THREE
   machine-readable files into the project's .yunomia/ directory. Use the
   Write tool. Use these EXACT absolute paths:

   FILE A - ${cwd}/.yunomia/proposed-agents.json. Schema:

     [
       { "code": "CEO",  "model": "claude-opus-4-7",          "reason": "orchestrator - breaks epics into tickets, assigns work, monitors progress", "wakeup_mode": "heartbeat" },
       { "code": "SA",   "model": "claude-sonnet-4-6",        "reason": "backend + DB schema + core domain logic",                                   "wakeup_mode": "on-assignment" },
       { "code": "QA",   "model": "claude-haiku-4-5-20251001","reason": "verifications and acceptance tests",                                        "wakeup_mode": "on-assignment" }
     ]

   wakeup_mode: "heartbeat" for orchestrators that wake on a cron;
   "on-assignment" for workers that wake only when given a ticket.

   FILE B - ${cwd}/.yunomia/proposed-tickets.json. Schema:

     [
       { "title": "Schema migration for orders", "body_md": "<full description>", "type": "migration", "audience": "admin", "assignee_agent": "SA" },
       { "title": "Login flow E2E test",         "body_md": "<full description>", "type": "feature",   "audience": "app",   "assignee_agent": "QA" }
     ]

   FILE C - ${cwd}/.yunomia/taxonomy.json. Defines project-specific ticket
   types and audiences so the kanban dropdowns reflect THIS project, not
   generic placeholders. Schema:

     {
       "audiences":   ["office", "stations", "external"],
       "ticket_types":["ingestion", "routing", "shipping", "ui", "bug"]
     }

   Pick audiences and types that fit the brief. Always include "bug" in
   ticket_types so the bug-protocol gate works. Make sure assignee_agent
   values in FILE B match codes in FILE A.

   Yunomia ingests FILES A + B when the user clicks Approve, then auto-
   scaffolds per-agent kickoff/soul/pre-compact/reawaken markdown files in
   ${cwd}/.yunomia/agents/<CODE>/, and auto-spawns the heartbeat agents.

   IMPORTANT - common failure modes to avoid:
   - Don't write FILE A and skip FILE B (operator gets agents but no work).
   - Don't claim "I'll write 15 tickets" then submit only 3.
   - Don't write to legacy paths under ~/.yunomia/. Write to .yunomia/ in
     the project root - that's where Yunomia v0.1.16+ reads from.
   - You can rewrite any file before approve; the operator always sees
     fresh counts.

   MANDATORY VERIFICATION - after writing each file, run:
     Bash:  ls -la ${cwd}/.yunomia/ && wc -l ${cwd}/.yunomia/proposed-*.json
   and quote the output back to the user. Do NOT report "I wrote N tickets"
   without this verification - the most common failure is silently failing
   to write the file and then claiming success. If Bash shows a missing
   file or zero bytes, retry the Write or tell the user the tool errored.

4. Be a real lead, not a yes-bot:
   - Push back when scope is fuzzy.
   - Flag when the user is conflating goals with implementation.
   - Surface tradeoffs the user hasn't seen.

5. Formatting: do NOT use markdown blockquotes (lines starting with `> `).
   The Yunomia / claude code TUI renders `> ` identically to the user
   input prompt, so blockquoted lines in your response look like
   pre-filled user input and confuse the operator. Use plain prose,
   bulleted lists, or fenced code blocks instead.

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
                 <label>Lead model</label>
                 <select id="onb-lead-model">
                   <option value="claude-opus-4-7" selected>Opus 4.7 (best for scoping / design)</option>
                   <option value="claude-sonnet-4-6">Sonnet 4.6 (balanced)</option>
                   <option value="claude-haiku-4-5-20251001">Haiku 4.5 (cheapest, fastest)</option>
                 </select>
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
      try {
        const name = container.querySelector('#onb-project-name')?.value.trim() || projectLabel(cwd);
        const leadModel = container.querySelector('#onb-lead-model')?.value || 'claude-opus-4-7';
        await setProjectName(cwd, name);
        const kickoff = FOUNDER_KICKOFF(name, cwd, briefPath);
        await spawnAgent('LEAD', leadModel, cwd, { kickoff });
        await markLeadSpawned(cwd);
        const fresh = await loadOnboardingForProject(cwd);
        renderOnboardingView({ container, cwd, state: fresh.state, brief: fresh.brief, spawnAgent, onApproved, leadRunning: true });
      } catch (err) {
        console.error('spawn lead failed', err);
        alert('Spawn lead agent failed:\n' + (err?.message || err) + '\n\nIf you see this, please screenshot and share with the maintainer.');
      }
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
      let proposals = { tickets: [], agents: [], diagnostics: [] };
      try { proposals = await invoke('proposals_read', { args: { cwd } }); } catch {}

      // Loud validation: refuse to silently approve with 0 tickets when
      // Lead claimed to write some. Show counts AND any per-entry skip
      // reasons so the user can see "Lead wrote 13 tickets but 8 were
      // missing 'title'" instead of a mute zero.
      const summary = [
        `Approve brief for "${projectName}" and switch to active mode?`,
        '',
        `Found in proposed-tickets.json: ${proposals.tickets.length} ticket(s)`,
        `Found in proposed-agents.json: ${proposals.agents.length} agent(s)`,
        '',
      ];
      if ((proposals.diagnostics || []).length) {
        summary.push('Issues parsing Lead\'s proposals:');
        for (const d of proposals.diagnostics) summary.push(`  • ${d}`);
        summary.push('');
      }
      if (proposals.tickets.length === 0) {
        summary.push('⚠ No tickets proposed. Lead may have skipped writing the file.');
        summary.push('   You can still approve - tickets can be added manually later.');
        summary.push('');
      }
      summary.push('Continue?');
      // Use Tauri's plugin-dialog `ask()` instead of native window.confirm().
      // window.confirm() is intercepted by Tauri's WebView2 (Windows) and
      // routed to a non-existent dialog.confirm command, throwing
      // "Command not found". macOS WebKit handled native confirm() natively
      // so this never surfaced. Tauri's ask() is the cross-platform-safe
      // equivalent and uses the dialog:allow-ask permission already granted.
      const ok = await ask(summary.join('\n'), { title: 'Approve brief?' });
      if (!ok) return;

      let approveCreated = 0;
      const approveErrors = [];
      for (let i = 0; i < proposals.tickets.length; i++) {
        const pt = proposals.tickets[i];
        try {
          await invoke('tickets_create', { args: { cwd,
            title: pt.title || '(untitled)',
            bodyMd: pt.body_md || '',
            type: pt.type || 'feature',
            status: 'triage',
            audience: pt.audience || 'admin',
            assigneeAgent: pt.assignee_agent || null,
          }});
          approveCreated += 1;
        } catch (err) {
          const msg = (err && (err.message || err.toString())) || String(err);
          approveErrors.push(`ticket[${i}] "${(pt.title || '').slice(0,60)}": ${msg}`);
          console.warn('proposed ticket create failed', i, pt.title, err);
        }
      }

      // Snapshot the brief once; we'll use a trimmed excerpt to seed each
      // agent's auto-scaffolded kickoff so they boot with project context.
      let briefText = '';
      try { briefText = await invoke('brief_get', { args: { cwd } }) || ''; } catch {}
      const briefExcerpt = briefText.length > 1500 ? briefText.slice(0, 1500) + '\n\n…' : briefText;

      if (proposals.agents.length) {
        const agents = proposals.agents.map((a) => ({
          code: a.code,
          model: a.model || 'claude-sonnet-4-6',
          wakeup_mode: a.wakeup_mode || (a.code === 'LEAD' || a.code === 'CEO' ? 'heartbeat' : 'on-assignment'),
          heartbeat_min: 60,
          note: a.reason || null,
        }));
        try { await invoke('project_agents_upsert', { args: { cwd, agents } }); } catch {}

        // Scaffold per-agent kickoff/soul/pre-compact/reawaken so auto-spawned
        // agents boot with role identity instead of being a blank Claude
        // session in the same cwd as Lead.
        for (const a of proposals.agents) {
          try {
            await invoke('agent_files_scaffold', { args: {
              cwd,
              code: a.code,
              role: a.reason || `${a.code} agent`,
              projectName,
              briefExcerpt,
            }});
          } catch (err) { console.warn('scaffold failed', a.code, err); }
        }
      }
      // Only clear proposals if every ticket made it in. Otherwise Lead's
      // file is the only copy of the un-ingested entries.
      const allTicketsCreated = approveCreated === proposals.tickets.length;
      if (allTicketsCreated) {
        try { await invoke('proposals_clear', { args: { cwd } }); } catch {}
      }

      // Auto-spawn the proposed heartbeat agents (orchestrators).
      // on-assignment workers stay dormant until a ticket lands.
      const heartbeatAgents = (proposals.agents || []).filter((a) =>
        (a.wakeup_mode || (a.code === 'LEAD' || a.code === 'CEO' ? 'heartbeat' : 'on-assignment')) === 'heartbeat'
      );
      for (const a of heartbeatAgents) {
        if (a.code === 'LEAD') continue;
        try {
          await spawnAgent(a.code, a.model || 'claude-sonnet-4-6', cwd, {});
        } catch (err) { console.warn('auto-spawn failed', a.code, err); }
      }
      await approveBrief(cwd);
      // Final summary - what actually happened, including any failures.
      const errSection = approveErrors.length
        ? `\n\nFailed:\n  • ${approveErrors.slice(0, 10).join('\n  • ')}${approveErrors.length > 10 ? `\n  …(+${approveErrors.length - 10} more)` : ''}`
        : '';
      const sourceNote = allTicketsCreated ? '' : '\n\nproposed-*.json kept so Lead\'s work is not lost.';
      alert(`Approved.\n\nCreated: ${approveCreated} of ${proposals.tickets.length} ticket(s) + ${proposals.agents.length} agent(s).\nAuto-spawned ${heartbeatAgents.filter((a) => a.code !== 'LEAD').length} heartbeat agent(s).${errSection}${sourceNote}`);
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
