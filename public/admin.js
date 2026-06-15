const apiBase = window.MONITOR_API_BASE || '';
const loginForm = document.querySelector('#loginForm');
const configForm = document.querySelector('#configForm');
const loginMessage = document.querySelector('#loginMessage');
const message = document.querySelector('#message');
const loadBtn = document.querySelector('#loadBtn');
const testBtn = document.querySelector('#testBtn');
const channelList = document.querySelector('#channelList');
const channelMessage = document.querySelector('#channelMessage');
const showAllBtn = document.querySelector('#showAllBtn');
const hideAllBtn = document.querySelector('#hideAllBtn');
const saveChannelsBtn = document.querySelector('#saveChannelsBtn');

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

async function handleLogin(event) {
  event.preventDefault();
  const password = loginForm.admin_password.value;
  setLoginMessage('验证中');
  try {
    const res = await fetch(`${apiBase}/api/admin/session`, {
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
    const res = await fetch(`${apiBase}/api/admin/config`);
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '读取失败');
    configForm.base_url.value = payload.data.base_url || '';
    configForm.access_token.value = payload.data.access_token || '';
    configForm.user_id.value = payload.data.user_id || '';
    configForm.refresh_interval_seconds.value = payload.data.refresh_interval_seconds || 60;
    setMessage(payload.data.has_access_token ? '已读取配置，密钥已保存' : '已读取配置，尚未保存密钥');
  } catch (error) {
    handlePanelError(error);
  }
}

async function submitConfig(path) {
  const data = Object.fromEntries(new FormData(configForm).entries());
  setMessage('处理中');
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        base_url: data.base_url,
        access_token: data.access_token,
        user_id: data.user_id,
        refresh_interval_seconds: Number(data.refresh_interval_seconds),
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
  setChannelMessage('读取渠道中');
  try {
    const res = await fetch(`${apiBase}/api/admin/channels`);
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '读取渠道失败');
    renderChannels(payload.data || []);
    setChannelMessage(`已读取 ${payload.data?.length || 0} 个渠道`);
  } catch (error) {
    handlePanelError(error);
    setChannelMessage(error.message || '读取渠道失败');
  }
}

async function saveChannels() {
  const channels = [...channelList.querySelectorAll('input[type="checkbox"]')].map((input) => ({
    name: input.value,
    visible: input.checked,
  }));
  setChannelMessage('保存中');
  try {
    const res = await fetch(`${apiBase}/api/admin/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels }),
    });
    const payload = await readJson(res);
    if (!payload.success) throw new Error(payload.message || '保存渠道失败');
    setChannelMessage(payload.message || '渠道显示设置已保存');
  } catch (error) {
    handlePanelError(error);
    setChannelMessage(error.message || '保存渠道失败');
  }
}

function renderChannels(channels) {
  if (!channels.length) {
    channelList.innerHTML = '<div class="empty-state">暂无渠道</div>';
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

function setChannelMessage(text) {
  channelMessage.textContent = text;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`服务端返回了非 JSON 响应：HTTP ${res.status}`);
  }
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
