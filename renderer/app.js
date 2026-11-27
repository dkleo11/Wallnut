/* 应用外壳：标题栏（大开关 / 风车模式）、左侧导航、状态栏、路由与数据接线 */

import { h, html, Icon, ToastHost, Spinner, fmtSpeed, fmtBytes, fmtDuration } from './ui.js';
import { useState, useEffect, useRef } from './vendor/hooks.mjs';
import { render } from './vendor/preact.mjs';
import { S, useStore, boot, wireEvents, toast, setPage, call, saveSettings, applyTheme, setTheme } from './store.js';
import * as client from './client.js';

import Home from './pages/home.js';
import { createTrafficSampler, isRejectedRoute } from './topbar-traffic.mjs';
import Nodes from './pages/nodes.js';
import Groups from './pages/groups.js';
import Rules from './pages/rules.js';
import Rewrite from './pages/rewrite.js';
import Cert from './pages/cert.js';
import Activity from './pages/activity.js';
import Logs from './pages/logs.js';
import Settings from './pages/settings.js';

/* 导航按「概览 / 代理 / 监控 / 系统」分组（HIG：侧栏最多两级层次） */
const NAV_GROUPS = [
  { label: '概览', items: [{ id: 'home', label: '首页', icon: 'home', page: Home }] },
  { label: '代理', items: [
    { id: 'nodes', label: '节点', icon: 'node', page: Nodes },
    { id: 'groups', label: '策略', icon: 'strategy', page: Groups },
    { id: 'rules', label: '规则', icon: 'rules', page: Rules },
    { id: 'rewrite', label: '重写', icon: 'rewrite', page: Rewrite }
  ] },
  { label: '监控', items: [
    { id: 'activity', label: '活动', icon: 'activity', page: Activity },
    { id: 'logs', label: '日志', icon: 'logs', page: Logs }
  ] },
  { label: '系统', items: [
    { id: 'cert', label: '证书', icon: 'cert', page: Cert },
    { id: 'settings', label: '设置', icon: 'settings', page: Settings }
  ] }
];
const NAV = NAV_GROUPS.reduce((acc, g) => acc.concat(g.items), []);

const MODE_LABEL = { rule: '规则分流', global: '全部代理', direct: '全部直连' };
/* 三色线：规则分流=红(拦截)/蓝(代理)/黄(直连)；全部代理=三蓝；全部直连=三黄 */
const MODE_COLORS = {
  rule: ['#FF453A', '#0A84FF', '#FFB340'],
  global: ['#0A84FF', '#0A84FF', '#0A84FF'],
  direct: ['#FFB340', '#FFB340', '#FFB340']
};
const MODE_ROUTES = {
  rule: ['reject', 'proxy', 'direct'],
  global: ['proxy', 'proxy', 'proxy'],
  direct: ['direct', 'direct', 'direct']
};

let wired = false;
let streams = [];
let streamKey = '';
let sampleTraffic = createTrafficSampler();
let routeActivity = {};
let rejectTimer;
let connectionsPending = false;

/* /logs WS 每来一行就替换一次 600 条数组并把整棵树重渲染，代价过高：
   先入缓冲，200ms 合并成一次状态更新（与 10fps 的 tick 节流配合） */
let uiLogBuf = [];
let uiLogTimer = null;
let uiLogSeq = 0;
function scheduleUiLogFlush() {
  if (uiLogTimer) return;
  uiLogTimer = setTimeout(() => {
    uiLogTimer = null;
    if (!uiLogBuf.length) return;
    const batch = uiLogBuf.splice(0);
    S.uiLogs = [...(S.uiLogs || []), ...batch].slice(-600);
    window.__wallnutTick && window.__wallnutTick();
  }, 200);
}

function closeStreams() {
  clearTimeout(rejectTimer);
  clearTimeout(uiLogTimer);
  uiLogTimer = null;
  uiLogBuf = [];
  sampleTraffic = createTrafficSampler();
  routeActivity = {};
  S.routeHistory = [];
  S.history = [];
  streams.forEach((s) => { try { s.close && s.close(); } catch (_) {} });
  streams = [];
  streamKey = '';
}

function connectStreams() {
  const coords = (S.core && S.core.ports) || {};
  if (!S.core.running || !coords.port) { closeStreams(); return; }
  if (streamKey === String(coords.port) && streams.length) return;
  closeStreams();
  streamKey = String(coords.port);
  client.configure(coords.port, (S.state && S.state.settings.secret) || '');
  const tick = () => window.__wallnutTick && window.__wallnutTick();

  streams.push(client.openStream('/traffic', {
    onMessage: (m) => {
      S.traffic = m;
      tick();
    }
  }));

  streams.push(client.openStream('/memory', {
    onMessage: (m) => { S.runtime = { ...S.runtime, memory: m }; tick(); }
  }));

  streams.push(client.openStream('/logs?level=' + ((S.state && S.state.settings.logLevel) || 'info'), {
    onMessage: (m) => {
      uiLogBuf.push({ t: Date.now(), level: m.type || 'info', payload: m.payload, _k: ++uiLogSeq });
      if (isRejectedRoute(m.payload)) {
        routeActivity.reject = true;
        clearTimeout(rejectTimer);
        rejectTimer = setTimeout(() => { routeActivity.reject = false; tick(); }, 1400);
      }
      scheduleUiLogFlush();
    }
  }));

}

async function refreshRuntime(opts = {}) {
  if (!S.core.running) return;
  const tick = () => window.__wallnutTick && window.__wallnutTick();
  if (!opts.connectionsOnly) {
    try {
      const [px, cf, rs] = await Promise.all([client.proxies(), client.configs(), client.rules()]);
      S.runtime = { ...S.runtime, proxies: px, configs: cf, rules: (rs && rs.rules) || [] };
      tick();
    } catch (err) { console.error('[wallnut] refresh proxies failed:', err && err.message); }
  }
  if (connectionsPending || !S.core.running) return;
  connectionsPending = true;
  const sampler = sampleTraffic;
  try {
    const cn = await client.connections();
    if (sampler !== sampleTraffic || !S.core.running) return;
    const connections = cn.connections || [];
    const sampled = sampler(connections);
    Object.assign(routeActivity, sampled);
    S.runtime = { ...S.runtime, connections };
    S.connectionsDownloadTotal = cn.downloadTotal || 0;
    S.connectionsUploadTotal = cn.uploadTotal || 0;
    const at = Date.now();
    S.routeHistory = [
      ...(S.routeHistory || []),
      { t: at, proxy: sampled.proxyRate || 0, direct: sampled.directRate || 0, conns: sampled.conns || connections.length }
    ].slice(-300);
    S.history = [
      ...(S.history || []),
      { t: at, up: sampled.upRate || 0, down: sampled.downRate || 0 }
    ].slice(-300);
    tick();
  } catch (err) {
    if (sampler === sampleTraffic) {
      sampleTraffic = createTrafficSampler();
      Object.assign(routeActivity, { proxy: false, direct: false });
      tick();
    }
    console.error('[wallnut] refresh connections failed:', err && err.message);
  } finally { connectionsPending = false; }
}

/* ---------------- 三色线：分流方式 + 实时流量（同一个控件） ---------------- */
function ModeLines({ mode = 'rule', running = false, activity = {}, dur = '1.2s', amp = '1', sx = '.93' }) {
  const colors = MODE_COLORS[mode] || MODE_COLORS.rule;
  const routes = MODE_ROUTES[mode] || MODE_ROUTES.rule;
  return html`<svg class="windmill mode-lines" viewBox="0 0 24 24" aria-hidden="true"
      style=${{ '--dur': dur, '--amp': amp, '--sx': sx }}>
    ${colors.map((color, i) => html`<path key=${mode + i} d=${`M5 ${6 + i * 6}h14`} stroke=${color}
      stroke-width="3" stroke-linecap="round" fill="none"
      class=${running && activity[routes[i]] ? 'line-active' : ''} />`)}
  </svg>`;
}

function ModeMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  /* 点空白处 / 按 Esc 自动收起（下拉菜单的常规行为） */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const mode = (S.state && S.state.settings.mode) || 'rule';
  const running = S.core.running;
  const speed = (S.traffic.down || 0) + (S.traffic.up || 0);
  const dur = Math.max(0.55, 1.35 - Math.min(0.8, speed / 5e6)).toFixed(2) + 's';
  const amp = Math.min(1.9, 0.55 + speed / 3.2e6).toFixed(2);
  const sx = Math.max(0.86, 0.96 - Math.min(0.1, speed / 4e7)).toFixed(3);

  const choose = async (m) => {
    setOpen(false);
    if (busy || m === mode) return;
    setBusy(true);
    try {
      const result = await saveSettings({ mode: m });
      if (result?.applied?.ok === false) toast(result.applied.error || '运行模式应用失败', 'error');
      else if (result?.ok) toast('运行模式：' + MODE_LABEL[m], 'ok');
    } finally { setBusy(false); }
  };

  return html`<div class="mode-menu" ref=${rootRef}>
    <button type="button" class="mode-trigger" aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'}
      aria-label=${'代理模式：' + MODE_LABEL[mode]} aria-disabled=${busy}
      title="三条线既是分流方式，也是实时流量：规则分流=红/蓝/黄，全部代理=三条蓝，全部直连=三条黄"
      onClick=${() => setOpen(!open)}>
      <${ModeLines} mode=${mode} running=${running} activity=${routeActivity} dur=${dur} amp=${amp} sx=${sx} />
      <span class="mode-name">${MODE_LABEL[mode]}</span>
      <${Icon} name="chev" cls="ico-12 chev" />
    </button>
    ${open ? html`<div class="mode-pop" role="menu" id="route-options">
      ${['rule', 'global', 'direct'].map((m) => html`<button key=${m} type="button" role="menuitemradio"
        class=${m === mode ? 'on' : ''} aria-pressed=${m === mode} onClick=${() => choose(m)}>
        <span class="windmill mode-lines" style="width:16px;height:16px">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            ${MODE_COLORS[m].map((c, i) => html`<path d=${`M5 ${6 + i * 6}h14`} stroke=${c}
              stroke-width="3" stroke-linecap="round" fill="none" />`)}
          </svg>
        </span>
        <span>${MODE_LABEL[m]}</span>
        ${m === mode ? html`<${Icon} name="check" cls="ico-12" />` : null}
      </button>`)}
    </div>` : null}
  </div>`;
}

function PowerButton() {
  const [busy, setBusy] = useState(false);
  const running = S.core.running;
  const toggle = async () => {
    setBusy(true);
    if (running) {
      await call('core:stop');
      toast('内核已停止', 'info');
    } else {
      await call('core:start');
    }
    setBusy(false);
  };
  return html`<button class=${'power ' + (running ? 'on' : 'off') + (busy ? ' busy' : '')} onClick=${toggle}
    title=${running ? '断开（停止内核）' : '连接（启动内核）'}>
    <${Icon} name="power" />
  </button>`;
}

function ThemeButton() {
  const dark = S.theme === 'dark';
  return html`<button class="icon-btn" title=${dark ? '切换到浅色外观' : '切换到深色外观'}
    aria-label=${dark ? '切换到浅色外观' : '切换到深色外观'}
    onClick=${async () => {
      const r = await setTheme(dark ? 'light' : 'dark');
      if (r && r.ok === false) return;
      toast('外观已切换', 'ok');
    }}>
    <${Icon} name=${dark ? 'sun' : 'moon'} />
  </button>`;
}

function StatusBar() {
  const running = S.core.running;
  const speed = fmtSpeed(S.traffic.down);
  const up = fmtSpeed(S.traffic.up);
  const total = fmtBytes(S.downloadTotal || S.traffic.downTotal || 0);
  return html`<footer class="statusbar">
    <div class="sb-left">
      <span class="sb-item"><${Icon} name="down" cls="sb-ico c-blue" /><span class="v">${speed.v}</span><span>${speed.u}</span></span>
      <span class="sb-dot"></span>
      <span class="sb-item"><${Icon} name="up" cls="sb-ico c-green" /><span class="v">${up.v}</span><span>${up.u}</span></span>
      <span class="sb-dot"></span>
      <span class="sb-item">累计 <span class="v">${total.v} ${total.u}</span></span>
      <span class="sb-dot"></span>
      <span class="sb-item">连接 <span class="v">${(S.runtime.connections || []).length}</span></span>
    </div>
    <div class="sb-right">
      <span class="sb-item">内核 <span class="v">${running ? (S.core.version || 'mihomo') : '未运行'}</span></span>
      <span class="sb-dot"></span>
      <span class="sb-item">节点 <span class="v">${S.nodes.length}</span></span>
      <span class="sb-item">规则 <span class="v">${(S.runtime.rules || []).length}</span></span>
      ${running && S.core.startedAt ? html`<span class="sb-dot"></span>
        <span class="sb-item">已运行 <span class="v">${fmtDuration(Date.now() - S.core.startedAt)}</span></span>` : null}
    </div>
  </footer>`;
}

/** 左下角连接状态：显示「订阅名 / 节点名」，订阅匹配不到时退回节点名 */
function connectionInfo() {
  if (!S.core.running) return { pending: true, text: '点击启动内核' };
  const target = (S.state && S.state.settings.defaultTarget) || '主策略';
  const proxies = (S.runtime && S.runtime.proxies && S.runtime.proxies.proxies) || {};
  const root = proxies[target] || {};
  // 主策略可能指向地区组：逐层跟到真正的节点，否则只会显示组名（拿不到订阅信息）
  let name = root.now || target;
  const seen = new Set();
  while (name && proxies[name] && proxies[name].now && proxies[name].now !== name && !seen.has(name)) {
    seen.add(name);
    name = proxies[name].now;
  }
  const info = (S.nodes || []).find((n) => n.name === name);
  const sub = info ? ((S.state && S.state.subscriptions) || []).find((x) => x.id === info.sourceId) : null;
  const source = info ? (sub ? sub.name : (info.sourceId === 'local' ? '本地节点' : (info.source || ''))) : '';
  const same = source === name;
  return { pending: false, node: name, sub: same ? '' : source, text: source && !same ? `${source} / ${name}` : name };
}

function Rail() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('wallnut.rail') === '1'; } catch (_) { return false; }
  });
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem('wallnut.rail', next ? '1' : '0'); } catch (_) {}
  };
  const LEGACY_PAGE = { regions: 'groups', subs: 'nodes' };
  const pageId = LEGACY_PAGE[S.page] || S.page;
  const conn = connectionInfo();

  return html`<aside class=${'rail' + (collapsed ? ' collapsed' : '')}>
    <div class="rail-head">
      <div class="logo" onClick=${collapsed ? toggle : undefined} title=${collapsed ? '展开侧栏' : 'Wallnut'}>
        <img src="../resources/icon.png" alt="" />
      </div>
      <div class="brand">
        <span class="brandname">Wallnut</span>
        <span class="rail-sub">mihomo 内核</span>
      </div>
      <button class="rail-collapse" onClick=${toggle} title=${collapsed ? '展开侧栏' : '收起侧栏'}
        aria-label=${collapsed ? '展开侧栏' : '收起侧栏'}>
        <${Icon} name="chev-r" cls="ico-14" />
      </button>
    </div>

    <nav class="rail-nav" aria-label="主导航">
      ${NAV_GROUPS.map((g) => html`<div class="nav-group" key=${g.label}>
        <span class="nav-label">${g.label}</span>
        ${g.items.map((n) => html`<button key=${n.id} class=${'nav-item' + (pageId === n.id ? ' active' : '')}
          onClick=${() => setPage(n.id)} title=${n.label} aria-current=${pageId === n.id ? 'page' : 'false'}>
          <${Icon} name=${n.icon} /><span class="lbl">${n.label}</span>
        </button>`)}
      </div>`)}
    </nav>

    <div class="rail-foot">
      <button class="conn-pill" title=${conn.pending ? '连接（启动内核）' : conn.text + ' · 断开（停止内核）'}
        onClick=${async () => {
          if (S.core.running) { await call('core:stop'); toast('内核已停止', 'info'); }
          else { await call('core:start'); }
        }}>
        <span class="dot"></span>
        <span class="conn-txt">
          <b>${S.core.running ? '已连接' : '未连接'}</b>
          <span class="conn-detail">${conn.text}</span>
        </span>
        <${Icon} name="power" cls="ico-14" />
      </button>
    </div>
  </aside>`;
}

export default function App() {
  useStore();
  const [, setReady] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    /* 合并高频事件（日志 / 连接 / 流量）触发的重渲染：最多 10fps。
       之前每条日志、每次 WS 推送都会 tick 一次，等于每条消息重渲染整棵树。 */
    let pending = 0;
    window.__wallnutTick = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = 0; tick((x) => x + 1); }, 100);
    };
    (async () => {
      if (!wired) { wired = true; wireEvents(); }
      const data = await boot();
      if (data && data.theme) applyTheme(data.theme);
      setReady(true);
      window.__wallnutDebug = Object.assign(window.__wallnutDebug || {}, { refresh: refreshRuntime, client, S });
      connectStreams();
      refreshRuntime();
    })();
    return () => { window.__wallnutTick = null; if (pending) clearTimeout(pending); closeStreams(); };
  }, []);

  useEffect(() => {
    if (!S.booted) return undefined;
    connectStreams();
    if (!S.core.running) return undefined;
    refreshRuntime();
    // 连接列表轮询：1s 一次即可（活动页标注的也是「每 1 秒刷新」），
    // 200ms 会在代理繁忙时产生 5 次/秒的 /connections 全量传输与解析。
    const pid = setInterval(() => refreshRuntime({ connectionsOnly: true }), 1000);
    const slowPid = setInterval(() => refreshRuntime(), 5000);
    return () => { clearInterval(pid); clearInterval(slowPid); };
  }, [S.booted, S.core.running, S.core.status]);

  const LEGACY_PAGE = { regions: 'groups', subs: 'nodes' };
  const pageId = LEGACY_PAGE[S.page] || S.page;
  const current = NAV.find((n) => n.id === pageId) || NAV[0];
  const PageComp = current.page;

  if (S.loading) {
    return html`<div class=${'window' + (S.theme === 'dark' ? ' dark' : '')}>
      <div style="flex:1;display:grid;place-items:center">
        <div style="display:flex;flex-direction:column;align-items:center;gap:12px">
          <div class="logo" style="width:44px;height:44px;border-radius:12px"><img src="../resources/icon.png" alt="" /></div>
          <span class="sub">${S.error ? '启动失败：' + S.error : '正在启动内核…'}</span>
          <${Spinner} />
        </div>
      </div>
    </div>`;
  }

  return html`<div class=${'window' + (S.theme === 'dark' ? ' dark' : '')} data-on=${S.core.running ? '1' : '0'}>
    <${Rail} />
    <div class="main">
      <header class="topbar">
        <div class="tb-title"><h1>${current.label}</h1></div>
        <div class="tb-right">
          <div class="capsule traffic" title="实时速率">
            <span class="t-item"><${Icon} name="down" cls="ico-12 c-blue" /><b>${fmtSpeed(S.traffic.down).v}</b><i>${fmtSpeed(S.traffic.down).u}</i></span>
            <span class="t-sep"></span>
            <span class="t-item"><${Icon} name="up" cls="ico-12 c-green" /><b>${fmtSpeed(S.traffic.up).v}</b><i>${fmtSpeed(S.traffic.up).u}</i></span>
          </div>
          <${ModeMenu} />
          <${ThemeButton} />
          <${PowerButton} />
        </div>
      </header>

      <section class="content">
        <${PageComp} key=${pageId} />
      </section>

      <${StatusBar} />
    </div>
    <${ToastHost} toasts=${S.toasts} />
  </div>`;
}

/* 启动 */
render(h(App, {}), document.getElementById('root'));
