// Dashboard module — system health overview
(function () {
  let refreshInterval = null;
  const container = document.getElementById('dashboard-content');

  function escHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

  function statusIcon(status) {
    switch (status) {
      case 'ok': return '<span style="color:var(--positive)">&#x2705;</span>';
      case 'degraded': return '<span style="color:var(--flag)">&#x26A0;&#xFE0F;</span>';
      case 'down': return '<span style="color:var(--negative)">&#x274C;</span>';
      default: return '<span style="color:var(--text-muted)">&#x2753;</span>';
    }
  }

  function formatSince(since) {
    if (!since) return 'unknown';
    const d = new Date(since);
    const now = new Date();
    const diffMs = now - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
    return d.toLocaleString();
  }

  function renderDashboard(data) {
    if (data.error && !data.services) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px;">
          <div style="font-size:48px;margin-bottom:16px;">&#x26A0;&#xFE0F;</div>
          <h2 style="color:var(--negative);margin-bottom:8px;">Watchdog Unreachable</h2>
          <p style="color:var(--text-muted);">${escHtml(data.error)}</p>
          <p style="color:var(--text-muted);font-size:12px;margin-top:16px;">Expected at localhost:6790</p>
        </div>`;
      return;
    }

    const bannerColor = data.healthy ? 'var(--positive)' : 'var(--negative)';
    const bannerText = data.healthy
      ? (data.grace_period ? 'Healthy (grace period)' : 'All Systems Healthy')
      : 'System Degraded';
    const bannerIcon = data.healthy ? '&#x2705;' : '&#x26A0;&#xFE0F;';

    const services = data.services || {};
    const serviceCards = Object.entries(services).map(([name, svc]) => {
      const label = escHtml(name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
      return `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;min-width:180px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            ${statusIcon(svc.status)}
            <span style="font-weight:600;font-size:14px;">${label}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);">
            Status: <span style="color:${svc.status === 'ok' ? 'var(--positive)' : svc.status === 'degraded' ? 'var(--flag)' : 'var(--negative)'}">${escHtml(svc.status)}</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Since: ${escHtml(formatSince(svc.since))}</div>
        </div>`;
    }).join('');

    const canary = data.canary || {};
    const canaryCard = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;min-width:180px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          ${statusIcon(canary.status === 'ok' ? 'ok' : canary.status === 'fail' ? 'down' : 'unknown')}
          <span style="font-weight:600;font-size:14px;">Canary</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);">
          Status: <span style="color:${canary.status === 'ok' ? 'var(--positive)' : 'var(--negative)'}">${escHtml(canary.status || 'unknown')}</span>
        </div>
      </div>`;

    const degradationHtml = (data.degradation_messages && data.degradation_messages.length > 0)
      ? `<div style="background:var(--negative);color:white;padding:12px 16px;border-radius:8px;margin-bottom:16px;">
          <strong>Degradation:</strong>
          <ul style="margin:8px 0 0 16px;">${data.degradation_messages.map(m => `<li>${escHtml(m)}</li>`).join('')}</ul>
        </div>`
      : '';

    container.innerHTML = `
      <div style="background:${bannerColor};color:white;padding:16px 20px;border-radius:8px;margin-bottom:20px;display:flex;align-items:center;gap:12px;">
        <span style="font-size:24px;">${bannerIcon}</span>
        <span style="font-size:18px;font-weight:600;">${bannerText}</span>
        <span style="margin-left:auto;font-size:12px;opacity:0.8;">Last check: ${new Date().toLocaleTimeString()}</span>
      </div>
      ${degradationHtml}
      <div style="display:flex;flex-wrap:wrap;gap:12px;">
        ${serviceCards}
        ${canaryCard}
      </div>
      <div id="shannon-metrics"></div>
      <div style="margin-top:20px;font-size:11px;color:var(--text-muted);">Auto-refreshes every 30 seconds</div>`;
  }

  function renderShannonMetrics(data) {
    if (data.error) {
      return `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-top:20px;">
          <h3 style="margin:0 0 8px;font-size:14px;color:var(--text-muted);">Shannon Encoding</h3>
          <div style="color:var(--text-muted);font-size:12px;">Metrics unavailable</div>
        </div>`;
    }

    const online = data.shannon_online;
    const statusColor = online ? 'var(--positive)' : 'var(--text-muted)';
    const statusText = online ? 'Online' : 'Offline';
    const ratio = data.avg_compression_ratio != null
      ? (data.avg_compression_ratio * 100).toFixed(1) + '%'
      : 'N/A';
    const saved = data.total_storage_saved_bytes > 0
      ? formatBytes(data.total_storage_saved_bytes)
      : '0 B';
    const p50 = data.encode_latency_p50_ms != null
      ? data.encode_latency_p50_ms.toFixed(1) + 'ms'
      : 'N/A';
    const p95 = data.encode_latency_p95_ms != null
      ? data.encode_latency_p95_ms.toFixed(1) + 'ms'
      : 'N/A';
    const lastEncode = data.last_encode_at
      ? new Date(data.last_encode_at + 'Z').toLocaleString()
      : 'Never';
    const version = data.latest_codebook_version || 'N/A';

    const typeRows = (data.avg_compression_by_type || []).map(t =>
      `<tr>
        <td style="padding:2px 8px;font-size:12px;">${escHtml(t.type)}</td>
        <td style="padding:2px 8px;font-size:12px;">${(t.avg_ratio * 100).toFixed(1)}%</td>
        <td style="padding:2px 8px;font-size:12px;color:var(--text-muted);">${t.count}</td>
      </tr>`
    ).join('');

    return `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-top:20px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <h3 style="margin:0;font-size:14px;">Shannon Encoding</h3>
          <span style="color:${statusColor};font-size:12px;font-weight:600;">${statusText}</span>
          ${version !== 'N/A' ? `<span style="color:var(--text-muted);font-size:11px;margin-left:auto;">Codebook: ${escHtml(version)}</span>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:12px;">
          <div>
            <div style="font-size:11px;color:var(--text-muted);">Encoded</div>
            <div style="font-size:18px;font-weight:600;">${data.total_encoded}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);">Raw</div>
            <div style="font-size:18px;font-weight:600;">${data.total_raw}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);">Avg Ratio</div>
            <div style="font-size:18px;font-weight:600;">${ratio}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);">Storage Saved</div>
            <div style="font-size:18px;font-weight:600;">${saved}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);">Latency p50</div>
            <div style="font-size:18px;font-weight:600;">${p50}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);">Latency p95</div>
            <div style="font-size:18px;font-weight:600;">${p95}</div>
          </div>
        </div>
        ${typeRows ? `
          <div style="margin-top:8px;">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">By Memory Type</div>
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr>
                <th style="text-align:left;padding:2px 8px;font-size:11px;color:var(--text-muted);">Type</th>
                <th style="text-align:left;padding:2px 8px;font-size:11px;color:var(--text-muted);">Avg Ratio</th>
                <th style="text-align:left;padding:2px 8px;font-size:11px;color:var(--text-muted);">Count</th>
              </tr></thead>
              <tbody>${typeRows}</tbody>
            </table>
          </div>` : ''}
        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">Last encode: ${escHtml(lastEncode)}</div>
      </div>`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function loadShannonMetrics() {
    try {
      const resp = await fetch('/api/dashboard/shannon');
      const data = await resp.json();
      const shannonEl = document.getElementById('shannon-metrics');
      if (shannonEl) {
        shannonEl.innerHTML = renderShannonMetrics(data);
      }
    } catch {
      const shannonEl = document.getElementById('shannon-metrics');
      if (shannonEl) {
        shannonEl.innerHTML = renderShannonMetrics({ error: true });
      }
    }
  }

  async function loadDashboard() {
    try {
      const resp = await fetch('/api/dashboard/status');
      const data = await resp.json();
      renderDashboard(data);
    } catch (err) {
      renderDashboard({ error: 'Failed to fetch dashboard status', healthy: false });
    }
    loadShannonMetrics();
  }

  registerTab('dashboard', {
    init() {
      loadDashboard();
      refreshInterval = setInterval(loadDashboard, 30_000);
    },
    refresh() {
      loadDashboard();
      if (!refreshInterval) refreshInterval = setInterval(loadDashboard, 30_000);
    },
    destroy() {
      if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
    }
  });
})();
