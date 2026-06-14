const rowsEl = document.querySelector('#rows');
const statusEl = document.querySelector('#statusText');
const updatedEl = document.querySelector('#updatedText');
const refreshBtn = document.querySelector('#refreshBtn');
const apiBase = window.MONITOR_API_BASE || '';

refreshBtn.addEventListener('click', () => loadStats(true));
loadStats(false);

async function loadStats(force) {
  refreshBtn.disabled = true;
  statusEl.textContent = force ? '正在刷新' : '加载中';
  try {
    const res = await fetch(`${apiBase}/api/stats${force ? '?refresh=true' : ''}`);
    const data = await res.json();
    renderRows(data.data || []);
    statusEl.textContent = data.success ? '运行正常' : data.message || data.status || '暂无数据';
    updatedEl.textContent = data.refreshed_at ? new Date(data.refreshed_at * 1000).toLocaleString() : '-';
  } catch (error) {
    statusEl.textContent = error.message || '加载失败';
  } finally {
    refreshBtn.disabled = false;
  }
}

function renderRows(rows) {
  if (!rows.length) {
    rowsEl.innerHTML = '<tr><td colspan="4">暂无统计数据</td></tr>';
    return;
  }
  rowsEl.innerHTML = rows
    .map(
      (row) => `<tr>
        <td class="group">${escapeHtml(row.group || 'default')}</td>
        <td>${renderMetric(row.one_hour)}</td>
        <td>${renderMetric(row.thirty_minute)}</td>
        <td>${renderMetric(row.five_minute)}</td>
      </tr>`,
    )
    .join('');
}

function renderMetric(metric = {}) {
  const rate = Number(metric.success_rate || 0);
  const total = Number(metric.total || 0);
  const success = Number(metric.success || 0);
  const failed = Number(metric.failed || 0);
  return `<div class="metric">
    <div class="metric-head">
      <span class="rate">${rate.toFixed(2)}%</span>
      <span class="minor">${total}</span>
    </div>
    <div class="bar"><span style="width:${Math.max(0, Math.min(100, rate))}%"></span></div>
    <div class="minor">S ${success} / F ${failed}</div>
  </div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[char]);
}
