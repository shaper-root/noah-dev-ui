// Analytics module — stats bar, per-message timing, conversation avg
(function () {
  let refreshInterval = null;

  function safeNum(v) { const n = Number(v); return isNaN(n) ? '?' : n; }

  function formatMs(ms) {
    if (ms === null || ms === undefined) return '-';
    return (Number(ms) / 1000).toFixed(1) + 's';
  }

  async function renderStatsBar() {
    const statsBar = document.getElementById('analytics-stats-bar');
    if (!statsBar) return;

    try {
      const resp = await fetch('/api/analytics/stats');
      const stats = await resp.json();

      statsBar.innerHTML = `
        <div class="stat-card">
          <div class="stat-value">${safeNum(stats.messages_today)}</div>
          <div class="stat-label">Messages today</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${formatMs(stats.avg_response_time_ms)}</div>
          <div class="stat-label">Avg response</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${safeNum(stats.flags_today)}</div>
          <div class="stat-label">Flags today</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${safeNum(stats.memory_operations_today)}</div>
          <div class="stat-label">Memory ops</div>
        </div>`;
    } catch {
      statsBar.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:4px;">Stats unavailable</div>';
    }
  }

  function injectStatsBar() {
    if (document.getElementById('analytics-stats-bar')) return;

    const messagesDiv = document.getElementById('messages');
    if (!messagesDiv) return;

    const statsBar = document.createElement('div');
    statsBar.id = 'analytics-stats-bar';
    statsBar.style.cssText = 'display:flex;gap:8px;padding:8px 20px;border-bottom:1px solid var(--border);flex-shrink:0;';

    // Inject styles for stat cards
    if (!document.getElementById('analytics-styles')) {
      const style = document.createElement('style');
      style.id = 'analytics-styles';
      style.textContent = `
        .stat-card { flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:8px 12px;text-align:center; }
        .stat-value { font-size:16px;font-weight:600;color:var(--accent); }
        .stat-label { font-size:10px;color:var(--text-muted);margin-top:2px; }
      `;
      document.head.appendChild(style);
    }

    // Insert before messages div
    messagesDiv.parentElement.insertBefore(statsBar, messagesDiv);
    renderStatsBar();
  }

  registerEnhancement('chat', {
    init() {
      injectStatsBar();
      renderStatsBar();
      refreshInterval = setInterval(renderStatsBar, 60_000);
    },
    refresh() {
      renderStatsBar();
      if (!refreshInterval) refreshInterval = setInterval(renderStatsBar, 60_000);
    },
    destroy() {
      if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
    }
  });
})();
