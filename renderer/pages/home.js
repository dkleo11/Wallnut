/* 首页：大开关 + 实时速率 + 快捷操作 + 面板网格（对应原型画板 01） */

import { html, Icon, Windmill, fmtBytes, fmtSpeed, fmtDuration, useStore, useState } from '../ui.js';
import { S, call, toast, runAllTest, cancelTest, setPage } from '../store.js';
import * as client from '../client.js';

const MODE_LABEL = { rule: '规则分流', global: '全部代理', direct: '全部直连' };

function nodeInfo() {
  const group = (S.state && S.state.settings.defaultTarget) || '主策略';
  const p = S.runtime.proxies && S.runtime.proxies.proxies;
  if (!p) return { name: '—', source: '', delay: null, group };
  const root = p[group];
  let name = (root && root.now) || null;
  const seen = new Set();
  while (name && p[name] && p[name].now && p[name].now !== name && !seen.has(name)) {
    seen.add(name);
    name = p[name].now;
  }
  let delay = null;
  if (name && p[name] && p[name].history && p[name].history.length) {
    const h = p[name].history[p[name].history.length - 1];
    if (h && h.delay) delay = h.delay;
  }
  const node = name && (S.nodes || []).find((n) => n.name === name);
  return { name: name || '未选择节点', source: node ? (node.source || '本地节点') : '', delay, group };
}

function Spark({ values, color, grad }) {
  const n = Math.max(values.length, 2);
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (n - 1)) * 160, 8 - Math.min(6.4, (v / max) * 6.2)]);
  const line = pts.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');
  return html`<svg class="track" viewBox="0 0 160 8" preserveAspectRatio="none" style="width:100%">
    <path d=${line + ' L160 8 L0 8 Z'} fill=${'url(#' + grad + ')'} />
    <path d=${line || 'M0 6 L160 6'} fill="none" stroke=${color} stroke-width="1.2" stroke-linecap="round" />
  </svg>`;
}

function Tile({ icon, color, label, tag, value, unit, sub, dim, onClick }) {
  return html`<div class=${'tile' + (dim ? ' dim' : '')} onClick=${onClick} style=${onClick ? 'cursor:pointer' : ''}>
    <div class="tile-top"><${Icon} name=${icon} cls=${color} /><span class="k">${label}</span>${tag ? html`<span class="tag type">${tag}</span>` : null}</div>
    <div class="tile-v">${value}${unit ? html`<span class="unit">${unit}</span>` : null}</div>
    <div class="tile-s">${sub}</div>
  </div>`;
}

export default function Home() {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const running = S.core.running;
  const info = nodeInfo();
  const settings = S.state.settings;
  const mode = settings.mode || 'rule';
  const conns = S.runtime.connections || [];
  const tcp = conns.filter((c) => (c.metadata && c.metadata.network) === 'tcp').length;
  const udp = conns.filter((c) => (c.metadata && c.metadata.network) === 'udp').length;
  const rulesHits = (S.runtime.rules || []).reduce((a, r) => a + (r.hitCount || 0), 0);
  const errors = (settings && S.state.subscriptions || []).filter((x) => x.lastError).length;
  const hist = S.history || [];
  const down = hist.map((h) => h.down || 0);
  const up = hist.map((h) => h.up || 0);
  const curDown = fmtSpeed(S.traffic.down);
  const curUp = fmtSpeed(S.traffic.up);
  const total = fmtBytes(S.traffic.downTotal || 0);
  const totalUp = fmtBytes(S.traffic.upTotal || 0);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    if (running) { await call('core:stop'); toast('内核已停止', 'info'); }
    else { const r = await call('core:start'); if (r && r.ok) toast('内核已启动', 'ok'); }
    setBusy(false);
  };

  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <section class="hero panel">
      <div class="hero-left">
        <button class=${'conn' + (running ? '' : ' off') + (busy ? ' pending' : '')} onClick=${toggle}
          title=${running ? '断开' : '连接'} style="border:0;cursor:pointer">
          <span class="ripple"></span>
          <span class="ripple r2"></span>
          <${Icon} name="power" />
        </button>
        <span class="conn-label">${busy ? (running ? '正在断开…' : '正在连接…') : running ? '已连接' : '未连接'}</span>
        <span class="conn-sub">
          ${running
            ? html`${info.name}${info.source ? ' · ' + info.source : ''}${info.delay ? ' · ' + info.delay + 'ms' : ''}<br />已运行 ${fmtDuration(Date.now() - (S.core.startedAt || Date.now()))}`
            : html`点击上方按钮启动 mihomo 内核`}
        </span>
      </div>
      <div class="hero-right">
        ${errors ? html`<span class="alert" style="cursor:pointer"><${Icon} name="alert" />有 ${errors} 个资源更新失败</span>` : null}
        <div class="metrics">
          <div class="metric clickable" role="button" tabIndex="0" title="打开节点列表"
            onClick=${() => setPage('nodes')} onKeyDown=${(e) => { if (e.key === 'Enter') setPage('nodes'); }}>
            <span class="k">当前节点</span>
            <div class="mv">${info.name}<span class="sub">${info.source ? '· ' + info.source + ' ' : ''}${info.delay ? '· ' + info.delay + 'ms' : ''}</span></div>
          </div>
          <div class="metric clickable" role="button" tabIndex="0" title=${mode === 'rule' ? '打开分流规则' : '打开策略组'}
            onClick=${() => setPage(mode === 'rule' ? 'rules' : 'groups')} onKeyDown=${(e) => { if (e.key === 'Enter') setPage(mode === 'rule' ? 'rules' : 'groups'); }}>
            <span class="k">运行模式</span>
            <div class="mv"><${Windmill} mode=${mode} size=${14} />${MODE_LABEL[mode]}<span class="sub">· 规则库 ${(S.runtime.rules || []).length}</span></div>
          </div>
          <div class="metric clickable" role="button" tabIndex="0" title="查看网络活动"
            onClick=${() => setPage('activity')} onKeyDown=${(e) => { if (e.key === 'Enter') setPage('activity'); }}>
            <span class="k">今日流量</span>
            <div class="mv">${total.v} ${total.u}<span class="sub">· 上行 ${totalUp.v} ${totalUp.u}</span></div>
          </div>
          <div class="metric clickable" role="button" tabIndex="0" title="查看活跃连接"
            onClick=${() => setPage('activity')} onKeyDown=${(e) => { if (e.key === 'Enter') setPage('activity'); }}>
            <span class="k">活跃连接</span>
            <div class="mv">${conns.length}<span class="sub">· TCP ${tcp} · UDP ${udp}</span></div>
          </div>
        </div>
      </div>
    </section>

    <div class="mid" style="height:160px">
      <section class="rate-card card">
        <div class="card-head">
          <div class="row"><span class="card-title">实时速率</span><span class="live">实时</span></div>
          <span class="sub">趋势 · 近 60 秒</span>
        </div>
        <div class="rate-flex">
          <div class="rate-stat">
            <span class="k">下行</span>
            <div class="rate-num c-blue">${curDown.v}<span class="unit">${curDown.u}</span></div>
            <span class="sub">峰值 ${fmtBytes(Math.max(0, ...down)).v} ${fmtBytes(Math.max(0, ...down)).u}/s</span>
          </div>
          <div class="rate-stat">
            <span class="k">上行</span>
            <div class="rate-num c-green">${curUp.v}<span class="unit">${curUp.u}</span></div>
            <span class="sub">峰值 ${fmtBytes(Math.max(0, ...up)).v} ${fmtBytes(Math.max(0, ...up)).u}/s</span>
          </div>
          <div class="chart">
            <${Spark} values=${down.length ? down : [0, 0]} color="#0A84FF" grad="gd-down" />
            <${Spark} values=${up.length ? up : [0, 0]} color="#34C759" grad="gd-up" />
            <span class="legend"><i style="background:#0A84FF"></i>下行<i style="background:#34C759"></i>上行</span>
          </div>
        </div>
      </section>

      <section class="quick-card card">
        <div class="card-head"><span class="card-title">快捷操作</span><span class="sub">4 项</span></div>
        <div class="quick-grid">
          <button class="qa" onClick=${() => S.test && S.test.running ? cancelTest() : runAllTest()}>
            <span class="ichi tint-blue"><${Icon} name="gauge" /></span>
            <span><span class="qa-t">${S.test && S.test.running ? '停止测速' : '测速全部'}</span><span class="qa-s">${S.nodes.length} 个节点</span></span>
          </button>
          <button class="qa" onClick=${async () => { toast('正在更新全部订阅…', 'info'); await call('sub:updateAll'); toast('订阅更新完成', 'ok'); }}>
            <span class="ichi tint-indigo"><${Icon} name="refresh" /></span>
            <span><span class="qa-t">更新订阅</span><span class="qa-s">${(S.state.subscriptions || []).length} 个订阅</span></span>
          </button>
          <button class="qa" onClick=${async () => { await call('dns:flush'); toast('DNS 缓存已清空', 'ok'); }}>
            <span class="ichi tint-orange"><${Icon} name="trash" /></span>
            <span><span class="qa-t">清空 DNS 缓存</span><span class="qa-s">fake-ip ${settings.dns && settings.dns.fakeIp !== false ? '已启用' : '未启用'}</span></span>
          </button>
          <button class="qa" onClick=${async () => { const r = await call('core:restart'); if (r && r.ok) toast('内核已重启', 'ok'); }}>
            <span class="ichi tint-red"><${Icon} name="restart" /></span>
            <span><span class="qa-t">重启内核</span><span class="qa-s">${S.core.version || 'mihomo'}</span></span>
          </button>
        </div>
      </section>
    </div>

    <section class="tiles" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <${Tile} icon="target" color="c-purple" label="规则命中" tag="累计"
        value=${rulesHits ? rulesHits.toLocaleString() : '—'} unit=${rulesHits ? '次' : ''} sub=${`${(S.runtime.rules || []).length} 条规则 · 远程集 ${(S.state.ruleProviders || []).length}`} />
      <${Tile} icon="chip" color="c-blue" label="内核版本" tag="meta"
        value=${S.core.version || 'mihomo'} sub=${running ? 'PID ' + S.core.pid + ' · 已运行 ' + fmtDuration(Date.now() - (S.core.startedAt || Date.now())) : '未运行'} />
    </section>
  </div>`;
}
