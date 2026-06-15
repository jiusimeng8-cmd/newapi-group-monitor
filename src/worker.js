const LOG_TYPE_CONSUME = 2;
const LOG_TYPE_ERROR = 5;
const SNAPSHOT_ID = 1;
const CONFIG_ID = 1;
const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const SESSION_COOKIE = 'ngm_admin_session';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

let schemaReady;

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);

      if (url.pathname === '/api/stats') {
        return await handleStats(request, env);
      }

      if (url.pathname === '/api/admin/config') {
        if (request.method === 'GET') return await handleGetConfig(request, env);
        if (request.method === 'POST') return await handleSaveConfig(request, env);
      }

      if (url.pathname === '/api/admin/test') {
        return await handleTestConfig(request, env);
      }

      if (url.pathname === '/api/admin/channels') {
        if (request.method === 'GET') return await handleGetChannels(request, env);
        if (request.method === 'POST') return await handleSaveChannels(request, env);
      }

      if (url.pathname === '/api/admin/session') {
        if (request.method === 'POST') return await handleCreateSession(request, env);
        if (request.method === 'DELETE') return await handleDeleteSession(request, env);
      }

      return json({ success: false, message: 'Not found' }, 404);
    } catch (error) {
      return json({ success: false, message: cleanError(error) }, error.status || 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshSnapshot(env));
  },
};

async function handleStats(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get('refresh') === 'true') {
    await refreshSnapshot(env);
  }

  const snapshot = await getSnapshot(env);
  return json({
    success: snapshot.status === 'ok',
    message: snapshot.message,
    data: snapshot.data,
    refreshed_at: snapshot.refreshed_at,
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
      access_token: config.access_token,
      user_id: config.user_id,
      refresh_interval_seconds: config.refresh_interval_seconds,
      access_token: config.access_token, has_access_token: Boolean(config.access_token),
      updated_at: config.updated_at,
    },
  });
}

async function handleSaveConfig(request, env) {
  await requireAdmin(request, env);
  const input = await request.json();
  const current = await getConfig(env, { requireComplete: false });
  const config = normalizeConfig({
    base_url: input.base_url || current.base_url,
    access_token: input.access_token || current.access_token,
    user_id: input.user_id || current.user_id,
    refresh_interval_seconds:
      input.refresh_interval_seconds || current.refresh_interval_seconds,
  });

  await testRemote(config);
  await saveConfig(env, config);
  await refreshSnapshot(env);
  return json({ success: true, message: 'Saved' });
}

async function handleTestConfig(request, env) {
  await requireAdmin(request, env);
  const input = await request.json();
  const current = await getConfig(env, { requireComplete: false });
  const config = normalizeConfig({
    base_url: input.base_url || current.base_url,
    access_token: input.access_token || current.access_token,
    user_id: input.user_id || current.user_id,
    refresh_interval_seconds:
      input.refresh_interval_seconds || current.refresh_interval_seconds,
  });
  await testRemote(config);
  return json({ success: true, message: 'Connection ok' });
}

async function handleGetChannels(request, env) {
  await requireAdmin(request, env);
  const config = await getConfig(env);
  const channels = await fetchVisibleGroups(config);
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
  const input = await request.json();
  const channels = Array.isArray(input.channels) ? input.channels : [];
  await saveChannelVisibility(env, channels);
  await refreshSnapshot(env);
  return json({ success: true, message: '渠道显示设置已保存' });
}

async function handleCreateSession(request, env) {
  requireAdminPassword(request, env);
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
    { success: true, message: 'Logged in' },
    200,
    {
      'set-cookie': buildSessionCookie(token),
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
    { success: true, message: 'Logged out' },
    200,
    {
      'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`,
    },
  );
}

async function refreshSnapshot(env) {
  try {
    const config = await getConfig(env);
    const stats = await fetchRemoteStats(config);
    await saveSnapshot(env, {
      data: stats,
      status: 'ok',
      message: '',
      refreshed_at: nowSeconds(),
    });
  } catch (error) {
    await saveSnapshot(env, {
      data: [],
      status: 'error',
      message: cleanError(error),
      refreshed_at: nowSeconds(),
    });
  }
}

async function fetchRemoteStats(config) {
  const since = nowSeconds() - 3600;
  const allLogs = await fetchRemoteLogs(config, since);
  const groups = await fetchVisibleGroups(config);

  return aggregateLogs(allLogs, nowSeconds(), groups, config.hidden_channels || new Set());
}

async function fetchRemoteLogs(config, since) {
  const pageSize = 100;
  let page = 0;
  let allLogs = [];

  while (page < 1000) {
    const result = await remoteGet(
      config,
      `/api/log/?p=${page}&page_size=${pageSize}&start_timestamp=${since}`,
    );
    const items = normalizeLogItems(result);
    allLogs = allLogs.concat(items);
    if (items.length === 0) break;
    if (items.some((item) => Number.isFinite(item.created_at) && item.created_at < since)) break;
    page += 1;
  }

  return allLogs;
}

async function testRemote(config) {
  await remoteGet(config, '/api/user/self');
}

async function fetchVisibleGroups(config) {
  try {
    const payload = await remoteGet(config, '/api/pricing');
    const groups = normalizeUsableGroups(payload);
    if (groups.length) return groups;
  } catch {
    // Fall back to the admin group list for older New API versions.
  }
  return fetchRemoteGroups(config);
}

async function fetchRemoteGroups(config) {
  const payload = await remoteGet(config, '/api/group/');
  return normalizeGroupItems(payload);
}

async function remoteGet(config, path) {
  const response = await fetch(new URL(path, config.base_url), {
    headers: {
      authorization: `Bearer ${config.access_token}`,
      'new-api-user': config.user_id,
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Remote returned non-json response: HTTP ${response.status}`);
  }
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `Remote request failed: HTTP ${response.status}`);
  }
  return payload;
}

function aggregateLogs(logs, now, groups = [], hiddenChannels = new Set()) {
  const map = new Map();
  for (const group of groups) {
    if (hiddenChannels.has(group)) continue;
    if (!group) continue;
    map.set(group, {
      group,
      one_hour: emptyWindow(),
      thirty_minute: emptyWindow(),
      five_minute: emptyWindow(),
    });
  }

  for (const log of logs) {
    if (log.type !== LOG_TYPE_CONSUME && log.type !== LOG_TYPE_ERROR) continue;
    if (!Number.isFinite(log.created_at) || log.created_at < now - 3600) continue;

    const group = log.group || 'default';
    if (!map.has(group)) {
      map.set(group, {
        group,
        one_hour: emptyWindow(),
        thirty_minute: emptyWindow(),
        five_minute: emptyWindow(),
      });
    }
    const row = map.get(group);
    addLogToWindow(row.one_hour, log, now - 3600);
    addLogToWindow(row.thirty_minute, log, now - 1800);
    addLogToWindow(row.five_minute, log, now - 300);
  }

  const rows = [...map.values()].map((row) => ({
    group: row.group,
    one_hour: finalizeWindow(row.one_hour),
    thirty_minute: finalizeWindow(row.thirty_minute),
    five_minute: finalizeWindow(row.five_minute),
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
  if (log.type === LOG_TYPE_CONSUME) window.success += 1;
  if (log.type === LOG_TYPE_ERROR) window.failed += 1;
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

function normalizeLogItems(payload) {
  const raw = payload.data?.items || payload.data || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    type: Number(item.type),
    created_at: Number(item.created_at),
    group: item.group || 'default',
  }));
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
    ];
  }
  if (raw && typeof raw === 'object') return Object.keys(raw).map(normalizeGroupName).filter(Boolean);
  return [];
}

function normalizeUsableGroups(payload) {
  const usable = payload.usable_group || payload.data?.usable_group || {};
  if (Array.isArray(usable)) return [...new Set(usable.map(normalizeGroupName).filter(Boolean))];
  if (usable && typeof usable === 'object') return Object.keys(usable).map(normalizeGroupName).filter(Boolean);
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

function normalizeGroupName(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    return String(value.group || value.name || value.key || '').trim();
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

async function saveConfig(env, config) {
  await env.DB.prepare(
    `INSERT INTO monitor_config
      (id, base_url, access_token, user_id, refresh_interval_seconds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        access_token = excluded.access_token,
        user_id = excluded.user_id,
        refresh_interval_seconds = excluded.refresh_interval_seconds,
        updated_at = excluded.updated_at`,
  )
    .bind(
      CONFIG_ID,
      config.base_url,
      config.access_token,
      config.user_id,
      config.refresh_interval_seconds,
      nowSeconds(),
    )
    .run();
}

async function getSnapshot(env) {
  const row = await env.DB.prepare('SELECT * FROM monitor_snapshot WHERE id = ?')
    .bind(SNAPSHOT_ID)
    .first();
  if (!row) {
    return { data: [], status: 'empty', message: 'No snapshot yet', refreshed_at: 0 };
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
  })();
  await schemaReady;
}

function normalizeConfig(config, options = {}) {
  const requireComplete = options.requireComplete !== false;
  const baseUrl = String(config.base_url || '').trim().replace(/\/+$/, '');
  const accessToken = String(config.access_token || '').trim();
  const userId = String(config.user_id || '').trim();
  const refreshInterval = Number(config.refresh_interval_seconds || 60);
  if (requireComplete && !baseUrl) throw new Error('Base URL is required');
  if (requireComplete && !accessToken) throw new Error('Access token is required');
  if (requireComplete && !userId) throw new Error('User ID is required');
  return {
    base_url: baseUrl,
    access_token: accessToken,
    user_id: userId,
    refresh_interval_seconds: Math.max(30, Math.min(3600, refreshInterval)),
    updated_at: Number(config.updated_at || 0),
  };
}

async function requireAdmin(request, env) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) {
    const error = new Error('ADMIN_PASSWORD is not configured');
    error.status = 500;
    throw error;
  }
  const cookie = getCookieValue(request, SESSION_COOKIE);
  if (!cookie) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
  await validateAdminSession(env, cookie);
}

function requireAdminPassword(request, env) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) {
    const error = new Error('ADMIN_PASSWORD is not configured');
    error.status = 500;
    throw error;
  }
  const actual = request.headers.get('x-admin-password') || '';
  if (actual !== expected) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
}

async function validateAdminSession(env, cookie) {
  const tokenHash = await sha256Hex(cookie);
  const row = await env.DB.prepare(
    'SELECT expires_at FROM monitor_session WHERE session_hash = ?',
  )
    .bind(tokenHash)
    .first();
  if (!row || Number(row.expires_at) <= nowSeconds()) {
    const error = new Error('Unauthorized');
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

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function cleanError(error) {
  return error?.message || 'Unknown error';
}

function buildSessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax; HttpOnly`;
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
