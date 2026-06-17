const LOG_TYPE_CONSUME = 2;
const LOG_TYPE_ERROR = 5;
const LOG_TYPE_LOGIN = 7;
const SNAPSHOT_ID = 1;
const CONFIG_ID = 1;
const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const SESSION_COOKIE = 'ngm_admin_session';
const MAX_JSON_BODY_BYTES = 32 * 1024;
const PUBLIC_REFRESH_MIN_SECONDS = 30;
const LOGIN_WINDOW_SECONDS = 10 * 60;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_ATTEMPT_RETENTION_SECONDS = 24 * 3600;
const ADMIN_PASSWORD_ID = 1;

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

let schemaReady;
let refreshPromise;

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);

      if (url.pathname === '/api/stats') {
        return await handleStats(request, env, ctx);
      }

      if (url.pathname === '/api/admin/config') {
        if (request.method === 'GET') return await handleGetConfig(request, env);
        if (request.method === 'POST') return await handleSaveConfig(request, env);
      }

      if (url.pathname === '/api/admin/test') {
        if (request.method === 'POST') return await handleTestConfig(request, env);
      }

      if (url.pathname === '/api/admin/channels') {
        if (request.method === 'GET') return await handleGetChannels(request, env);
        if (request.method === 'POST') return await handleSaveChannels(request, env);
      }

      if (url.pathname === '/api/admin/log-diagnostic') {
        if (request.method === 'GET') return await handleLogDiagnostic(request, env);
      }

      if (url.pathname === '/api/admin/reconcile') {
        if (request.method === 'GET') return await handleReconcile(request, env);
      }

      if (url.pathname === '/api/admin/session') {
        if (request.method === 'POST') return await handleCreateSession(request, env);
        if (request.method === 'DELETE') return await handleDeleteSession(request, env);
      }

      if (url.pathname === '/api/admin/password') {
        if (request.method === 'POST') return await handleChangePassword(request, env);
      }

      return await handleStaticRequest(request, env);
    } catch (error) {
      return json({ success: false, message: cleanError(error) }, error.status || 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runRefreshOnce(env));
    ctx.waitUntil(cleanupLoginAttempts(env));
  },
};

async function handleStats(request, env, ctx) {
  const url = new URL(request.url);
  if (url.searchParams.get('refresh') === 'true') {
    const snapshot = await getSnapshot(env);
    if (nowSeconds() - Number(snapshot.refreshed_at || 0) >= PUBLIC_REFRESH_MIN_SECONDS) {
      const refresh = runRefreshOnce(env);
      if (ctx?.waitUntil) ctx.waitUntil(refresh);
    }
  }

  const snapshot = await getSnapshot(env);
  const config = await getConfig(env, { requireComplete: false });
  const hasCachedData = Array.isArray(snapshot.data) && snapshot.data.length > 0;
  const isUsable = snapshot.status === 'ok' || (snapshot.status === 'stale' && hasCachedData);
  return json({
    success: isUsable,
    message: snapshot.status === 'stale' ? '数据刷新异常' : snapshot.message,
    data: snapshot.data,
    refreshed_at: snapshot.refreshed_at,
    refresh_interval_seconds: config.refresh_interval_seconds,
    status: snapshot.status,
  });
}

async function handleGetConfig(request, env) {
  await requireAdmin(request, env);
  const config = await getConfig(env, { requireComplete: false });
  return json({
    success: true,
    data: {
      base_url: config.base_url,
      access_token: '',
      user_id: config.user_id,
      refresh_interval_seconds: config.refresh_interval_seconds,
      admin_allow_ips: config.admin_allow_ips,
      has_access_token: Boolean(config.access_token),
      updated_at: config.updated_at,
    },
  });
}

async function handleSaveConfig(request, env) {
  await requireAdmin(request, env);
  const input = await readJsonBody(request);
  const current = await getConfig(env, { requireComplete: false });
  const config = normalizeConfig({
    base_url: input.base_url || current.base_url,
    access_token: input.access_token || current.access_token,
    user_id: input.user_id || current.user_id,
    refresh_interval_seconds:
      input.refresh_interval_seconds || current.refresh_interval_seconds,
    admin_allow_ips: input.admin_allow_ips ?? current.admin_allow_ips,
  });

  await testRemote(config);
  await saveConfig(env, config);
  await refreshSnapshot(env);
  return json({ success: true, message: '已保存' });
}

async function handleTestConfig(request, env) {
  await requireAdmin(request, env);
  const input = await readJsonBody(request);
  const current = await getConfig(env, { requireComplete: false });
  const config = normalizeConfig({
    base_url: input.base_url || current.base_url,
    access_token: input.access_token || current.access_token,
    user_id: input.user_id || current.user_id,
    refresh_interval_seconds:
      input.refresh_interval_seconds || current.refresh_interval_seconds,
    admin_allow_ips: input.admin_allow_ips ?? current.admin_allow_ips,
  });
  await testRemote(config);
  return json({ success: true, message: '连接成功' });
}

async function handleGetChannels(request, env) {
  await requireAdmin(request, env);
  const config = await getConfig(env);
  const channels = await fetchVisibleGroups(config);
  await saveCachedGroupNames(env, channels);
  const hidden = await getHiddenChannels(env);
  return json({
    success: true,
    data: channels.map((name) => ({
      name,
      visible: !hidden.has(name),
    })),
  });
}

async function handleSaveChannels(request, env) {
  await requireAdmin(request, env);
  const input = await readJsonBody(request);
  const channels = Array.isArray(input.channels) ? input.channels : [];
  await saveChannelVisibility(env, channels);
  await syncSnapshotChannels(env, channels);
  return json({ success: true, message: '分组显示设置已保存' });
}

async function handleLogDiagnostic(request, env) {
  await requireAdmin(request, env);
  const config = await getConfig(env);
  const since = nowSeconds() - 600;
  const queries = [
    ['默认全量', null],
    ['消费 type=2', LOG_TYPE_CONSUME],
    ['错误 type=5', LOG_TYPE_ERROR],
    ['登录 type=7', LOG_TYPE_LOGIN],
  ];
  const data = [];
  for (const [name, type] of queries) {
    const raw = await fetchRawLogsByType(config, since, type);
    data.push(summarizeRawLogs(name, raw));
  }
  return json({ success: true, data });
}

async function handleReconcile(request, env) {
  await requireAdmin(request, env);
  const config = await getConfig(env);
  const since = nowSeconds() - 3600;
  const groups = await fetchVisibleGroups(config);
  const logs = await fetchRemoteLogs(config, since);
  const logGroups = [...new Set(logs.filter(isRequestLog).map((log) => log.group).filter(isChannelName))].sort((a, b) => a.localeCompare(b));
  const groupSet = new Set(groups);
  const logGroupSet = new Set(logGroups);
  return json({
    success: true,
    data: {
      configured_groups: groups,
      log_groups: logGroups,
      configured_without_logs: groups.filter((group) => !logGroupSet.has(group)),
      logs_not_configured: logGroups.filter((group) => !groupSet.has(group)),
    },
  });
}

async function handleCreateSession(request, env) {
  await assertAdminIpAllowed(request, env);
  const loginKey = await getLoginRateKey(request);
  await assertLoginRateLimit(env, loginKey);
  try {
    const input = await readJsonBody(request);
    const password = request.headers.get('x-admin-password') || input.admin_password || '';
    await verifyAdminPassword(env, password);
    await clearLoginFailures(env, loginKey);
  } catch (error) {
    await recordLoginFailure(env, loginKey);
    const loginError = new Error(error.status === 429 ? error.message : '面板密码错误');
    loginError.status = error.status === 429 ? 429 : 401;
    throw loginError;
  }

  const token = generateSessionToken();
  const tokenHash = await sha256Hex(token);
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO monitor_session (session_hash, expires_at, created_at)
      VALUES (?, ?, ?)`,
  )
    .bind(tokenHash, now + SESSION_TTL_SECONDS, now)
    .run();
  return json(
    { success: true, message: '登录成功' },
    200,
    {
      'set-cookie': buildSessionCookie(token, request),
    },
  );
}

async function handleChangePassword(request, env) {
  await requireAdmin(request, env);
  const input = await readJsonBody(request);
  const currentPassword = String(input.current_password || '');
  const newPassword = String(input.new_password || '');
  if (newPassword.length < 8) {
    const error = new Error('新密码至少需要 8 位');
    error.status = 400;
    throw error;
  }
  await verifyAdminPassword(env, currentPassword);
  await saveAdminPassword(env, newPassword);
  await env.DB.prepare('DELETE FROM monitor_session').run();
  return json(
    { success: true, message: '面板密码已更新，请重新登录' },
    200,
    {
      'set-cookie': expireSessionCookie(request),
    },
  );
}

async function handleDeleteSession(_request, env) {
  const cookie = getCookieValue(_request, SESSION_COOKIE);
  if (cookie) {
    const tokenHash = await sha256Hex(cookie);
    await env.DB.prepare('DELETE FROM monitor_session WHERE session_hash = ?')
      .bind(tokenHash)
      .run();
  }
  return json(
    { success: true, message: '已登出' },
    200,
    {
      'set-cookie': expireSessionCookie(_request),
    },
  );
}

async function handleStaticRequest(request, env) {
  const url = new URL(request.url);
  if (!env.ASSETS) {
    return json({ success: false, message: '未找到' }, 404);
  }
  if (url.pathname === '/' || url.pathname === '') {
    return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
  }
  if (url.pathname === '/panel' || url.pathname === '/panel/') {
    return env.ASSETS.fetch(new Request(new URL('/panel.html', request.url), request));
  }
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    return env.ASSETS.fetch(new Request(new URL('/admin.html', request.url), request));
  }
  return env.ASSETS.fetch(request);
}

async function refreshSnapshot(env) {
  try {
    const config = await getConfig(env);
    const stats = await fetchRemoteStats(env, config);
    await saveSnapshot(env, {
      data: stats,
      status: 'ok',
      message: '',
      refreshed_at: nowSeconds(),
    });
  } catch (error) {
    const previous = await getSnapshot(env);
    const previousData = Array.isArray(previous.data) ? previous.data : [];
    const hasPreviousData = previousData.length > 0;
    await saveSnapshot(env, {
      data: previousData,
      status: hasPreviousData ? 'stale' : 'error',
      message: hasPreviousData ? '数据刷新异常' : cleanError(error),
      refreshed_at: previous.refreshed_at || 0,
    });
  }
}

function runRefreshOnce(env) {
  if (!refreshPromise) {
    refreshPromise = refreshSnapshot(env).finally(() => {
      refreshPromise = undefined;
    });
  }
  return refreshPromise;
}

async function fetchRemoteStats(env, config) {
  const now = nowSeconds();
  const since = now - 3600;
  const allLogs = await fetchRemoteLogs(config, since);
  const groups = await getCachedGroups(env, config);

  return aggregateLogs(allLogs, now, groups, config.hidden_channels || new Set());
}

async function fetchRemoteLogs(config, since) {
  const seen = new Set();
  const logs = [];
  const items = await fetchRemoteLogsByType(config, since, null);
  for (const item of items) {
    if (!isRequestLog(item)) continue;
    const key = item.id || `${item.type}:${item.created_at}:${item.group}:${item.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    logs.push(item);
  }
  return logs;
}

async function fetchRemoteLogsByType(config, since, type) {
  const raw = await fetchRawLogsByType(config, since, type);
  return raw.map(normalizeLogItem);
}

async function fetchRawLogsByType(config, since, type) {
  const pageSize = 100;
  let page = 1;
  let totalPages = 120;
  const allLogs = [];

  while (page <= totalPages && page <= 120) {
    const typeParam = type == null ? '' : `&type=${type}`;
    const result = await remoteGet(config, `/api/log/?p=${page}&page_size=${pageSize}${typeParam}&start_timestamp=${since}`);
    const items = extractLogItems(result);
    allLogs.push(...items);
    const total = extractTotal(result);
    if (Number.isFinite(total)) {
      totalPages = Math.max(1, Math.ceil(total / pageSize));
    }
    if (items.length === 0) break;
    const oldestTimestamp = getOldestLogTimestamp(items);
    if (Number.isFinite(oldestTimestamp) && oldestTimestamp < since) break;
    page += 1;
  }

  return allLogs;
}

function extractTotal(payload) {
  const total = Number(payload.data?.total ?? payload.total);
  return Number.isFinite(total) ? total : NaN;
}

function getOldestLogTimestamp(items) {
  let oldest = Infinity;
  for (const item of items) {
    const createdAt = normalizeTimestamp(item.created_at ?? item.createdAt ?? item.created_time ?? item.createdTime);
    if (Number.isFinite(createdAt) && createdAt < oldest) oldest = createdAt;
  }
  return oldest;
}

async function testRemote(config) {
  await remoteGet(config, '/api/user/self');
}

async function fetchVisibleGroups(config) {
  const groups = await fetchRemoteGroups(config);
  const visibleGroups = groups.filter(isChannelName);
  if (visibleGroups.length) return visibleGroups;

  const payload = await remoteGet(config, '/api/pricing');
  const pricingGroups = normalizeUsableGroups(payload).filter(isChannelName);
  if (pricingGroups.length) return pricingGroups;

  return await fetchRecentLogGroups(config);
}

async function getCachedGroups(env, config) {
  const cached = await getCachedGroupNames(env);
  if (cached.length) return cached;
  const groups = await fetchVisibleGroups(config);
  await saveCachedGroupNames(env, groups);
  return groups;
}

async function fetchRemoteGroups(config) {
  const payload = await remoteGet(config, '/api/group/');
  return normalizeGroupItems(payload);
}

async function fetchRecentLogGroups(config) {
  const logs = await fetchRemoteLogs(config, nowSeconds() - 3600);
  return [...new Set(logs.map((log) => log.group).filter(isChannelName))].sort((a, b) => a.localeCompare(b));
}

async function remoteGet(config, path) {
  const response = await fetch(new URL(path, config.base_url), {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: `Bearer ${config.access_token}`,
      'New-Api-User': config.user_id,
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('远端接口发生重定向，请检查 Base URL');
  }
  if (response.status === 429) {
    throw new Error('远端接口请求过于频繁，请稍后自动重试');
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(translateRemoteHttpError(response.status));
  }
  if (!response.ok || payload.success === false) {
    throw new Error(translateRemoteError(payload.message) || `远程请求失败: HTTP ${response.status}`);
  }
  return payload;
}

function aggregateLogs(logs, now, groups = [], hiddenChannels = new Set()) {
  const map = new Map();
  const historyStart = Math.floor(now / 60) * 60 - 59 * 60;
  for (const group of groups) {
    if (hiddenChannels.has(group)) continue;
    if (!group) continue;
    map.set(group, {
      group,
      one_hour: emptyWindow(),
      thirty_minute: emptyWindow(),
      five_minute: emptyWindow(),
      history: Array.from({ length: 60 }, emptyWindow),
    });
  }

  for (const log of logs) {
    if (!isRequestLog(log)) continue;
    if (!Number.isFinite(log.created_at) || log.created_at < now - 3600) continue;

    const group = log.group || 'default';
    if (!map.has(group)) continue;
    const row = map.get(group);
    addLogToWindow(row.one_hour, log, now - 3600);
    addLogToWindow(row.thirty_minute, log, now - 1800);
    addLogToWindow(row.five_minute, log, now - 300);
    addLogToHistory(row.history, log, historyStart);
  }

  const rows = [...map.values()].map((row) => ({
    group: row.group,
    one_hour: finalizeWindow(row.one_hour),
    thirty_minute: finalizeWindow(row.thirty_minute),
    five_minute: finalizeWindow(row.five_minute),
    history: row.history.map(finalizeWindow),
  }));

  rows.sort((a, b) => {
    const byFailures = b.five_minute.failed - a.five_minute.failed;
    if (byFailures !== 0) return byFailures;
    const byTotal = b.one_hour.total - a.one_hour.total;
    if (byTotal !== 0) return byTotal;
    return a.group.localeCompare(b.group);
  });
  return rows;
}

function addLogToWindow(window, log, start) {
  if (log.created_at < start) return;
  if (isErrorLog(log)) window.failed += 1;
  else if (log.type === LOG_TYPE_CONSUME) window.success += 1;
}

function addLogToHistory(history, log, start) {
  const bucket = Math.floor((log.created_at - start) / 60);
  if (bucket < 0 || bucket >= history.length) return;
  addLogToWindow(history[bucket], log, start + bucket * 60);
}

function emptyWindow() {
  return { success: 0, failed: 0 };
}

function finalizeWindow(window) {
  const total = window.success + window.failed;
  return {
    success: window.success,
    failed: window.failed,
    total,
    success_rate: total > 0 ? (window.success * 100) / total : 0,
  };
}

function isRequestLog(log) {
  return log.type === LOG_TYPE_CONSUME || isErrorLog(log);
}

function isErrorLog(log) {
  if (log.type === LOG_TYPE_ERROR) return true;
  if (log.type !== LOG_TYPE_CONSUME) return false;
  return Number(log.status_code || 0) >= 400;
}

function hasErrorSignal(text) {
  const value = String(text || '');
  return (
    /(?:status[_ ]?code|upstream[_ ]?status|http[_ ]?status)\s*[=:：]\s*[45]\d\d/i.test(value) ||
    /\b(?:4\d\d|5\d\d)\b/.test(value) ||
    /\b(?:error|failed|failure|timeout|exception|unauthorized|forbidden|rate limit|insufficient|overloaded|unavailable)\b/i.test(value) ||
    /(?:错误|失败|异常|超时|无效|拒绝|额度不足|无可用渠道|上游|限流|不可用)/.test(value)
  );
}

function normalizeLogItems(payload) {
  return extractLogItems(payload).map(normalizeLogItem);
}

function normalizeLogItem(item) {
  return {
    id: item.id == null ? '' : String(item.id),
    type: Number(item.type),
    status_code: Number(item.status_code ?? item.statusCode ?? item.upstream_status ?? item.upstreamStatus ?? 0),
    created_at: normalizeTimestamp(item.created_at ?? item.createdAt ?? item.created_time ?? item.createdTime),
    group: normalizeLogGroup(item),
    content: item.content || '',
    other: stringifyDiagnosticValue(item.other || ''),
  };
}

function extractLogItems(payload) {
  const raw = payload.data?.items || payload.data?.logs || payload.data?.list || payload.data || [];
  return Array.isArray(raw) ? raw : [];
}

function summarizeRawLogs(name, raw) {
  const typeCounts = {};
  const groupCounts = {};
  const statusCounts = {};
  const errorKeywordCounts = {};
  const fieldCounts = {};
  let oldest = Infinity;
  let newest = 0;
  for (const item of raw) {
    const createdAt = normalizeTimestamp(item.created_at ?? item.createdAt ?? item.created_time ?? item.createdTime);
    if (Number.isFinite(createdAt)) {
      oldest = Math.min(oldest, createdAt);
      newest = Math.max(newest, createdAt);
    }
    typeCounts[String(item.type ?? '空')] = (typeCounts[String(item.type ?? '空')] || 0) + 1;
    const group = normalizeLogGroup(item);
    groupCounts[group] = (groupCounts[group] || 0) + 1;
    const status = item.status_code ?? item.statusCode ?? item.upstream_status ?? item.upstreamStatus ?? '';
    if (status !== '') statusCounts[String(status)] = (statusCounts[String(status)] || 0) + 1;
    const groupForKeyword = normalizeLogGroup(item);
    const text = `${item.content || ''} ${stringifyDiagnosticValue(item.other || '')}`;
    if (hasErrorSignal(text)) {
      errorKeywordCounts[groupForKeyword] = (errorKeywordCounts[groupForKeyword] || 0) + 1;
    }
    for (const key of Object.keys(item)) {
      fieldCounts[key] = (fieldCounts[key] || 0) + 1;
    }
  }
  return {
    name,
    total: raw.length,
    oldest_created_at: Number.isFinite(oldest) ? oldest : 0,
    newest_created_at: newest,
    type_counts: typeCounts,
    group_counts: topCounts(groupCounts),
    status_counts: statusCounts,
    error_keyword_counts: topCounts(errorKeywordCounts),
    fields: Object.keys(fieldCounts).sort(),
  };
}

function stringifyDiagnosticValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function topCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20),
  );
}

function normalizeLogGroup(item) {
  const direct =
    item.group ||
    item.group_name ||
    item.groupName ||
    item.token_group ||
    item.tokenGroup ||
    item.user_group ||
    item.userGroup ||
    item.use_group ||
    item.useGroup ||
    item.request_group ||
    item.requestGroup ||
    item.metadata?.group;
  if (direct) return String(direct).trim();
  const content = String(item.content || '');
  const match = content.match(/(?:group|分组)\s*[=:：]\s*([^,，\s]+)/i);
  return match?.[1]?.trim() || 'default';
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return NaN;
  return timestamp > 100000000000 ? Math.floor(timestamp / 1000) : timestamp;
}

function normalizeGroupItems(payload) {
  const raw = payload.data?.items || payload.data?.groups || payload.data || [];
  if (Array.isArray(raw)) {
    return [
      ...new Set(
        raw
          .filter(isVisibleGroup)
          .map(normalizeGroupName)
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));
  }
  if (raw && typeof raw === 'object') {
    return [
      ...new Set(
        Object.entries(raw)
          .map(([key, value]) => normalizeGroupName(value) || normalizeGroupName(key))
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));
  }
  return [];
}

function normalizeUsableGroups(payload) {
  const usable = payload.usable_group || payload.data?.usable_group || {};
  if (Array.isArray(usable)) return [...new Set(usable.map(normalizeGroupName).filter(Boolean))];
  if (usable && typeof usable === 'object') {
    return [
      ...new Set(
        Object.entries(usable)
          .map(([key, value]) => normalizeGroupName(value) || normalizeGroupName(key))
          .filter(Boolean),
      ),
    ];
  }
  return [];
}

function isVisibleGroup(value) {
  if (!value || typeof value !== 'object') return true;
  if (value.deleted_at || value.deletedAt) return false;
  if (value.status === false || value.enabled === false || value.enable === false) return false;
  if (value.visible === false || value.is_visible === false || value.isVisible === false) return false;
  if (value.status === 0 || value.status === 'disabled' || value.status === 'hidden') return false;
  return true;
}

function isChannelName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower === 'default' || lower === 'auto') return false;
  return true;
}

function normalizeGroupName(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    return String(
      value.name ||
      value.group ||
      value.group_name ||
      value.groupName ||
      value.key ||
      value.id ||
      '',
    ).trim();
  }
  return '';
}

async function getConfig(env, options = {}) {
  const requireComplete = options.requireComplete !== false;
  const row = await env.DB.prepare('SELECT * FROM monitor_config WHERE id = ?')
    .bind(CONFIG_ID)
    .first();
  const envConfig = {
    base_url: env.NEWAPI_BASE_URL || '',
    access_token: env.NEWAPI_ACCESS_TOKEN || '',
    user_id: env.NEWAPI_USER_ID || '',
    refresh_interval_seconds: Number(env.DEFAULT_REFRESH_INTERVAL_SECONDS || 60),
    admin_allow_ips: env.ADMIN_ALLOW_IPS || '',
    updated_at: 0,
  };
  const config = normalizeConfig({ ...envConfig, ...(row || {}) }, { requireComplete });
  config.hidden_channels = await getHiddenChannels(env);
  if (!requireComplete) return config;
  return config;
}

async function getHiddenChannels(env) {
  const result = await env.DB.prepare(
    'SELECT channel_name FROM monitor_channel_visibility WHERE visible = 0',
  ).all();
  return new Set((result.results || []).map((row) => row.channel_name));
}

async function saveChannelVisibility(env, channels) {
  const now = nowSeconds();
  for (const channel of channels) {
    const name = String(channel.name || '').trim();
    if (!name) continue;
    const visible = channel.visible ? 1 : 0;
    await env.DB.prepare(
      `INSERT INTO monitor_channel_visibility (channel_name, visible, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(channel_name) DO UPDATE SET
          visible = excluded.visible,
          updated_at = excluded.updated_at`,
    )
      .bind(name, visible, now)
      .run();
  }
}

async function getCachedGroupNames(env) {
  const row = await env.DB.prepare('SELECT group_names, updated_at FROM monitor_group_cache WHERE id = ?')
    .bind(1)
    .first();
  if (!row) return [];
  const updatedAt = Number(row.updated_at || 0);
  if (nowSeconds() - updatedAt > 3600 * 6) return [];
  try {
    const raw = JSON.parse(row.group_names || '[]');
    return Array.isArray(raw) ? raw.map((name) => String(name || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function saveCachedGroupNames(env, groups) {
  await env.DB.prepare(
    `INSERT INTO monitor_group_cache (id, group_names, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_names = excluded.group_names,
        updated_at = excluded.updated_at`,
  )
    .bind(1, JSON.stringify(groups), nowSeconds())
    .run();
}

async function syncSnapshotChannels(env, channels) {
  const snapshot = await getSnapshot(env);
  const rowsByGroup = new Map((snapshot.data || []).map((row) => [row.group, row]));
  const visibleGroups = channels
    .filter((channel) => channel.visible)
    .map((channel) => String(channel.name || '').trim())
    .filter(Boolean);

  await saveSnapshot(env, {
    ...snapshot,
    data: visibleGroups.map((group) => rowsByGroup.get(group) || emptyStatsRow(group)),
  });
}

function emptyStatsRow(group) {
  return {
    group,
    one_hour: finalizeWindow(emptyWindow()),
    thirty_minute: finalizeWindow(emptyWindow()),
    five_minute: finalizeWindow(emptyWindow()),
    history: Array.from({ length: 60 }, () => finalizeWindow(emptyWindow())),
  };
}

async function saveConfig(env, config) {
  await env.DB.prepare(
    `INSERT INTO monitor_config
      (id, base_url, access_token, user_id, refresh_interval_seconds, admin_allow_ips, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        access_token = excluded.access_token,
        user_id = excluded.user_id,
        refresh_interval_seconds = excluded.refresh_interval_seconds,
        admin_allow_ips = excluded.admin_allow_ips,
        updated_at = excluded.updated_at`,
  )
    .bind(
      CONFIG_ID,
      config.base_url,
      config.access_token,
      config.user_id,
      config.refresh_interval_seconds,
      config.admin_allow_ips,
      nowSeconds(),
    )
    .run();
}

async function getSnapshot(env) {
  const row = await env.DB.prepare('SELECT * FROM monitor_snapshot WHERE id = ?')
    .bind(SNAPSHOT_ID)
    .first();
  if (!row) {
    return { data: [], status: 'empty', message: '暂无快照', refreshed_at: 0 };
  }
  return {
    data: JSON.parse(row.data || '[]'),
    status: row.status,
    message: row.message,
    refreshed_at: row.refreshed_at,
  };
}

async function saveSnapshot(env, snapshot) {
  await env.DB.prepare(
    `INSERT INTO monitor_snapshot (id, data, status, message, refreshed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        status = excluded.status,
        message = excluded.message,
        refreshed_at = excluded.refreshed_at`,
  )
    .bind(
      SNAPSHOT_ID,
      JSON.stringify(snapshot.data),
      snapshot.status,
      snapshot.message,
      snapshot.refreshed_at,
    )
    .run();
}

async function ensureSchema(env) {
  schemaReady ||= (async () => {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monitor_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        base_url TEXT NOT NULL DEFAULT '',
        access_token TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        refresh_interval_seconds INTEGER NOT NULL DEFAULT 60,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monitor_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'empty',
        message TEXT NOT NULL DEFAULT '',
        refreshed_at INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monitor_session (
        session_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monitor_channel_visibility (
        channel_name TEXT PRIMARY KEY,
        visible INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monitor_group_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        group_names TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monitor_login_attempt (
        ip_hash TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    await env.DB.prepare(`
      ALTER TABLE monitor_config ADD COLUMN admin_allow_ips TEXT NOT NULL DEFAULT ''
    `).run().catch(() => {});
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS monitor_admin_password (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
  })();
  await schemaReady;
}

function normalizeConfig(config, options = {}) {
  const requireComplete = options.requireComplete !== false;
  const baseUrl = String(config.base_url || '').trim().replace(/\/+$/, '');
  const accessToken = String(config.access_token || '').trim();
  const userId = String(config.user_id || '').trim();
  const refreshInterval = Number(config.refresh_interval_seconds || 60);
  const adminAllowIps = normalizeIpAllowList(config.admin_allow_ips || '');
  if (requireComplete && !baseUrl) throw new Error('Base URL 未填写');
  if (requireComplete && !accessToken) throw new Error('系统访问令牌未填写');
  if (requireComplete && !userId) throw new Error('User ID 未填写');
  if (baseUrl) validateBaseUrl(baseUrl);
  return {
    base_url: baseUrl,
    access_token: accessToken,
    user_id: userId,
    refresh_interval_seconds: Math.max(30, Math.min(3600, refreshInterval)),
    admin_allow_ips: adminAllowIps,
    updated_at: Number(config.updated_at || 0),
  };
}

async function requireAdmin(request, env) {
  assertSameOriginForUnsafeMethod(request);
  await assertAdminIpAllowed(request, env);
  const cookie = getCookieValue(request, SESSION_COOKIE);
  if (!cookie) {
    const error = new Error('未授权');
    error.status = 401;
    throw error;
  }
  await validateAdminSession(env, cookie);
}

async function validateAdminSession(env, cookie) {
  const tokenHash = await sha256Hex(cookie);
  const row = await env.DB.prepare(
    'SELECT expires_at FROM monitor_session WHERE session_hash = ?',
  )
    .bind(tokenHash)
    .first();
  if (!row || Number(row.expires_at) <= nowSeconds()) {
    const error = new Error('未授权');
    error.status = 401;
    throw error;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

async function assertLoginRateLimit(env, loginKey) {
  const row = await env.DB.prepare(
    'SELECT window_start, failure_count FROM monitor_login_attempt WHERE ip_hash = ?',
  )
    .bind(loginKey)
    .first();
  const now = nowSeconds();
  if (!row || now - Number(row.window_start) >= LOGIN_WINDOW_SECONDS) return;
  if (Number(row.failure_count) < LOGIN_MAX_FAILURES) return;
  const secondsLeft = LOGIN_WINDOW_SECONDS - (now - Number(row.window_start));
  const error = new Error(`登录失败次数过多，请 ${Math.ceil(secondsLeft / 60)} 分钟后再试`);
  error.status = 429;
  throw error;
}

async function recordLoginFailure(env, loginKey) {
  const now = nowSeconds();
  const row = await env.DB.prepare(
    'SELECT window_start, failure_count FROM monitor_login_attempt WHERE ip_hash = ?',
  )
    .bind(loginKey)
    .first();
  if (!row || now - Number(row.window_start) >= LOGIN_WINDOW_SECONDS) {
    await env.DB.prepare(
      `INSERT INTO monitor_login_attempt (ip_hash, window_start, failure_count)
        VALUES (?, ?, 1)
        ON CONFLICT(ip_hash) DO UPDATE SET
          window_start = excluded.window_start,
          failure_count = excluded.failure_count`,
    )
      .bind(loginKey, now)
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE monitor_login_attempt
      SET failure_count = failure_count + 1
      WHERE ip_hash = ?`,
  )
    .bind(loginKey)
    .run();
}

async function clearLoginFailures(env, loginKey) {
  await env.DB.prepare('DELETE FROM monitor_login_attempt WHERE ip_hash = ?')
    .bind(loginKey)
    .run();
}

async function cleanupLoginAttempts(env) {
  await env.DB.prepare('DELETE FROM monitor_login_attempt WHERE window_start < ?')
    .bind(nowSeconds() - LOGIN_ATTEMPT_RETENTION_SECONDS)
    .run();
}

async function getLoginRateKey(request) {
  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'local';
  return sha256Hex(ip);
}

async function assertAdminIpAllowed(request, env) {
  const config = await getConfig(env, { requireComplete: false });
  const rules = parseIpAllowList(config.admin_allow_ips);
  if (!rules.length) return;
  const ip = getClientIp(request);
  if (rules.some((rule) => ipMatchesRule(ip, rule))) return;
  const error = new Error('当前 IP 不允许访问后台');
  error.status = 403;
  throw error;
}

function getClientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || '';
}

async function verifyAdminPassword(env, password) {
  const saved = await getSavedAdminPassword(env);
  if (saved) {
    const actualHash = await hashPassword(password, saved.salt);
    if (constantTimeEqual(actualHash, saved.password_hash)) return;
  } else if (env.ADMIN_PASSWORD && password === env.ADMIN_PASSWORD) {
    return;
  }
  const error = new Error('未授权');
  error.status = 401;
  throw error;
}

async function getSavedAdminPassword(env) {
  return env.DB.prepare(
    'SELECT password_hash, salt FROM monitor_admin_password WHERE id = ?',
  )
    .bind(ADMIN_PASSWORD_ID)
    .first();
}

async function saveAdminPassword(env, password) {
  const salt = generateSessionToken();
  const passwordHash = await hashPassword(password, salt);
  await env.DB.prepare(
    `INSERT INTO monitor_admin_password (id, password_hash, salt, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        password_hash = excluded.password_hash,
        salt = excluded.salt,
        updated_at = excluded.updated_at`,
  )
    .bind(ADMIN_PASSWORD_ID, passwordHash, salt, nowSeconds())
    .run();
}

function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

function normalizeIpAllowList(value) {
  return String(value || '')
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n');
}

function parseIpAllowList(value) {
  return normalizeIpAllowList(value).split('\n').filter(Boolean);
}

function ipMatchesRule(ip, rule) {
  if (!ip) return false;
  if (!rule.includes('/')) return ip === rule;
  const [base, prefixText] = rule.split('/');
  const prefix = Number(prefixText);
  const ipNumber = ipv4ToNumber(ip);
  const baseNumber = ipv4ToNumber(base);
  if (!Number.isFinite(ipNumber) || !Number.isFinite(baseNumber)) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (baseNumber & mask);
}

function ipv4ToNumber(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return NaN;
  let number = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return NaN;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return NaN;
    number = ((number << 8) | octet) >>> 0;
  }
  return number >>> 0;
}

function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function readJsonBody(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    const error = new Error('请求内容过大');
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    const error = new Error('请求 JSON 格式错误');
    error.status = 400;
    throw error;
  }
}

function assertSameOriginForUnsafeMethod(request) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) {
    const error = new Error('请求来源无效');
    error.status = 403;
    throw error;
  }
  const referer = request.headers.get('referer');
  if (!origin && referer && new URL(referer).origin !== url.origin) {
    const error = new Error('请求来源无效');
    error.status = 403;
    throw error;
  }
}

function validateBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Base URL 格式错误');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Base URL 只支持 HTTP/HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL 不能包含用户名或密码');
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}


function translateRemoteError(message) {
  const map = {
    'Unauthorized, invalid access token': '未授权，系统访问令牌无效',
    'Unauthorized': '未授权',
    '系统访问令牌未填写': '系统访问令牌未填写',
    'Base URL 未填写': 'Base URL 未填写',
    'User ID 未填写': 'User ID 未填写',
    'invalid access token': '系统访问令牌无效',
    '未找到': '未找到',
  };
  const lower = (message || '').toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (lower.includes(key.toLowerCase())) return value;
  }
  return message;
}

function cleanError(error) {
  if (error?.name === 'AbortError' || /aborted|timeout/i.test(error?.message || '')) {
    return '远端请求超时';
  }
  return translateRemoteError(sanitizeMessage(error?.message || '未知错误'));
}

function translateRemoteHttpError(status) {
  if (status === 429) return '远端接口请求过于频繁，请稍后自动重试';
  if (status === 401) return '未授权，请检查系统访问令牌';
  if (status === 403) return '远端拒绝访问，请检查系统访问令牌和 User ID';
  if (status === 404) return '远端接口不存在，请检查 Base URL';
  if (status >= 500) return `远端服务暂时不可用（HTTP ${status}）`;
  return `远端返回了非 JSON 响应（HTTP ${status}）`;
}

function buildSessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax; HttpOnly${secure}`;
}

function expireSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
}

function sanitizeMessage(message) {
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/(access[_-]?token["':=\s]+)[^"',\s]+/gi, '$1***')
    .replace(/(系统访问令牌["':=\s]+)[^"',\s]+/gi, '$1***')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***')
    .slice(0, 200);
}

function getCookieValue(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = cookieHeader.split(';').map((part) => part.trim());
  const prefix = `${name}=`;
  const match = cookies.find((cookie) => cookie.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
