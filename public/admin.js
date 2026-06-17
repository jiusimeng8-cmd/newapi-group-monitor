const apiBase = window.MONITOR_API_BASE || '';
const loginForm = document.querySelector('#loginForm');
const configForm = document.querySelector('#configForm');
const passwordForm = document.querySelector('#passwordForm');
const loginMessage = document.querySelector('#loginMessage');
const message = document.querySelector('#message');
const passwordMessage = document.querySelector('#passwordMessage');
const loadBtn = document.querySelector('#loadBtn');
const testBtn = document.querySelector('#testBtn');
const passwordBtn = document.querySelector('#passwordBtn');
const channelList = document.querySelector('#channelList');
const channelMessage = document.querySelector('#channelMessage');
const showAllBtn = document.querySelector('#showAllBtn');
const hideAllBtn = document.querySelector('#hideAllBtn');
const saveChannelsBtn = document.querySelector('#saveChannelsBtn');
const REQUEST_TIMEOUT_MS = 15000;

if (loginForm) {
  loginForm.addEventListener('submit', handleLogin);
}

if (configForm) {
  loadBtn.addEventListener('click', loadConfig);
  testBtn.addEventListener('click', () => submitConfig('/api/admin/test'));
  configForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitConfig('/api/admin/config');
  });
  loadConfig();
  loadChannels();
  showAllBtn.addEventListener('click', () => setAllChannels(true));
  hideAllBtn.addEventListener('click', () => setAllChannels(false));
  saveChannelsBtn.addEventListener('click', saveChannels);
}

if (passwordForm) {
  passwordForm.addEventListener('submit', handleChangePassword);
}

async function handleLogin(event) {
  event.preventDefault();
  const password = loginForm.admin_password.value;
  setLoginMessage('验证中');
  try {
    const res = await requestJson('/api/admin/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-password': password,
      },
      body: '{}',
    });
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '验证失败');
    window.location.href = '/panel.html';
  } catch (error) {
    setLoginMessage(error.message || '验证失败');
  }
}

async function loadConfig() {
  setMessage('读取中');
  try {
    const res = await requestJson('/api/admin/config');
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '读取失败');
    configForm.base_url.value = payload.data.base_url || '';
    configForm.access_token.value = '';
    configForm.user_id.value = payload.data.user_id || '';
    configForm.refresh_interval_seconds.value = payload.data.refresh_interval_seconds || 60;
    configForm.admin_allow_ips.value = payload.data.admin_allow_ips || '';
    setMessage(payload.data.has_access_token ? '已读取配置，密钥已保存' : '已读取配置，尚未保存密钥');
  } catch (error) {
    handlePanelError(error);
  }
}

async function submitConfig(path) {
  const data = Object.fromEntries(new FormData(configForm).entries());
  setMessage('处理中');
  try {
    const res = await requestJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        base_url: data.base_url,
        access_token: data.access_token,
        user_id: data.user_id,
        refresh_interval_seconds: Number(data.refresh_interval_seconds),
        admin_allow_ips: data.admin_allow_ips,
      }),
    });
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '操作失败');
    setMessage(payload.message || '完成');
  } catch (error) {
    handlePanelError(error);
  }
}

async function loadChannels() {
  setChannelMessage('读取分组中');
  try {
    const res = await requestJson('/api/admin/channels');
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '读取分组失败');
    renderChannels(payload.data || []);
    setChannelMessage(`已读取 ${payload.data?.length || 0} 个分组`);
  } catch (error) {
    handlePanelError(error);
    setChannelMessage(error.message || '读取分组失败');
  }
}

async function saveChannels() {
  const channels = [...channelList.querySelectorAll('input[type="checkbox"]')].map((input) => ({
    name: input.value,
    visible: input.checked,
  }));
  setChannelMessage('保存中，请稍候');
  saveChannelsBtn.disabled = true;
  try {
    const res = await requestJson('/api/admin/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels }),
    });
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '保存分组失败');
    setChannelMessage(payload.message || '分组显示设置已保存');
  } catch (error) {
    handlePanelError(error);
    setChannelMessage(error.message || '保存分组失败');
  } finally {
    saveChannelsBtn.disabled = false;
  }
}

async function handleChangePassword(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(passwordForm).entries());
  setPasswordMessage('更新中');
  passwordBtn.disabled = true;
  try {
    const res = await requestJson('/api/admin/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        current_password: data.current_password,
        new_password: data.new_password,
      }),
    });
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '更新密码失败');
    passwordForm.reset();
    setPasswordMessage(payload.message || '面板密码已更新');
    window.setTimeout(() => {
      window.location.href = '/admin.html';
    }, 900);
  } catch (error) {
    handlePanelError(error);
    setPasswordMessage(error.message || '更新密码失败');
  } finally {
    passwordBtn.disabled = false;
  }
}

function renderChannels(channels) {
  if (!channels.length) {
    channelList.innerHTML = '<div class="empty-state">暂无分组</div>';
    return;
  }
  channelList.innerHTML = channels
    .map(
      (channel) => `<label class="channel-item">
        <input type="checkbox" value="${escapeHtml(channel.name)}" ${channel.visible ? 'checked' : ''} />
        <span>${escapeHtml(channel.name)}</span>
      </label>`,
    )
    .join('');
}

function setAllChannels(visible) {
  for (const input of channelList.querySelectorAll('input[type="checkbox"]')) {
    input.checked = visible;
  }
}

function handlePanelError(error) {
  const text = error.message || '操作失败';
  setMessage(text);
  if (text === '未授权') {
    window.location.href = '/admin.html';
  }
}

function setLoginMessage(text) {
  loginMessage.textContent = text;
}

function setMessage(text) {
  message.textContent = text;
}

function setPasswordMessage(text) {
  passwordMessage.textContent = text;
}

function setChannelMessage(text) {
  channelMessage.textContent = text;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(describeResponseError(res, text));
  }
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${apiBase}${path}`, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)}秒），请稍后重试`);
    }
    throw new Error('服务暂时不可用，请稍后重试');
  } finally {
    window.clearTimeout(timer);
  }
}

function describeResponseError(res, text) {
  const code = res.status;
  if (code === 503) return '服务暂时不可用（HTTP 503），请稍后重试';
  if (code === 502) return '上游服务暂时不可用（HTTP 502），请稍后重试';
  if (code === 504) return '请求超时（HTTP 504），请稍后重试';
  if (code === 401) return '未授权，请重新登录';
  if (code === 403) return '请求被拒绝，请刷新后重试';
  if (code >= 500) return `服务暂时不可用（HTTP ${code}），请稍后重试`;
  if (/<!doctype html/i.test(text) || /<html/i.test(text)) {
    return `服务端返回了网页内容（HTTP ${code}），请稍后重试`;
  }
  return `服务端返回了非 JSON 响应（HTTP ${code}）`;
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
