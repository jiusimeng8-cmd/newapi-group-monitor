const rowsEl = document.querySelector('#rows');
const statusEl = document.querySelector('#statusText');
const updatedEl = document.querySelector('#updatedText');
const nextUpdateEl = document.querySelector('#nextUpdateText');
const groupCountEl = document.querySelector('#groupCount');
const configStatusEl = document.querySelector('#configStatus');
const apiBase = window.MONITOR_API_BASE || '';
const DEFAULT_REFRESH_SECONDS = 60;
const OK_RATE = 90;
const WARN_RATE = 80;
const HISTORY_MIN_BAD_SAMPLES = 10;
let refreshSeconds = DEFAULT_REFRESH_SECONDS;
let nextRefreshAt = 0;
let loading = false;

loadStats(false);
setInterval(tickAutoRefresh, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() >= nextRefreshAt) {
    loadStats(true);
  }
});

async function loadStats(force) {
  if (loading) return;
  loading = true;
  statusEl.textContent = force ? '正在刷新' : '加载中';
  try {
    const res = await fetch(`${apiBase}/api/stats${force ? '?refresh=true' : ''}`);
    const data = await res.json();
    refreshSeconds = normalizeRefreshSeconds(data.refresh_interval_seconds);
    nextRefreshAt = Date.now() + refreshSeconds * 1000;
    renderRows(data.data || []);
    statusEl.textContent = formatStatusText(data);
    configStatusEl.textContent = data.success ? '正在展示' : '等待数据';
    updatedEl.textContent = data.refreshed_at
      ? `更新于 ${new Date(data.refreshed_at * 1000).toLocaleString()}`
      : '尚未更新';
  } catch (error) {
    statusEl.textContent = error.message || '加载失败';
    configStatusEl.textContent = '连接异常';
  } finally {
    loading = false;
    updateCountdown();
  }
}

function formatStatusText(data) {
  if (data.success) return '运行正常';
  if (data.status === 'stale') return '数据刷新异常';
  return data.message || data.status || '暂无数据';
}

function renderRows(rows) {
  groupCountEl.textContent = `${rows.length} 个分组`;
  if (!rows.length) {
    rowsEl.innerHTML = '<article class="empty-board">暂无统计数据</article>';
    return;
  }
  rowsEl.innerHTML = rows
    .map((row, index) => renderGroupCard(row, index))
    .join('');
}

function renderGroupCard(row, index) {
  const oneHour = normalizeMetric(row.one_hour);
  const thirtyMinute = normalizeMetric(row.thirty_minute);
  const fiveMinute = normalizeMetric(row.five_minute);
  const health = getHealth(fiveMinute);
  const bars = renderHistoryBars(row.history || []);
  return `<article class="group-card">
    <div class="card-head">
      <h2>${escapeHtml(row.group || 'default')}</h2>
      <span class="status-badge ${health.className}">${health.label}</span>
    </div>
    <div class="mini-metrics">
      ${renderSmallMetric('30min', thirtyMinute)}
      ${renderSmallMetric('5min', fiveMinute)}
    </div>
    <div class="availability">
      <div>
        <span>可用性（1H）</span>
      </div>
      <strong>${oneHour.total ? `${oneHour.rate.toFixed(2)}%` : '无样本'}</strong>
    </div>
    <footer class="history">
      <div class="history-head">
        <span>HISTORY (60MIN)</span>
      </div>
      <div class="history-bars">${bars}</div>
      <div class="history-scale"><span>60MIN AGO</span><span>NOW</span></div>
    </footer>
  </article>`;
}

function renderSmallMetric(label, metric) {
  const state = getMetricState(metric);
  return `<div class="mini-metric metric-${state.className}">
    <span>${label}</span>
    <strong>${metric.total ? `${metric.rate.toFixed(2)}%` : '无样本'}</strong>
  </div>`;
}

function normalizeMetric(metric = {}) {
  const rate = Number(metric.success_rate || 0);
  const total = Number(metric.total || 0);
  const success = Number(metric.success || 0);
  const failed = Number(metric.failed || 0);
  return { rate, total, success, failed };
}

function getHealth(metric) {
  const state = getMetricState(metric);
  return { label: state.label, className: state.className };
}

function getMetricState(metric) {
  if (!metric.total) return { label: '无样本', className: 'muted' };
  if (metric.rate >= OK_RATE) return { label: '正常', className: 'ok' };
  if (metric.rate >= WARN_RATE) return { label: '波动', className: 'warn' };
  return { label: '异常', className: 'bad' };
}

function renderHistoryBars(history) {
  const normalized = Array.from({ length: 60 }, (_, index) => normalizeMetric(history[index]));
  return normalized.map((metric) => {
    const cls = getHistoryClass(metric);
    const title = metric.total
      ? `${metric.rate.toFixed(2)}%，${metric.success}/${metric.total} 成功`
      : '无样本';
    return `<span class="${cls}" title="${escapeHtml(title)}"></span>`;
  }).join('');
}

function getHistoryClass(metric) {
  if (!metric.total) return 'empty';
  if (metric.rate >= OK_RATE) return 'good';
  if (metric.rate >= WARN_RATE || metric.total < HISTORY_MIN_BAD_SAMPLES) return 'warn';
  return 'bad';
}

function tickAutoRefresh() {
  if (!nextRefreshAt) return;
  updateCountdown();
  if (!document.hidden && Date.now() >= nextRefreshAt) {
    loadStats(true);
  }
}

function updateCountdown() {
  const secondsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  nextUpdateEl.textContent = `NEXT UPDATE IN ${secondsLeft}S`;
}

function normalizeRefreshSeconds(value) {
  const seconds = Number(value || DEFAULT_REFRESH_SECONDS);
  if (!Number.isFinite(seconds)) return DEFAULT_REFRESH_SECONDS;
  return Math.max(30, Math.min(3600, seconds));
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
