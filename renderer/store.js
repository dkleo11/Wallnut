/* 全局状态：后端 bootstrap 快照 + 实时流量/日志/测速 + 轻量事件总线 */

import { useReducer, useEffect } from './vendor/hooks.mjs';
import { getLanguage, setLanguage, setProtectedStrings, tr } from './i18n.js';

export const S = {
  booted: false,
  portable: false,
  loading: true,
  error: null,
  state: null,              // { settings, subscriptions, localNodes, regions, rules, ruleProviders, groups, ui }
  nodes: [],                // [{name,type,server,port,source,sourceId,region}]
  regions: [],              // [{id,name,flag,count,mode,selected,best,sources,nodes}]
  presets: [],
  core: { status: 'idle', running: false, version: null, ports: {}, error: null },
  rewrite: { running: false, port: 8890, hits: 0, bytes: 0, errors: [] },
  ca: { exists: false, installed: false },
  sys: { systemProxy: { enabled: false, server: '' }, elevated: false },
  paths: {},
  traffic: { up: 0, down: 0, upTotal: 0, downTotal: 0 },
  history: [],              // [{up,down,t}]
  routeHistory: [],          // [{proxy,direct,conns,t}] 最近 60 秒，首页双轴图
  logs: [],                 // [{t,stream,line}]
  uiLogs: [],               // 内核 WS /logs
  test: null,               // {scope,regionId,total,done,results[],summary,running}
  toasts: [],
  page: localStorage.getItem('wallnut.page') || 'home',
  theme: 'light',
  runtime: { configs: null, rules: [], proxies: null, connections: [] },
  modal: null
};

let toastSeq = 0;
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } }
}

export function set(patch) {
  Object.assign(S, patch);
  emit();
}

export function setPage(page) {
  S.page = page;
  try { localStorage.setItem('wallnut.page', page); } catch (_) {}
  emit();
}

export function toast(message, kind = 'info', ttl = 3000) {
  const id = ++toastSeq;
  S.toasts = [...S.toasts, { id, message, kind }].slice(-4);
  emit();
  setTimeout(() => {
    S.toasts = S.toasts.filter((t) => t.id !== id);
    emit();
  }, ttl);
}

export function invoke(channel, payload) {
  return window.wallnut.invoke(channel, payload);
}

/** 从注册表刷新系统代理实况：settings.systemProxy 可能与真实状态不同步（异常退出/外部修改），UI 以实况为准 */
export async function refreshSys() {
  try {
    const r = await invoke('net:status');
    if (r && r.systemProxy) {
      set({ sys: { systemProxy: { enabled: !!r.systemProxy.enabled, server: r.systemProxy.server || '' }, elevated: !!r.elevated } });
    }
    return r;
  } catch (_) { return null; }
}

/** 带上错误提示的调用封装 */
export async function call(channel, payload, { silent = false } = {}) {
  try {
    const r = await invoke(channel, payload);
    if (r && r.ok === false && r.error && !silent) toast(r.error, 'error', 4200);
    return r;
  } catch (err) {
    if (!silent) toast(err.message || String(err), 'error', 4200);
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */


function syncUiLanguage(state) {
  const lang = (state && state.settings && state.settings.language) || 'zh-CN';
  if (lang !== getLanguage()) {
    setLanguage(lang);
    try { localStorage.setItem('wallnut.lang', lang); } catch (_) {}
    // 让所有页面用新语言重新创建 VNode
    try { location.reload(); } catch (_) {}
  }
}

function syncProtectedStrings(data) {
  if (!data) return;
  const values = [];
  for (const n of data.nodes || []) if (n && n.name) values.push(n.name);
  const st = data.state || {};
  for (const s of st.subscriptions || []) if (s && s.name) values.push(s.name);
  for (const n of st.localNodes || []) if (n && n.name) values.push(n.name);
  for (const g of st.groups || []) if (g && g.name) values.push(g.name);
  setProtectedStrings(values);
}

export async function boot() {
  try {
    const data = await invoke('app:bootstrap');
    set({
      booted: true,
      portable: data.portable === true,
      loading: false,
      state: data.state,
      nodes: data.nodes || [],
      regions: data.regions || [],
      presets: data.presets || [],
      core: data.core || S.core,
      rewrite: data.rewrite || S.rewrite,
      ca: data.ca || S.ca,
      sys: { systemProxy: data.systemProxy || S.sys.systemProxy, elevated: !!data.elevated },
      paths: data.paths || {},
      test: data.lastTest ? { ...data.lastTest, running: false } : null,
      error: null
    });
    applyTheme((data.state && data.state.ui && data.state.ui.theme) || data.theme, data.state && data.state.ui, data.theme === 'dark');
    syncProtectedStrings(data);
    syncUiLanguage(data.state);
    window.__wallnutDebug = { S, set, setPage, setTheme, boot, tr };
    return data;
  } catch (err) {
    set({ loading: false, error: err.message });
    toast('初始化失败：' + err.message, 'error', 6000);
    return null;
  }
}

export function applyTheme(theme) {
  const dark = theme === 'dark';
  S.theme = dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', dark);
  const win = document.querySelector('.window');
  if (win) {
    win.classList.toggle('dark', dark);
    // 自定义背景/主题色已移除：清掉旧版可能残留在元素上的内联覆盖（含 CSS 预留的 --custom-* 钩子）
    ['--bg', '--custom-bg', '--blue', '--custom-accent', '--blue-tint', '--custom-accent-tint',
     '--nav-active', '--custom-nav-active', '--t-blue', '--custom-accent-text']
      .forEach((k) => win.style.removeProperty(k));
  }
}

/** 切换外观：light / dark / system（后端 nativeTheme 决定实际明暗 + 持久化） */
export async function setTheme(theme) {
  const choice = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  const r = await invoke('app:theme', choice);
  const resolved = (r && typeof r.dark === 'boolean')
    ? (r.dark ? 'dark' : 'light')
    : (choice === 'dark' ? 'dark' : 'light');
  applyTheme(resolved);
  if (S.state) {
    set({
      theme: resolved,
      state: { ...S.state, ui: { ...(S.state.ui || {}), theme: choice } }
    });
  } else {
    set({ theme: resolved });
  }
  return r;
}

export function isDark() {
  return document.documentElement.classList.contains('dark');
}

/* ------------------------------------------------------------------ */
/* 事件接线                                                           */
/* ------------------------------------------------------------------ */

const NAV_PAGES = ['home', 'nodes', 'groups', 'rules', 'rewrite', 'cert', 'activity', 'logs', 'settings'];

export function wireEvents() {
  window.wallnut.on('state', (payload) => {
    syncProtectedStrings(payload);
    syncUiLanguage(payload.state);
    // settings.systemProxy 可能被「重写开关联动」「托盘」「设置页」改动：同步刷新系统代理卡片的状态
    set({
      state: payload.state,
      nodes: payload.nodes || [],
      regions: payload.regions || [],
      sys: { ...S.sys, systemProxy: { ...S.sys.systemProxy, enabled: !!payload.state?.settings?.systemProxy } }
    });
  });

  window.wallnut.on('auto:switch', (info) => {
    if (!info) return;
    const from = info.fromDelay ? `${info.from} ${info.fromDelay}ms` : info.from;
    const to = info.toDelay ? `${info.to} ${info.toDelay}ms` : info.to;
    toast(`节点过慢，已自动切换：${from} → ${to}`, 'ok', 4200);
  });

  window.wallnut.on('rewrite', (payload) => {
    if (payload && payload.engine) set({ rewrite: payload.engine });
    if (payload && payload.ca) set({ ca: payload.ca });
  });

  window.wallnut.on('core', (core) => {
    set({ core });
    if (core.status === 'error' && core.error) toast(core.error, 'error', 5000);
  });

  /* 内核日志逐条 set() 会让所有组件每来一行日志就重渲染一次：
     先缓冲 200ms 合并成一次更新（与渲染层 10fps 节流配合） */
  let logBuf = [];
  let logTimer = null;
  let logSeq = 0;
  const flushLogs = () => {
    logTimer = null;
    if (!logBuf.length) return;
    const batch = logBuf.splice(0);
    set({ logs: [...S.logs, ...batch].slice(-1000) });
  };
  window.wallnut.on('log', (entry) => {
    if (entry && typeof entry === 'object' && !entry._k) entry._k = ++logSeq;
    logBuf.push(entry);
    if (logBuf.length >= 400) { clearTimeout(logTimer); flushLogs(); }
    else if (!logTimer) logTimer = setTimeout(flushLogs, 200);
  });

  window.wallnut.on('test', (ev) => {
    if (ev.type === 'start') {
      set({ test: { scope: ev.scope, regionId: ev.regionId, total: ev.total, done: 0, results: [], running: true, startedAt: Date.now() } });
    } else if (ev.type === 'result') {
      const t = S.test || { results: [], total: ev.total };
      set({ test: { ...t, done: ev.done, total: ev.total, running: true, results: [...(t.results || []), { name: ev.name, delay: ev.delay, ok: ev.ok, error: ev.error }] } });
    } else if (ev.type === 'done') {
      set({ test: { ...(S.test || {}), running: false, summary: ev, results: ev.results || (S.test && S.test.results) || [] } });
    }
  });

  window.wallnut.on('toast', (t) => toast(t.message, t.kind === 'error' ? 'error' : t.kind === 'warn' ? 'info' : 'ok'));

  window.wallnut.on('navigate', (page) => { if (NAV_PAGES.includes(page)) setPage(page); });
}

/* ------------------------------------------------------------------ */
/* 常用动作                                                           */
/* ------------------------------------------------------------------ */

export async function saveSettings(patch, opts) {
  const r = await call('app:settings:save', patch, opts);
  if (r && r.ok) set({ state: { ...S.state, settings: { ...S.state.settings, ...patch } } });
  return r;
}

export const testUrl = () => (S.state && S.state.settings.testUrl) || 'https://www.gstatic.com/generate_204';

export async function runRegionTest(regionId, names) {
  if (!S.core.running) return toast('内核未运行，请先在首页连接', 'error');
  const r = await call('test:start', { scope: 'region', regionId, names, url: testUrl() });
  if (r && r.ok) set({ test: { scope: 'region', regionId, total: names ? names.length : 0, done: 0, results: [], running: true } });
  return r;
}

export async function runAllTest() {
  if (!S.core.running) return toast('内核未运行，请先在首页连接', 'error');
  const r = await call('test:start', { scope: 'all', url: testUrl() });
  if (r && r.ok) set({ test: { scope: 'all', total: S.nodes.length, done: 0, results: [], running: true } });
  return r;
}

export async function cancelTest() {
  await call('test:cancel');
  if (S.test) set({ test: { ...S.test, running: false } });
}

export async function applyFastest(region, name) {
  const r = await call('region:applyFastest', { id: region.id, name, forceManual: true });
  if (r && r.ok) toast(`已把「${region.name}」切到 ${name}`, 'ok');
  return r;
}

/**
 * 热切换节点：只改 selector 当前节点，不重载配置（不会断开任何已有连接）。
 * 成功后立刻就地更新 now 并重绘，点击即生效，不必等 1 秒轮询。
 */
export async function switchNode(group, name, regionId = null) {
  if (!S.core.running) { toast('mihomo 未运行，请先在首页连接', 'error'); return { ok: false }; }
  const r = await call('proxy:select', { group, name, regionId }, { silent: true });
  if (r && r.ok) {
    const p = S.runtime && S.runtime.proxies && S.runtime.proxies.proxies;
    if (p && p[group]) p[group].now = name;
    emit();
    toast(`已切换到「${name}」`, 'ok');
  } else {
    toast((r && r.error) || '切换失败', 'error');
  }
  return r || { ok: false };
}

export function regionById(id) {
  return S.regions.find((r) => r.id === id);
}

export function sortedRegions() {
  return [...S.regions].sort((a, b) => (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name));
}

/** 目标候选：地区组 / 主策略 / 自定义组 / DIRECT */
export function groupTargets() {
  const mainName = (S.state && S.state.settings.defaultTarget) || '主策略';
  const regions = S.regions.filter((r) => r.enabled !== false).map((r) => ({ name: r.name, kind: 'region', flag: r.flag }));
  const groups = ((S.state && S.state.groups) || []).map((g) => ({ name: g.name, kind: 'group' }));
  return [{ name: mainName, kind: 'main', flag: '' }, ...regions, ...groups,
    { name: 'DIRECT', kind: 'builtin', flag: '' }, { name: 'REJECT', kind: 'builtin', flag: '' }];
}

/** 节点延迟表：name → ms（来自最近一次测速与 WS 历史） */
let _dmCache = { test: null, proxies: null, map: {} };
export function delayMap() {
  if (S.test === _dmCache.test && S.runtime.proxies === _dmCache.proxies) return _dmCache.map;
  const map = {};
  if (S.test && S.test.results) for (const r of S.test.results) map[r.name] = r.ok ? r.delay : -1;
  if (S.runtime && S.runtime.proxies) {
    for (const [name, p] of Object.entries(S.runtime.proxies.proxies || {})) {
      const h = p.history && p.history[p.history.length - 1];
      if (h && h.delay) map[name] = map[name] || h.delay;
    }
  }
  _dmCache = { test: S.test, proxies: S.runtime.proxies, map };
  return map;
}

/* 组件用：任意状态变化就重渲染 */
export function useStore() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribe(force), []);
  return S;
}
