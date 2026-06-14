const form = document.querySelector('#configForm');
const message = document.querySelector('#message');
const loadBtn = document.querySelector('#loadBtn');
const testBtn = document.querySelector('#testBtn');
const apiBase = window.MONITOR_API_BASE || '';

loadBtn.addEventListener('click', loadConfig);
testBtn.addEventListener('click', () => submitConfig('/api/admin/test'));
form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitConfig('/api/admin/config');
});

async function loadConfig() {
  const password = form.admin_password.value;
  if (!password) return setMessage('请先输入管理密码');
  try {
    const res = await fetch(`${apiBase}/api/admin/config`, {
      headers: { 'x-admin-password': password },
    });
    const payload = await res.json();
    if (!payload.success) throw new Error(payload.message || '读取失败');
    form.base_url.value = payload.data.base_url || '';
    form.user_id.value = payload.data.user_id || '';
    form.refresh_interval_seconds.value = payload.data.refresh_interval_seconds || 60;
    setMessage(payload.data.has_access_token ? '已读取配置，密钥已保存' : '已读取配置，尚未保存密钥');
  } catch (error) {
    setMessage(error.message || '读取失败');
  }
}

async function submitConfig(path) {
  const data = Object.fromEntries(new FormData(form).entries());
  setMessage('处理中');
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-password': data.admin_password,
      },
      body: JSON.stringify({
        base_url: data.base_url,
        access_token: data.access_token,
        user_id: data.user_id,
        refresh_interval_seconds: Number(data.refresh_interval_seconds),
      }),
    });
    const payload = await res.json();
    if (!payload.success) throw new Error(payload.message || '操作失败');
    form.access_token.value = '';
    setMessage(payload.message || '完成');
  } catch (error) {
    setMessage(error.message || '操作失败');
  }
}

function setMessage(text) {
  message.textContent = text;
}
