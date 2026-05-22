// Chat Management module — rename, archive, delete, multi-select flags
(function () {
  // Enhance the conversation list rendering
  const origLoadConversations = window.loadConversations;

  // Track archive view state
  let showArchived = false;

  // Override loadConversations to add management controls
  window.loadConversations = async function () {
    const archived = showArchived ? 1 : 0;
    const resp = await fetch(`/api/conversations?archived=${archived}`);
    const conversations = await resp.json();
    const convList = document.getElementById('conversation-list');

    // Add archive toggle at the top
    let toggleHtml = `<div style="padding:4px 8px;margin-bottom:8px;">
      <label style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" id="show-archived-toggle" ${showArchived ? 'checked' : ''}> Show archived
      </label>
    </div>`;

    const itemsHtml = conversations.map(conv => {
      const isActive = conv.id === currentConversationId;
      return `
        <div class="conversation-item${isActive ? ' active' : ''}" data-id="${conv.id}">
          <div class="conv-title-row" style="display:flex;align-items:center;gap:4px;">
            <span class="conv-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" onclick="loadConversation('${conv.id}')" title="Click to open, double-click to rename">${escapeHtml(conv.title)}</span>
            <span class="conv-actions" style="display:flex;gap:2px;flex-shrink:0;">
              <button onclick="window._renameConv('${conv.id}', this)" title="Rename" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-muted);padding:2px;">&#x270F;</button>
              ${showArchived
                ? `<button onclick="window._unarchiveConv('${conv.id}')" title="Unarchive" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-muted);padding:2px;">&#x1F4E4;</button>`
                : `<button onclick="window._archiveConv('${conv.id}')" title="Archive" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-muted);padding:2px;">&#x1F4E5;</button>`
              }
              <button onclick="window._deleteConv('${conv.id}')" title="Delete" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--negative);padding:2px;">&#x1F5D1;</button>
            </span>
          </div>
          ${conv.avg_response_time ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Avg: ${(conv.avg_response_time / 1000).toFixed(1)}s</div>` : ''}
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${new Date(conv.updated_at).toLocaleDateString()}</div>
        </div>`;
    }).join('');

    convList.innerHTML = toggleHtml + (itemsHtml || '<div style="text-align:center;color:var(--text-muted);padding:20px;">No conversations</div>');

    // Bind archive toggle
    const toggle = document.getElementById('show-archived-toggle');
    if (toggle) {
      toggle.addEventListener('change', () => {
        showArchived = toggle.checked;
        window.loadConversations();
      });
    }
  };

  // Rename conversation
  window._renameConv = function (id, btn) {
    const titleEl = btn.closest('.conv-title-row').querySelector('.conv-title');
    const current = titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.style.cssText = 'width:100%;padding:2px 4px;background:var(--bg-input);border:1px solid var(--accent);border-radius:4px;color:var(--text);font-size:12px;';

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    async function save() {
      const newTitle = input.value.trim();
      if (newTitle && newTitle !== current) {
        await fetch(`/api/conversations/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
      }
      window.loadConversations();
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { window.loadConversations(); }
    });
  };

  // Archive conversation
  window._archiveConv = async function (id) {
    await fetch(`/api/conversations/${id}/archive`, { method: 'PUT' });
    if (currentConversationId === id) {
      currentConversationId = null;
    }
    window.loadConversations();
  };

  // Unarchive conversation
  window._unarchiveConv = async function (id) {
    await fetch(`/api/conversations/${id}/unarchive`, { method: 'PUT' });
    window.loadConversations();
  };

  // Delete with confirmation
  window._deleteConv = async function (id) {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (currentConversationId === id) {
      currentConversationId = null;
      document.getElementById('messages').innerHTML = `
        <div class="empty-state">
          <h1>Noah Dev UI</h1>
          <p>Start a conversation to test Noah's brain.</p>
        </div>`;
    }
    window.loadConversations();
  };

  // Enhanced flag dropdown — multi-select
  window._showFlagDropdown = function (messageId, btn) {
    // Remove any existing dropdown
    const existing = document.querySelector('.flag-multi-dropdown');
    if (existing) existing.remove();

    const categories = [
      { value: 'wrong_answer', label: 'Wrong answer' },
      { value: 'too_confident', label: 'Too confident' },
      { value: 'hallucination', label: 'Hallucination' },
      { value: 'off_topic', label: 'Off-topic' },
      { value: 'bad_tone', label: 'Bad tone' },
      { value: 'other', label: 'Other' },
    ];

    const dropdown = document.createElement('div');
    dropdown.className = 'flag-multi-dropdown';
    dropdown.style.cssText = 'position:absolute;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:8px;z-index:100;min-width:160px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';

    dropdown.innerHTML = categories.map(c =>
      `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;cursor:pointer;">
        <input type="checkbox" value="${c.value}"> ${c.label}
      </label>`
    ).join('') + `<button onclick="window._submitFlags('${messageId}', this)" style="margin-top:8px;width:100%;padding:4px;background:var(--flag);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-size:12px;">Submit Flags</button>`;

    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(dropdown);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function close(e) {
        if (!dropdown.contains(e.target) && e.target !== btn) {
          dropdown.remove();
          document.removeEventListener('click', close);
        }
      });
    }, 0);
  };

  window._submitFlags = async function (messageId, submitBtn) {
    const dropdown = submitBtn.closest('.flag-multi-dropdown');
    const checked = dropdown.querySelectorAll('input[type="checkbox"]:checked');
    for (const cb of checked) {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: messageId, type: 'flag', category: cb.value }),
      });
    }
    dropdown.remove();
  };

  registerEnhancement('chat', {
    init() { /* loadConversations already overridden */ },
    refresh() {},
    destroy() {}
  });
})();
