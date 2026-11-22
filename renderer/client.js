/* mihomo External Controller 客户端：REST + WebSocket（渲染层直连 127.0.0.1） */

let BASE = null;
let SECRET = '';

export function configure(port, secret) {
  BASE = `http://127.0.0.1:${port}`;
  SECRET = secret || '';
  return BASE;
}

export function endpoint() {
  return { base: BASE, port: BASE ? Number(BASE.split(':').pop()) : null };
}

async function rest(method, path, body, timeoutMs = 12000) {
  // file:// 下直接 fetch 会被 CORS 拦截，统一走主进程代理（密钥不出主进程）
  const r = await window.wallnut.invoke('ctl:rest', { method, path, body, timeout: timeoutMs });
  if (!r || !r.ok) {
    const err = new Error((r && r.error) || '控制器请求失败');
    err.status = r && r.status;
    throw err;
  }
  return r.data;
}

export const get = (p, t) => rest('GET', p, undefined, t);
export const put = (p, b, t) => rest('PUT', p, b, t);
export const patch = (p, b, t) => rest('PATCH', p, b, t);
export const post = (p, b, t) => rest('POST', p, b, t);
export const del = (p, t) => rest('DELETE', p, undefined, t);

/* ---- 业务封装 ---- */
export const version = () => get('/version', 4000);
export const configs = () => get('/configs', 4000);
export const proxies = () => get('/proxies', 6000);
export const rules = () => get('/rules', 6000);
export const connections = () => get('/connections', 6000);
export const providers = (kind = 'proxies') => get(`/providers/${kind}`, 8000);
export const setMode = (mode) => patch('/configs', { mode });
export const selectProxy = (group, name) => put(`/proxies/${encodeURIComponent(group)}`, { name });
export const delayNode = (name, url, timeout = 5000) => get(`/proxies/${encodeURIComponent(name)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`, timeout + 3000);
export const closeConnection = (id) => del(`/connections/${encodeURIComponent(id)}`, 5000);
export const closeAllConnections = () => del('/connections', 5000);
export const flushDns = async () => { try { return await post('/cache/dns/flush', {}); } catch (_) { return post('/cache/flush', {}); } };
export const updateProxyProvider = (name) => put(`/providers/proxies/${encodeURIComponent(name)}`, '', 20000);
export const updateRuleProvider = (name) => put(`/providers/rules/${encodeURIComponent(name)}`, '', 20000);
export const healthCheckProvider = (name) => get(`/providers/proxies/${encodeURIComponent(name)}/healthcheck`, 20000);
export const ruleDisable = (index, disabled) => patch('/rules/disable', { index, disabled });

/** WebSocket 流（自动重连） */
export function openStream(path, { onMessage, onOpen, onClose } = {}) {
  let ws = null;
  let timer = null;
  let closedByUser = false;
  const connect = () => {
    if (!BASE) return;
    const sep = path.includes('?') ? '&' : '?';
    ws = new WebSocket(`ws://127.0.0.1:${endpoint().port}${path}${sep}token=${encodeURIComponent(SECRET)}`);
    ws.onopen = () => { onOpen && onOpen(); if (timer) { clearTimeout(timer); timer = null; } };
    ws.onmessage = (ev) => { try { onMessage && onMessage(JSON.parse(ev.data)); } catch (_) {} };
    ws.onclose = () => {
      ws = null;
      onClose && onClose();
      if (!closedByUser) timer = setTimeout(connect, 1500);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  };
  connect();
  return {
    close() { closedByUser = true; if (timer) clearTimeout(timer); try { ws && ws.close(); } catch (_) {} },
    send(data) { try { ws && ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch (_) {} }
  };
}
