// Thinking Rules module — view, edit, approve/reject amendments
(function () {
  const container = document.getElementById('rules-content');
  let rulesData = null;

  function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  const ALLOWED_RULE_FIELDS = ['name', 'description', 'prompt_instruction', 'enforcement', 'testable_assertion'];
  const amendmentDataStore = new Map(); // result_id -> amendment object

  function enforcementBadge(level) {
    const color = level === 'hard' ? 'var(--negative)' : 'var(--flag)';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:${color};color:white;">${escHtml(level)}</span>`;
  }

  function categoryBadge(cat) {
    const colors = { evidence: '#2196f3', certainty: '#9c27b0', updating: '#ff9800', metacognition: '#4caf50', freshness: '#607d8b' };
    const color = colors[cat] || '#607d8b';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:${color};color:white;">${escHtml(cat)}</span>`;
  }

  async function loadRules() {
    try {
      const resp = await fetch('/api/rules');
      rulesData = await resp.json();
      if (rulesData.error) {
        container.innerHTML = `<div style="text-align:center;padding:40px;">
          <p style="color:var(--negative);">${escHtml(rulesData.error)}</p>
          <p style="color:var(--text-muted);font-size:12px;">Expected at: homeassistant/custom_components/noah/thinking_rules.json</p>
        </div>`;
        return;
      }
      renderRules();
      loadAudit();
    } catch (err) {
      container.innerHTML = `<div style="color:var(--negative);padding:20px;">Failed to load rules: ${escHtml(err.message)}</div>`;
    }
  }

  function renderRules() {
    if (!rulesData || !rulesData.rules) return;

    const header = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 style="margin:0;">Thinking Rules</h2>
        <div style="font-size:12px;color:var(--text-muted);">
          v${escHtml(rulesData.version || '?')} &middot; Updated: ${escHtml(rulesData.updated_at || '?')} by ${escHtml(rulesData.updated_by || '?')}
        </div>
      </div>`;

    const cards = rulesData.rules.map((rule, idx) => `
      <div class="rule-card" id="rule-${escHtml(rule.id)}" style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span style="font-family:monospace;font-weight:600;font-size:14px;color:var(--accent);">${escHtml(rule.id)}</span>
          ${categoryBadge(rule.category)}
          ${enforcementBadge(rule.enforcement)}
          <span style="font-weight:500;flex:1;">${escHtml(rule.name)}</span>
          <button onclick="window._editRule(${idx})" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;padding:4px 10px;font-size:11px;color:var(--text-muted);">Edit</button>
        </div>
        <p style="margin:0 0 8px;font-size:13px;color:var(--text);">${escHtml(rule.description)}</p>
        <details style="font-size:12px;color:var(--text-muted);">
          <summary style="cursor:pointer;margin-bottom:4px;">Details</summary>
          <div style="margin-top:8px;">
            <div style="margin-bottom:8px;"><strong>Prompt instruction:</strong><br>${escHtml(rule.prompt_instruction)}</div>
            <div><strong>Testable assertion:</strong><br>${escHtml(rule.testable_assertion)}</div>
            ${rule.added ? `<div style="margin-top:8px;font-size:11px;">Added: ${escHtml(rule.added)}${rule.updated ? ` | Updated: ${escHtml(rule.updated)}` : ''}</div>` : ''}
          </div>
        </details>
      </div>`
    ).join('');

    const amendmentsSection = '<div id="rules-amendments"></div>';

    container.innerHTML = header + cards + amendmentsSection;
  }

  async function loadAudit() {
    const amendDiv = document.getElementById('rules-amendments');
    if (!amendDiv) return;

    try {
      const resp = await fetch('/api/rules/audit');
      const data = await resp.json();
      if (!data.amendments || data.amendments.length === 0) {
        amendDiv.innerHTML = '';
        return;
      }

      amendDiv.innerHTML = `
        <h3 style="margin:16px 0 8px;">Proposed Amendments</h3>
        ${data.amendments.map(a => {
          amendmentDataStore.set(a.result_id, a);
          return `
          <div style="background:var(--bg-card);border:1px solid var(--flag);border-radius:8px;padding:16px;margin-bottom:8px;">
            <div style="margin-bottom:8px;font-size:13px;">
              ${a.rule_id ? `<strong>Rule:</strong> ${escHtml(a.rule_id)} &middot; ` : ''}
              ${a.amendment_type ? `<strong>Type:</strong> ${escHtml(a.amendment_type)}` : ''}
            </div>
            ${a.reasoning ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px;">${escHtml(a.reasoning)}</p>` : ''}
            ${a.action_description ? `<p style="font-size:12px;margin:0 0 8px;">${escHtml(a.action_description)}</p>` : ''}
            <div style="display:flex;gap:8px;">
              <button class="amend-approve-btn" data-result-id="${a.result_id}" style="padding:4px 12px;background:var(--positive);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Approve</button>
              <button class="amend-reject-btn" data-result-id="${a.result_id}" style="padding:4px 12px;background:var(--negative);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Reject</button>
            </div>
          </div>`;
        }).join('')}`;
    } catch {
      amendDiv.innerHTML = '';
    }
  }

  // Edit a rule inline
  window._editRule = function (idx) {
    if (!rulesData || !rulesData.rules[idx]) return;
    const rule = rulesData.rules[idx];
    const card = document.getElementById(`rule-${rule.id}`);
    if (!card) return;

    card.innerHTML = `
      <div style="margin-bottom:8px;font-family:monospace;font-weight:600;color:var(--accent);">${escHtml(rule.id)} — Editing</div>
      <label style="font-size:12px;display:block;margin-bottom:8px;">
        Name: <input type="text" id="edit-name" value="${escHtml(rule.name)}" style="width:100%;padding:4px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);margin-top:2px;">
      </label>
      <label style="font-size:12px;display:block;margin-bottom:8px;">
        Description: <textarea id="edit-desc" style="width:100%;padding:4px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);min-height:60px;margin-top:2px;">${escHtml(rule.description)}</textarea>
      </label>
      <label style="font-size:12px;display:block;margin-bottom:8px;">
        Prompt instruction: <textarea id="edit-prompt" style="width:100%;padding:4px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);min-height:80px;margin-top:2px;">${escHtml(rule.prompt_instruction)}</textarea>
      </label>
      <label style="font-size:12px;display:block;margin-bottom:8px;">
        Enforcement:
        <select id="edit-enforcement" style="padding:4px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text);margin-top:2px;">
          <option value="hard" ${rule.enforcement === 'hard' ? 'selected' : ''}>Hard</option>
          <option value="soft" ${rule.enforcement === 'soft' ? 'selected' : ''}>Soft</option>
        </select>
      </label>
      <div style="display:flex;gap:8px;">
        <button onclick="window._saveRule(${idx})" style="padding:6px 16px;background:var(--positive);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Save</button>
        <button onclick="renderRules()" style="padding:6px 16px;background:var(--text-muted);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Cancel</button>
      </div>`;
  };

  window._saveRule = async function (idx) {
    const rule = rulesData.rules[idx];
    rule.name = document.getElementById('edit-name').value;
    rule.description = document.getElementById('edit-desc').value;
    rule.prompt_instruction = document.getElementById('edit-prompt').value;
    rule.enforcement = document.getElementById('edit-enforcement').value;
    rule.updated = new Date().toISOString().split('T')[0];

    try {
      const resp = await fetch('/api/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rulesData),
      });
      const result = await resp.json();
      if (result.ok) {
        loadRules();
      } else {
        alert('Failed to save: ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Failed to save rules: ' + err.message);
    }
  };

  window._approveAmendment = async function (resultId) {
    const amendment = amendmentDataStore.get(resultId);
    if (amendment && amendment.rule_id && amendment.proposed_changes && rulesData) {
      try {
        const ruleIdx = rulesData.rules.findIndex(r => r.id === amendment.rule_id);
        if (ruleIdx >= 0) {
          const safe = Object.fromEntries(
            Object.entries(amendment.proposed_changes).filter(([k]) => ALLOWED_RULE_FIELDS.includes(k))
          );
          Object.assign(rulesData.rules[ruleIdx], safe);
          await fetch('/api/rules', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rulesData),
          });
        }
      } catch { /* skip */ }
    }

    try {
      await fetch('/api/dream/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result_id: resultId }),
      });
      loadRules();
    } catch (err) {
      alert('Failed to approve: ' + err.message);
    }
  };

  window._rejectAmendment = async function (resultId) {
    try {
      await fetch('/api/dream/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result_id: resultId }),
      });
      loadRules();
    } catch (err) {
      alert('Failed to reject: ' + err.message);
    }
  };

  // Make renderRules available for cancel button
  window._rulesRender = renderRules;

  // Event delegation for amendment buttons
  container.addEventListener('click', (e) => {
    const approveBtn = e.target.closest('.amend-approve-btn');
    if (approveBtn) {
      window._approveAmendment(Number(approveBtn.dataset.resultId));
      return;
    }
    const rejectBtn = e.target.closest('.amend-reject-btn');
    if (rejectBtn) {
      window._rejectAmendment(Number(rejectBtn.dataset.resultId));
      return;
    }
  });

  registerTab('rules', {
    init() { loadRules(); },
    refresh() { loadRules(); },
    destroy() {}
  });
})();
