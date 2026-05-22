// Dream Mode module — status, history, actions (rich context + decision workflow), health, briefing
// NOTE: Decision history, deferred items, and undo state use localStorage for now.
// Future pass: migrate to SQLite (dream_decisions table) so data survives cache clears.
(function () {
  const container = document.getElementById('dream-content');
  const actionFilter = document.getElementById('dream-action-filter');
  let refreshInterval = null;
  const actionDataStore = new Map(); // result_id -> { job_name, result_data }
  const expandedActions = new Set(); // track which action cards are expanded across refreshes

  // --- localStorage persistence layer ---
  const LS_PREFIX = 'noah_dream_';
  const LS_KEYS = {
    DECISIONS: LS_PREFIX + 'decisions',
    DEFERRED: LS_PREFIX + 'deferred',
    REJECTED: LS_PREFIX + 'rejected_hashes',
    UNDO: LS_PREFIX + 'undo_state',
  };

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; }
    catch { return []; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch { /* quota exceeded — silently fail */ }
  }
  function lsPush(key, item) {
    const arr = lsGet(key);
    arr.unshift(item);
    // Cap at 200 entries
    if (arr.length > 200) arr.length = 200;
    lsSet(key, arr);
  }

  function hashAction(action) {
    const str = (action.job_name || '') + (action.result_data || '');
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return 'dh_' + (h >>> 0).toString(36);
  }

  function isRejectedDuplicate(action) {
    const hashes = lsGet(LS_KEYS.REJECTED);
    return hashes.includes(hashAction(action));
  }

  function pruneExpiredUndo() {
    const entries = lsGet(LS_KEYS.UNDO);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const valid = entries.filter(e => e.approved_at > cutoff);
    if (valid.length !== entries.length) lsSet(LS_KEYS.UNDO, valid);
    return valid;
  }

  function getUndoEntry(resultId) {
    return pruneExpiredUndo().find(e => e.id === resultId) || null;
  }

  // --- Utilities ---
  function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function renderMd(text) {
    if (!text) return '';
    let safe = escHtml(text);
    return safe
      .replace(/^### (.+)$/gm, (_, t) => `<h3>${t}</h3>`)
      .replace(/^## (.+)$/gm, (_, t) => `<h2>${t}</h2>`)
      .replace(/^# (.+)$/gm, (_, t) => `<h1>${t}</h1>`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  function badge(text, color) {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:${color};color:white;">${escHtml(text)}</span>`;
  }

  function statusBadge(status) {
    const colors = { completed: 'var(--positive)', failed: 'var(--negative)', running: 'var(--accent)', interrupted: 'var(--flag)', skipped: 'var(--text-muted)' };
    return badge(status, colors[status] || 'var(--text-muted)');
  }

  function categoryBadge(cat) {
    const colors = { maintenance: '#607d8b', cognitive: '#9c27b0', optimization: '#ff9800', research: '#2196f3' };
    return badge(cat, colors[cat] || '#607d8b');
  }

  function confidenceBadge(level) {
    const colors = { high: 'var(--positive)', medium: 'var(--flag)', low: 'var(--negative)' };
    return badge(level, colors[level] || 'var(--text-muted)');
  }

  function formatDuration(startedAt, endedAt) {
    if (!startedAt) return '-';
    const start = new Date(startedAt);
    const end = endedAt ? new Date(endedAt) : new Date();
    const secs = Math.floor((end - start) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  function formatTimeRemaining(ms) {
    if (ms <= 0) return 'expired';
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  // --- Rules cache (fetched once per render cycle) ---
  let rulesCache = null;
  let rulesCacheTime = 0;

  async function getCachedRules() {
    // Cache for 10 seconds to avoid redundant fetches within a render cycle
    if (rulesCache && Date.now() - rulesCacheTime < 10000) return rulesCache;
    try {
      const resp = await fetch('/api/rules');
      const data = await resp.json();
      if (data.rules) {
        rulesCache = data;
        rulesCacheTime = Date.now();
      }
      return data;
    } catch {
      return null;
    }
  }

  // --- Result data parser ---
  function parseResultContext(resultDataStr, jobName, currentRules) {
    const ctx = {
      tested: [],
      proposedChanges: null,
      reasoning: null,
      confidence: null,
      impactScope: null,
      evidence: [],
      ruleId: null,
    };

    let data;
    try {
      data = JSON.parse(resultDataStr || '{}');
    } catch {
      ctx.tested = ['(unable to parse result data)'];
      return ctx;
    }

    const isThinkingAudit = jobName === 'thinking_audit' || jobName === 'thinking_audit_review';

    // What was tested
    if (Array.isArray(data.rule_results)) {
      ctx.tested = data.rule_results.map(r =>
        `Rule ${r.rule_id}: ${r.passed ? 'passed' : 'failed'}`
      );
    }
    if (Array.isArray(data.conversations_tested)) {
      data.conversations_tested.forEach(c => ctx.tested.push(`Conversation: ${c}`));
    }
    if (Array.isArray(data.memories_reviewed)) {
      data.memories_reviewed.forEach(m => ctx.tested.push(`Memory: ${m}`));
    }
    if (data.test_scenarios) {
      const scenarios = Array.isArray(data.test_scenarios) ? data.test_scenarios : [data.test_scenarios];
      scenarios.forEach(s => ctx.tested.push(`Scenario: ${typeof s === 'string' ? s : JSON.stringify(s)}`));
    }
    if (ctx.tested.length === 0) {
      ctx.tested = [data.description || jobName || '(no details available)'];
    }

    // Proposed changes (thinking_audit only)
    if (isThinkingAudit && data.proposed_changes && data.rule_id) {
      ctx.ruleId = data.rule_id;
      const allowedFields = ['name', 'description', 'prompt_instruction', 'enforcement', 'testable_assertion'];
      const currentRule = currentRules?.rules?.find(r => r.id === data.rule_id);
      ctx.proposedChanges = Object.entries(data.proposed_changes)
        .filter(([k]) => allowedFields.includes(k))
        .map(([field, proposed]) => ({
          field,
          current: currentRule ? (currentRule[field] || '') : '(rule not found)',
          proposed: String(proposed),
        }));
    }

    // Reasoning
    ctx.reasoning = data.reasoning || data.rationale || data.summary || null;

    // Confidence
    if (data.confidence) {
      const level = typeof data.confidence === 'string'
        ? data.confidence.toLowerCase()
        : null;
      ctx.confidence = {
        level: ['high', 'medium', 'low'].includes(level) ? level : 'medium',
        score: data.confidence_score ?? null,
        explanation: data.confidence_explanation || null,
      };
    } else if (isThinkingAudit && Array.isArray(data.rule_results) && data.rule_results.length > 0) {
      // Derive from pass rate
      const passRate = data.rule_results.filter(r => r.passed).length / data.rule_results.length;
      const level = passRate > 0.8 ? 'high' : passRate > 0.5 ? 'medium' : 'low';
      ctx.confidence = {
        level,
        score: Math.round(passRate * 100),
        explanation: `Based on ${Math.round(passRate * 100)}% pass rate across ${data.rule_results.length} rules`,
      };
    }

    // Impact scope
    if (isThinkingAudit && ctx.proposedChanges) {
      const parts = [];
      parts.push(`Changes ${ctx.proposedChanges.length} field${ctx.proposedChanges.length !== 1 ? 's' : ''} on rule ${data.rule_id}`);
      if (Array.isArray(data.rule_results)) {
        parts.push(`Evaluated against ${data.rule_results.length} rules`);
      }
      ctx.impactScope = parts.join(' | ');
    } else if (data.impact) {
      ctx.impactScope = String(data.impact);
    } else if (data.affects) {
      ctx.impactScope = String(data.affects);
    }

    // Evidence trail
    if (Array.isArray(data.conversations)) {
      data.conversations.forEach(c => ctx.evidence.push({ type: 'conversation', ref: c, label: `Conv: ${c}` }));
    }
    if (Array.isArray(data.memory_ids)) {
      data.memory_ids.forEach(m => ctx.evidence.push({ type: 'memory', ref: m, label: `Memory: ${m}` }));
    }
    if (data.conversation_id) {
      ctx.evidence.push({ type: 'conversation', ref: data.conversation_id, label: `Conv: ${data.conversation_id}` });
    }

    return ctx;
  }

  // --- Diff rendering ---
  function renderFieldDiff(field, current, proposed) {
    const cur = String(current || '');
    const prop = String(proposed || '');
    if (cur === prop) return '';

    return `
      <div style="margin-bottom:12px;">
        <div style="font-weight:500;font-size:12px;margin-bottom:4px;color:var(--text-muted);">${escHtml(field)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
          <div style="background:rgba(229,115,115,0.1);border:1px solid rgba(229,115,115,0.3);border-radius:4px;padding:8px;white-space:pre-wrap;word-break:break-word;">
            <div style="font-size:10px;color:var(--negative);margin-bottom:4px;font-weight:600;">CURRENT</div>
            ${escHtml(cur) || '<em style="color:var(--text-muted);">(empty)</em>'}
          </div>
          <div style="background:rgba(76,175,80,0.1);border:1px solid rgba(76,175,80,0.3);border-radius:4px;padding:8px;white-space:pre-wrap;word-break:break-word;">
            <div style="font-size:10px;color:var(--positive);margin-bottom:4px;font-weight:600;">PROPOSED</div>
            ${escHtml(prop) || '<em style="color:var(--text-muted);">(empty)</em>'}
          </div>
        </div>
      </div>`;
  }

  // --- Expanded card content ---
  function renderExpandedCard(action, ctx) {
    const sections = [];

    // What was tested
    if (ctx.tested.length > 0) {
      sections.push(`
        <div style="margin-bottom:12px;">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--accent);">What was tested / reviewed</div>
          <ul style="margin:0;padding-left:16px;font-size:12px;">${ctx.tested.map(t => `<li>${escHtml(t)}</li>`).join('')}</ul>
        </div>`);
    }

    // Proposed changes with diff
    if (ctx.proposedChanges && ctx.proposedChanges.length > 0) {
      const diffs = ctx.proposedChanges.map(c => renderFieldDiff(c.field, c.current, c.proposed)).join('');
      sections.push(`
        <div style="margin-bottom:12px;">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--accent);">Proposed changes${ctx.ruleId ? ` — Rule: ${escHtml(ctx.ruleId)}` : ''}</div>
          ${diffs}
        </div>`);
    }

    // Reasoning
    if (ctx.reasoning) {
      sections.push(`
        <div style="margin-bottom:12px;">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--accent);">Reasoning</div>
          <div style="font-size:12px;line-height:1.5;">${renderMd(ctx.reasoning)}</div>
        </div>`);
    }

    // Confidence
    if (ctx.confidence) {
      sections.push(`
        <div style="margin-bottom:12px;">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--accent);">Confidence</div>
          <div style="display:flex;align-items:center;gap:8px;">
            ${confidenceBadge(ctx.confidence.level)}
            ${ctx.confidence.score !== null ? `<span style="font-size:12px;color:var(--text-muted);">${ctx.confidence.score}%</span>` : ''}
          </div>
          ${ctx.confidence.explanation ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${escHtml(ctx.confidence.explanation)}</div>` : ''}
        </div>`);
    }

    // Impact scope
    if (ctx.impactScope) {
      sections.push(`
        <div style="margin-bottom:12px;">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--accent);">Impact scope</div>
          <div style="font-size:12px;">${escHtml(ctx.impactScope)}</div>
        </div>`);
    }

    // Evidence trail
    if (ctx.evidence.length > 0) {
      sections.push(`
        <div style="margin-bottom:8px;">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--accent);">Evidence trail</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;">
            ${ctx.evidence.map(e => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:var(--bg-input);border:1px solid var(--border);">${escHtml(e.label)}</span>`).join('')}
          </div>
        </div>`);
    }

    if (sections.length === 0) {
      sections.push('<div style="font-size:12px;color:var(--text-muted);">No additional context available for this action item.</div>');
    }

    return sections.join('');
  }

  // --- Modal ---
  function showDreamModal({ title, message, showReasonInput, onConfirm, onCancel }) {
    // Remove any existing modal
    closeDreamModal();

    const overlay = document.createElement('div');
    overlay.className = 'dream-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:24px;max-width:440px;width:90%;';

    card.innerHTML = `
      <h3 style="margin:0 0 12px;">${escHtml(title)}</h3>
      <p style="margin:0 0 16px;font-size:13px;color:var(--text);">${escHtml(message)}</p>
      ${showReasonInput ? `
        <div style="margin-bottom:16px;">
          <label style="font-size:12px;display:block;margin-bottom:4px;color:var(--text-muted);">Reason for rejection (required):</label>
          <textarea id="dream-modal-reason" style="width:100%;min-height:60px;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;resize:vertical;" placeholder="Explain why this proposal should be rejected..."></textarea>
        </div>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="dream-modal-cancel" style="padding:6px 16px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:12px;">Cancel</button>
        <button class="dream-modal-confirm" style="padding:6px 16px;background:${showReasonInput ? 'var(--negative)' : 'var(--positive)'};color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Confirm</button>
      </div>`;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Focus textarea or confirm button
    if (showReasonInput) {
      const ta = card.querySelector('#dream-modal-reason');
      if (ta) setTimeout(() => ta.focus(), 50);
    }

    // Event handlers
    const cancel = () => { closeDreamModal(); if (onCancel) onCancel(); };
    const confirm = () => {
      if (showReasonInput) {
        const reason = card.querySelector('#dream-modal-reason')?.value?.trim();
        if (!reason) {
          const ta = card.querySelector('#dream-modal-reason');
          if (ta) { ta.style.borderColor = 'var(--negative)'; ta.focus(); }
          return; // reason is required
        }
        closeDreamModal();
        onConfirm(reason);
      } else {
        closeDreamModal();
        onConfirm();
      }
    };

    card.querySelector('.dream-modal-cancel').addEventListener('click', cancel);
    card.querySelector('.dream-modal-confirm').addEventListener('click', confirm);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(); });
    // Make overlay focusable for Escape key
    overlay.tabIndex = -1;
    overlay.focus();
  }

  function closeDreamModal() {
    const existing = document.querySelector('.dream-modal-overlay');
    if (existing) existing.remove();
  }

  // --- Status Section ---
  async function renderStatus() {
    try {
      const resp = await fetch('/api/dream/status');
      const status = await resp.json();
      if (status.error) {
        return `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px;">
          <h3 style="margin:0 0 8px;">Dream Mode</h3>
          <p style="color:var(--negative);">noah-memory unreachable</p>
        </div>`;
      }

      const isRunning = status.running;
      const progressPct = isRunning && (status.jobsCompleted + status.jobsRemaining) > 0
        ? Math.round((status.jobsCompleted / (status.jobsCompleted + status.jobsRemaining)) * 100)
        : 0;

      return `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h3 style="margin:0;">Dream Mode</h3>
            <div style="display:flex;gap:8px;">
              <button onclick="window._dreamStart()" style="padding:6px 14px;background:var(--positive);color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;" ${isRunning ? 'disabled' : ''}>Start Cycle</button>
              <button onclick="window._dreamStop()" style="padding:6px 14px;background:var(--negative);color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;" ${!isRunning ? 'disabled' : ''}>Stop</button>
            </div>
          </div>
          ${isRunning ? `
            <div style="margin-bottom:8px;">
              <span style="color:var(--accent);font-weight:500;">Running</span>
              ${status.currentJob ? ` — ${escHtml(status.currentJob)}` : ''}
            </div>
            <div style="background:var(--bg-input);border-radius:4px;height:8px;overflow:hidden;">
              <div style="background:var(--accent);height:100%;width:${progressPct}%;transition:width 0.3s;"></div>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${status.jobsCompleted} / ${status.jobsCompleted + status.jobsRemaining} jobs</div>
          ` : `<div style="color:var(--text-muted);">Idle${status.startedAt ? ` — last started ${new Date(status.startedAt).toLocaleString()}` : ''}</div>`}
        </div>`;
    } catch {
      return '<div style="color:var(--negative);padding:16px;">Failed to load dream status</div>';
    }
  }

  // --- History Section ---
  async function renderHistory() {
    try {
      const resp = await fetch('/api/dream/history');
      const history = await resp.json();
      if (!Array.isArray(history) || history.length === 0) {
        return '<div style="color:var(--text-muted);padding:16px;text-align:center;">No dream cycles yet. Start a cycle to begin.</div>';
      }

      const rows = history.map(c => `
        <tr class="dream-cycle-row" data-cycle-id="${escHtml(c.id)}" style="cursor:pointer;" onclick="window._dreamToggleCycle('${escHtml(c.id)}', this)">
          <td style="padding:8px;">${new Date(c.started_at).toLocaleDateString()} ${new Date(c.started_at).toLocaleTimeString()}</td>
          <td style="padding:8px;">${escHtml(c.trigger)}</td>
          <td style="padding:8px;">${formatDuration(c.started_at, c.ended_at)}</td>
          <td style="padding:8px;color:var(--positive);">${c.jobs_completed}</td>
          <td style="padding:8px;color:var(--negative);">${c.jobs_failed}</td>
          <td style="padding:8px;">${statusBadge(c.status)}</td>
        </tr>
        <tr class="dream-cycle-detail" data-detail-for="${escHtml(c.id)}" style="display:none;">
          <td colspan="6" style="padding:0;"><div class="dream-cycle-results" id="dream-results-${escHtml(c.id)}" style="padding:8px 16px;background:var(--bg);"></div></td>
        </tr>
      `).join('');

      return `
        <div style="margin-bottom:16px;">
          <h3 style="margin:0 0 8px;">Cycle History</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="border-bottom:1px solid var(--border);">
              <th style="padding:8px;text-align:left;">Date</th>
              <th style="padding:8px;text-align:left;">Trigger</th>
              <th style="padding:8px;text-align:left;">Duration</th>
              <th style="padding:8px;text-align:left;">Passed</th>
              <th style="padding:8px;text-align:left;">Failed</th>
              <th style="padding:8px;text-align:left;">Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    } catch {
      return '<div style="color:var(--negative);padding:16px;">Failed to load dream history</div>';
    }
  }

  // --- Actions Section (rich context) ---
  async function renderActions() {
    try {
      const resp = await fetch('/api/dream/actions');
      const actions = await resp.json();

      // Fetch current rules for diff comparison
      const currentRules = await getCachedRules();

      // Undo banners for recently approved items
      const undoEntries = pruneExpiredUndo();
      let undoBanners = '';
      if (undoEntries.length > 0) {
        undoBanners = undoEntries.map(u => {
          const remaining = (u.approved_at + 24 * 60 * 60 * 1000) - Date.now();
          return `
          <div style="background:rgba(76,175,80,0.1);border:1px solid rgba(76,175,80,0.3);border-radius:8px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:13px;">Approved: <strong>${escHtml(u.summary || 'action item')}</strong></span>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;color:var(--text-muted);" data-undo-timer="${u.id}">${formatTimeRemaining(remaining)} remaining</span>
              <button class="dream-undo-btn" data-result-id="${u.id}" style="padding:4px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;">Undo</button>
            </div>
          </div>`;
        }).join('');
      }

      // Filter out rejected duplicates
      const filtered = Array.isArray(actions) ? actions.filter(a => !isRejectedDuplicate(a)) : [];

      if (filtered.length === 0 && undoEntries.length === 0) {
        // Check for deferred items
        const deferred = lsGet(LS_KEYS.DEFERRED);
        if (deferred.length > 0) {
          return `<div style="margin-bottom:16px;"><h3 style="margin:0 0 8px;">Needs Root Action</h3>
            <div style="color:var(--text-muted);padding:8px;text-align:center;margin-bottom:12px;">No new pending actions.</div>
            ${renderDeferredSection(deferred)}
          </div>`;
        }
        return '<div style="color:var(--text-muted);padding:16px;text-align:center;">No pending actions.</div>';
      }

      const cards = filtered.map(a => {
        actionDataStore.set(a.id, { job_name: a.job_name, result_data: a.result_data || '{}', job_category: a.job_category, action_description: a.action_description || '' });
        const ctx = parseResultContext(a.result_data, a.job_name, currentRules);
        const isExpanded = expandedActions.has(a.id);
        const expandedContent = renderExpandedCard(a, ctx);

        return `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:8px;" id="dream-action-${a.id}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            ${categoryBadge(a.job_category)} ${statusBadge(a.status)}
            ${ctx.confidence ? confidenceBadge(ctx.confidence.level) : ''}
            <span style="font-weight:500;">${escHtml(a.job_name)}</span>
          </div>
          <p style="margin:0 0 8px;font-size:13px;">${escHtml(a.action_description || a.result_summary || '')}</p>
          ${ctx.impactScope ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">${escHtml(ctx.impactScope)}</div>` : ''}
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <button class="dream-detail-toggle" data-action-id="${a.id}" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--accent);padding:0;">
              ${isExpanded ? '&#9660; Hide details' : '&#9654; Show details'}
            </button>
          </div>
          <div class="dream-action-detail" data-detail-for="${a.id}" style="display:${isExpanded ? 'block' : 'none'};border-top:1px solid var(--border);padding-top:12px;margin-bottom:12px;">
            ${expandedContent}
          </div>
          <div style="display:flex;gap:8px;">
            <button class="dream-approve-btn" data-result-id="${a.id}" style="padding:6px 14px;background:var(--positive);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Approve</button>
            <button class="dream-reject-btn" data-result-id="${a.id}" style="padding:6px 14px;background:var(--negative);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Reject</button>
            <button class="dream-defer-btn" data-result-id="${a.id}" style="padding:6px 14px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:12px;">Defer</button>
          </div>
        </div>`;
      }).join('');

      const deferred = lsGet(LS_KEYS.DEFERRED);
      const deferredSection = deferred.length > 0 ? renderDeferredSection(deferred) : '';

      return `<div style="margin-bottom:16px;">
        <h3 style="margin:0 0 8px;">Needs Root Action</h3>
        ${undoBanners}${cards}${deferredSection}
      </div>`;
    } catch {
      return '<div style="color:var(--negative);padding:16px;">Failed to load actions</div>';
    }
  }

  // --- Deferred items subsection ---
  function renderDeferredSection(deferred) {
    if (!deferred || deferred.length === 0) return '';

    const items = deferred.map((d, i) => `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:6px;opacity:0.8;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          ${categoryBadge(d.job_category)} <span style="font-weight:500;font-size:13px;">${escHtml(d.job_name)}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--text-muted);">Deferred ${new Date(d.deferred_at).toLocaleDateString()}</span>
        </div>
        <p style="margin:0 0 8px;font-size:12px;color:var(--text-muted);">${escHtml(d.action_description || '')}</p>
        <div style="display:flex;gap:8px;">
          <button class="dream-deferred-review-btn" data-index="${i}" style="padding:3px 10px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;">Review now</button>
          <button class="dream-deferred-dismiss-btn" data-index="${i}" style="padding:3px 10px;background:var(--bg-input);color:var(--text-muted);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;">Dismiss</button>
        </div>
      </div>`).join('');

    return `
      <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;">
        <h4 style="margin:0 0 8px;color:var(--text-muted);font-style:italic;">Deferred for later review (${deferred.length})</h4>
        ${items}
      </div>`;
  }

  // --- Decision History Section ---
  function renderDecisionHistory() {
    const decisions = lsGet(LS_KEYS.DECISIONS);
    if (decisions.length === 0) return '';

    const actionColors = { approved: 'var(--positive)', rejected: 'var(--negative)', deferred: 'var(--text-muted)' };
    const rows = decisions.slice(0, 50).map(d => `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:6px 8px;font-size:12px;">${new Date(d.timestamp).toLocaleDateString()} ${new Date(d.timestamp).toLocaleTimeString()}</td>
        <td style="padding:6px 8px;">${badge(d.action, actionColors[d.action] || 'var(--text-muted)')}</td>
        <td style="padding:6px 8px;font-size:12px;">${escHtml(d.itemSummary || '')}</td>
        <td style="padding:6px 8px;font-size:11px;color:var(--text-muted);">${d.reason ? escHtml(d.reason) : '-'}</td>
      </tr>`).join('');

    return `
      <div style="margin-bottom:16px;">
        <details>
          <summary style="cursor:pointer;font-weight:600;padding:8px 0;">Decision History (${decisions.length})</summary>
          <div style="margin-top:8px;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead><tr style="border-bottom:1px solid var(--border);">
                <th style="padding:6px 8px;text-align:left;">Date</th>
                <th style="padding:6px 8px;text-align:left;">Action</th>
                <th style="padding:6px 8px;text-align:left;">Item</th>
                <th style="padding:6px 8px;text-align:left;">Reason</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
            ${decisions.length > 50 ? `<div style="font-size:11px;color:var(--text-muted);padding:8px;">Showing 50 of ${decisions.length} decisions</div>` : ''}
            <button class="dream-clear-history-btn" style="margin-top:8px;padding:4px 12px;background:var(--bg-input);color:var(--text-muted);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;">Clear history</button>
          </div>
        </details>
      </div>`;
  }

  // --- Cognitive Health Section ---
  async function renderHealth() {
    try {
      const resp = await fetch('/api/dream/health-summary');
      const data = await resp.json();
      if (data.error || data.cycles_analyzed === 0) {
        return `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px;text-align:center;">
          <p style="color:var(--text-muted);">No dream cycle data available yet. Start a dream cycle to see cognitive health metrics.</p>
        </div>`;
      }

      const scorecardHtml = data.rules_scorecard.length > 0
        ? data.rules_scorecard.map(r => {
          const total = r.pass + r.fail;
          const pct = total > 0 ? Math.round((r.pass / total) * 100) : 0;
          return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="font-family:monospace;font-size:12px;min-width:60px;">${escHtml(r.rule_id)}</span>
            <div style="flex:1;background:var(--bg-input);border-radius:4px;height:12px;overflow:hidden;">
              <div style="background:var(--positive);height:100%;width:${pct}%;"></div>
            </div>
            <span style="font-size:11px;min-width:40px;">${r.pass}/${total}</span>
          </div>`;
        }).join('')
        : '<p style="color:var(--text-muted);font-size:12px;">No rule test data yet.</p>';

      const coverageHtml = data.retrieval_coverage_rate !== null
        ? `<div style="margin-top:12px;"><strong>Retrieval Coverage:</strong> ${Math.round(data.retrieval_coverage_rate * 100)}%</div>`
        : '';

      return `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px;">
          <h3 style="margin:0 0 12px;">Cognitive Health <span style="font-size:11px;color:var(--text-muted);">(last ${data.cycles_analyzed} cycles)</span></h3>
          ${scorecardHtml}
          ${coverageHtml}
        </div>`;
    } catch {
      return '';
    }
  }

  // --- Briefing Section ---
  async function renderBriefing() {
    try {
      const resp = await fetch('/api/dream/briefing');
      const data = await resp.json();
      if (!data.briefing) return '';
      return `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px;">
          <h3 style="margin:0 0 8px;">Latest Briefing</h3>
          <div style="font-size:13px;line-height:1.6;">${renderMd(data.briefing)}</div>
        </div>`;
    } catch {
      return '';
    }
  }

  // --- Main render ---
  async function renderDream() {
    // Don't re-render while a modal is open — it would destroy it
    if (document.querySelector('.dream-modal-overlay')) return;

    // Invalidate rules cache for fresh data
    rulesCache = null;

    const parts = await Promise.all([
      renderStatus(),
      renderActions(),
      renderHistory(),
      renderHealth(),
      renderBriefing(),
    ]);

    // Add decision history (sync, from localStorage)
    parts.push(renderDecisionHistory());

    container.innerHTML = parts.join('');
  }

  // --- Global action handlers ---
  window._dreamStart = async function () {
    try {
      await fetch('/api/dream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'manual' }),
      });
      setTimeout(renderDream, 500);
    } catch (err) {
      alert('Failed to start dream cycle: ' + err.message);
    }
  };

  window._dreamStop = async function () {
    try {
      await fetch('/api/dream/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setTimeout(renderDream, 500);
    } catch (err) {
      alert('Failed to stop dream cycle: ' + err.message);
    }
  };

  window._dreamToggleCycle = async function (cycleId, row) {
    const detailRow = document.querySelector(`tr[data-detail-for="${cycleId}"]`);
    if (!detailRow) return;
    const isVisible = detailRow.style.display !== 'none';
    if (isVisible) {
      detailRow.style.display = 'none';
      return;
    }
    detailRow.style.display = '';
    const resultsDiv = document.getElementById(`dream-results-${cycleId}`);
    resultsDiv.innerHTML = '<span style="color:var(--text-muted);">Loading...</span>';
    try {
      const resp = await fetch(`/api/dream/results/${cycleId}`);
      const data = await resp.json();
      if (!data.results || data.results.length === 0) {
        resultsDiv.innerHTML = '<span style="color:var(--text-muted);">No results for this cycle.</span>';
        return;
      }
      resultsDiv.innerHTML = data.results.map(r => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;gap:8px;">
            ${categoryBadge(r.job_category)} ${statusBadge(r.status)}
            <span style="font-weight:500;font-size:13px;">${escHtml(r.job_name)}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--text-muted);">${formatDuration(r.started_at, r.completed_at)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${escHtml(r.result_summary || '')}</div>
        </div>
      `).join('');
    } catch {
      resultsDiv.innerHTML = '<span style="color:var(--negative);">Failed to load cycle results.</span>';
    }
  };

  const ALLOWED_RULE_FIELDS = ['name', 'description', 'prompt_instruction', 'enforcement', 'testable_assertion'];

  window._dreamApprove = function (resultId) {
    const stored = actionDataStore.get(resultId);
    if (!stored) return;

    showDreamModal({
      title: 'Confirm Approval',
      message: `Are you sure you want to approve "${stored.job_name}"? This will apply the proposed changes.`,
      showReasonInput: false,
      onConfirm: async () => {
        // Snapshot current rule state for undo (before applying changes)
        let originalRuleState = null;
        const { job_name: jobName, result_data: resultDataStr } = stored;

        if (jobName === 'thinking_audit' || jobName === 'thinking_audit_review') {
          try {
            const resultData = JSON.parse(resultDataStr);
            if (resultData.rule_id && resultData.proposed_changes) {
              const rulesResp = await fetch('/api/rules');
              const rulesData = await rulesResp.json();
              if (rulesData.rules) {
                const ruleIdx = rulesData.rules.findIndex(r => r.id === resultData.rule_id);
                if (ruleIdx >= 0) {
                  // Snapshot the original state of changed fields
                  originalRuleState = {
                    rule_id: resultData.rule_id,
                    fields: {},
                  };
                  const safe = Object.fromEntries(
                    Object.entries(resultData.proposed_changes).filter(([k]) => ALLOWED_RULE_FIELDS.includes(k))
                  );
                  for (const key of Object.keys(safe)) {
                    originalRuleState.fields[key] = rulesData.rules[ruleIdx][key] || '';
                  }
                  // Apply the changes
                  Object.assign(rulesData.rules[ruleIdx], safe);
                }
                await fetch('/api/rules', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(rulesData),
                });
              }
            }
          } catch (err) {
            console.error('Failed to apply thinking rule amendment:', err);
          }
        }

        // Mark as reviewed
        try {
          await fetch('/api/dream/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ result_id: resultId }),
          });

          // Save undo entry
          lsPush(LS_KEYS.UNDO, {
            id: resultId,
            approved_at: Date.now(),
            summary: jobName,
            original_rule_state: originalRuleState,
          });

          // Save decision record
          lsPush(LS_KEYS.DECISIONS, {
            id: resultId,
            action: 'approved',
            timestamp: Date.now(),
            reason: null,
            itemSummary: jobName,
          });

          renderDream();
        } catch (err) {
          alert('Failed to approve: ' + err.message);
        }
      },
    });
  };

  window._dreamReject = function (resultId) {
    const stored = actionDataStore.get(resultId);
    if (!stored) return;

    showDreamModal({
      title: 'Confirm Rejection',
      message: `Are you sure you want to reject "${stored.job_name}"? Please provide a reason so dream mode can learn from this decision.`,
      showReasonInput: true,
      onConfirm: async (reason) => {
        try {
          await fetch('/api/dream/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ result_id: resultId }),
          });

          // Save decision record with reason
          lsPush(LS_KEYS.DECISIONS, {
            id: resultId,
            action: 'rejected',
            timestamp: Date.now(),
            reason,
            itemSummary: stored.job_name,
          });

          // Hash and store to prevent re-proposal
          const action = { job_name: stored.job_name, result_data: stored.result_data };
          const hash = hashAction(action);
          const hashes = lsGet(LS_KEYS.REJECTED);
          if (!hashes.includes(hash)) {
            hashes.push(hash);
            // Cap at 500 hashes
            if (hashes.length > 500) hashes.splice(0, hashes.length - 500);
            lsSet(LS_KEYS.REJECTED, hashes);
          }

          renderDream();
        } catch (err) {
          alert('Failed to reject: ' + err.message);
        }
      },
    });
  };

  window._dreamDefer = async function (resultId) {
    const stored = actionDataStore.get(resultId);
    if (!stored) return;

    // No confirmation needed for defer
    // Save to deferred queue — use stored data + actionDataStore (no extra fetch)
    lsPush(LS_KEYS.DEFERRED, {
      id: resultId,
      job_name: stored.job_name,
      job_category: stored.job_category || 'unknown',
      action_description: stored.action_description || '',
      result_data: stored.result_data,
      deferred_at: Date.now(),
    });

    lsPush(LS_KEYS.DECISIONS, {
      id: resultId,
      action: 'deferred',
      timestamp: Date.now(),
      reason: null,
      itemSummary: stored.job_name,
    });

    // Mark as reviewed on the server so it clears from pending
    try {
      await fetch('/api/dream/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result_id: resultId }),
      });
      renderDream();
    } catch (err) {
      alert('Failed to defer: ' + err.message);
    }
  };

  window._dreamUndo = async function (resultId) {
    const entry = getUndoEntry(resultId);
    if (!entry) {
      alert('Undo window has expired.');
      renderDream();
      return;
    }

    // Revert rule changes if we have original state
    if (entry.original_rule_state) {
      try {
        const rulesResp = await fetch('/api/rules');
        const rulesData = await rulesResp.json();
        if (rulesData.rules) {
          const ruleIdx = rulesData.rules.findIndex(r => r.id === entry.original_rule_state.rule_id);
          if (ruleIdx >= 0) {
            // Restore original field values
            Object.assign(rulesData.rules[ruleIdx], entry.original_rule_state.fields);
            await fetch('/api/rules', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(rulesData),
            });
          }
        }
      } catch (err) {
        alert('Failed to revert rule changes: ' + err.message);
        return;
      }
    }

    // Remove undo entry
    const entries = lsGet(LS_KEYS.UNDO);
    lsSet(LS_KEYS.UNDO, entries.filter(e => e.id !== resultId));

    // Update decision history
    lsPush(LS_KEYS.DECISIONS, {
      id: resultId,
      action: 'approved',
      timestamp: Date.now(),
      reason: 'UNDONE — reverted to previous state',
      itemSummary: entry.summary + ' (undo)',
    });

    renderDream();
  };

  window._dreamDeferredReview = function (index) {
    const deferred = lsGet(LS_KEYS.DEFERRED);
    if (index >= 0 && index < deferred.length) {
      const item = deferred[index];
      // Remove from deferred
      deferred.splice(index, 1);
      lsSet(LS_KEYS.DEFERRED, deferred);
      // Store its data so it can be rendered as a pending action
      actionDataStore.set(item.id, { job_name: item.job_name, result_data: item.result_data || '{}', job_category: item.job_category, action_description: item.action_description || '' });
      expandedActions.add(item.id);
      renderDream();
    }
  };

  window._dreamDeferredDismiss = function (index) {
    const deferred = lsGet(LS_KEYS.DEFERRED);
    if (index >= 0 && index < deferred.length) {
      deferred.splice(index, 1);
      lsSet(LS_KEYS.DEFERRED, deferred);
      renderDream();
    }
  };

  window._dreamClearHistory = function () {
    if (!confirm('Clear all decision history? This cannot be undone.')) return;
    lsSet(LS_KEYS.DECISIONS, []);
    renderDream();
  };

  // Event delegation for all interactive buttons
  container.addEventListener('click', (e) => {
    const approveBtn = e.target.closest('.dream-approve-btn');
    if (approveBtn) {
      window._dreamApprove(Number(approveBtn.dataset.resultId));
      return;
    }
    const rejectBtn = e.target.closest('.dream-reject-btn');
    if (rejectBtn) {
      window._dreamReject(Number(rejectBtn.dataset.resultId));
      return;
    }
    const deferBtn = e.target.closest('.dream-defer-btn');
    if (deferBtn) {
      window._dreamDefer(Number(deferBtn.dataset.resultId));
      return;
    }
    const detailToggle = e.target.closest('.dream-detail-toggle');
    if (detailToggle) {
      const actionId = Number(detailToggle.dataset.actionId);
      if (expandedActions.has(actionId)) {
        expandedActions.delete(actionId);
      } else {
        expandedActions.add(actionId);
      }
      // Re-render just the toggle state without a full fetch
      const detail = document.querySelector(`.dream-action-detail[data-detail-for="${actionId}"]`);
      if (detail) {
        const isNowExpanded = expandedActions.has(actionId);
        detail.style.display = isNowExpanded ? 'block' : 'none';
        detailToggle.innerHTML = isNowExpanded ? '&#9660; Hide details' : '&#9654; Show details';
      }
      return;
    }
    const undoBtn = e.target.closest('.dream-undo-btn');
    if (undoBtn) {
      window._dreamUndo(Number(undoBtn.dataset.resultId));
      return;
    }
    const deferredReviewBtn = e.target.closest('.dream-deferred-review-btn');
    if (deferredReviewBtn) {
      window._dreamDeferredReview(Number(deferredReviewBtn.dataset.index));
      return;
    }
    const deferredDismissBtn = e.target.closest('.dream-deferred-dismiss-btn');
    if (deferredDismissBtn) {
      window._dreamDeferredDismiss(Number(deferredDismissBtn.dataset.index));
      return;
    }
    const clearHistoryBtn = e.target.closest('.dream-clear-history-btn');
    if (clearHistoryBtn) {
      window._dreamClearHistory();
      return;
    }
  });

  // Action filter
  if (actionFilter) {
    actionFilter.addEventListener('change', renderDream);
  }

  // Undo timer updater — refresh countdown every 60 seconds
  setInterval(() => {
    const timers = document.querySelectorAll('[data-undo-timer]');
    timers.forEach(el => {
      const resultId = Number(el.dataset.undoTimer);
      const entry = getUndoEntry(resultId);
      if (entry) {
        const remaining = (entry.approved_at + 24 * 60 * 60 * 1000) - Date.now();
        el.textContent = formatTimeRemaining(remaining) + ' remaining';
      } else {
        el.textContent = 'expired';
      }
    });
  }, 60000);

  registerTab('dream', {
    init() {
      renderDream();
      refreshInterval = setInterval(renderDream, 30_000);
    },
    refresh() {
      renderDream();
      if (!refreshInterval) refreshInterval = setInterval(renderDream, 30_000);
    },
    destroy() {
      if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
    }
  });
})();
