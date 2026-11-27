/* 网络活动：连接列表 + 详情 + 关闭（QX 的「网络活动」） */

import { html, Icon, Button, Search, Tag, Empty, PageHead, Modal, fmtBytes, timeAgo, useStore, useState } from '../ui.js';
import { S, call, toast } from '../store.js';
import * as client from '../client.js';

function hostOf(c) {
  const m = c.metadata || {};
  const host = m.host || m.sniffHost || m.destinationIP || '未知目标';
  return host + (m.destinationPort ? ':' + m.destinationPort : '');
}

function policyOf(c) {
  const chain = (c.chains || []).map((x) => String(x || '').trim()).filter(Boolean);
  return chain.length ? chain.join(' → ') : '—';
}

let _prevConn = new Map();
let _prevConnAt = 0;
let _lastConns = null;
let _lastRates = {};

/** 每次 /connections 刷新时按 1 秒差值计算每条连接的实时速率；总流量仍取连接累计值 */
function rateOf(conns) {
  /* 同一份连接数据在多次重渲染中复用结果：
     否则每次非数据更新触发的重渲染都会把 _prevConnAt 刷新掉，
     既把速率显示成 0，又让下一次真实差值被极短的 dt 放大成尖峰。 */
  if (conns === _lastConns) return _lastRates;
  const now = Date.now();
  const dt = Math.max(0.2, (now - _prevConnAt) / 1000);
  const rates = {};
  for (const c of conns) {
    const prev = _prevConn.get(c.id);
    rates[c.id] = {
      up: prev ? Math.max(0, ((c.upload || 0) - prev.up) / dt) : 0,
      down: prev ? Math.max(0, ((c.download || 0) - prev.down) / dt) : 0
    };
  }
  _prevConn = new Map(conns.map((c) => [c.id, { up: c.upload || 0, down: c.download || 0 }]));
  _prevConnAt = now;
  _lastConns = conns;
  _lastRates = rates;
  return rates;
}

function Detail({ conn, onClose }) {
  const m = conn.metadata || {};
  const rows = [
    ['类型', `${m.type || ''} · ${m.network || ''}`],
    ['目标', hostOf(conn)],
    ['源地址', `${m.sourceIP || ''}${m.sourcePort ? ':' + m.sourcePort : ''}`],
    ['进程', m.processPath || m.process || '—'],
    ['规则', `${conn.rule || '—'}${conn.rulePayload ? ' · ' + conn.rulePayload : ''}`],
    ['链路', (conn.chains || []).join(' › ') || '—'],
    ['上传 / 下载', `${fmtBytes(conn.upload).v} ${fmtBytes(conn.upload).u} / ${fmtBytes(conn.download).v} ${fmtBytes(conn.download).u}`],
    ['开始时间', new Date(conn.start).toLocaleString()],
    ['连接 ID', conn.id]
  ];
  return html`<${Modal} title="连接详情" onClose=${onClose} width="620px" foot=${html`<button class="btn" onClick=${onClose}>关闭</button>
    <button class="btn danger" onClick=${async () => { await client.closeConnection(conn.id); toast('连接已结束', 'ok'); onClose(); }}>结束该连接</button>`}>
    <div class="card" style="box-shadow:none">
      ${rows.map(([k, v]) => html`<div class="set-row" key=${k}><span class="sub">${k}</span><span class="sv-strong mono" style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v || '—'}</span></div>`)}
    </div>
  </${Modal}>`;
}

export default function Activity() {
  const s = useStore();
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const conns = S.runtime.connections || [];
  const rates = rateOf(conns);
  const filtered = conns.filter((c) => {
    const q = query.trim().toLowerCase();
    return !q || hostOf(c).toLowerCase().includes(q) || policyOf(c).toLowerCase().includes(q);
  });
  const shown = filtered.slice(0, 300);
  const tcp = conns.filter((c) => (c.metadata || {}).network === 'tcp').length;
  const udp = conns.filter((c) => (c.metadata || {}).network === 'udp').length;
  const up = conns.reduce((a, c) => a + (c.upload || 0), 0);
  const down = conns.reduce((a, c) => a + (c.download || 0), 0);
  const activeUp = S.traffic && S.traffic.up ? S.traffic.up : 0;
  const activeDown = S.traffic && S.traffic.down ? S.traffic.down : 0;
  const totalUp = S.connectionsUploadTotal || S.uploadTotal || S.traffic && S.traffic.upTotal || 0;
  const totalDown = S.connectionsDownloadTotal || S.downloadTotal || S.traffic && S.traffic.downTotal || 0;

  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <${PageHead} title="网络活动" sub=${`${conns.length} 条活跃连接 · TCP ${tcp} · UDP ${udp}`}>
      <${Search} value=${query} onInput=${setQuery} placeholder="按域名 / IP 过滤" style="width:240px" />
      <button class="btn sm danger" disabled=${!conns.length} onClick=${async () => { if (!confirm(`结束全部 ${conns.length} 条连接？`)) return; await client.closeAllConnections(); toast('已关闭全部连接', 'ok'); }}>关闭全部</button>
    </${PageHead}>

    <div class="listbar">
      <div class="lb-left">
        <span class="lb-dot" style=${S.core.running ? 'background:var(--green)' : ''}></span>
        <strong>${conns.length}</strong> 条
        <span class="sb-dot"></span>
        <span>上传 ${fmtBytes(activeUp).v} ${fmtBytes(activeUp).u}/s</span>
        <span class="sb-dot"></span>
        <span>下载 ${fmtBytes(activeDown).v} ${fmtBytes(activeDown).u}/s</span>
        <span class="sb-dot"></span>
        <span>累计 ↑ ${fmtBytes(totalUp).v} ${fmtBytes(totalUp).u}</span>
        <span class="sb-dot"></span>
        <span>↓ ${fmtBytes(totalDown).v} ${fmtBytes(totalDown).u}</span>
      </div>
      <div class="lb-right">
        <span class="sub">${filtered.length > 300 ? `显示前 300 / 共 ${filtered.length}` : `共 ${filtered.length} 条`}</span>
        <span>每 1 秒刷新</span>
      </div>
    </div>

    <div class="card rule-card">
      <div class="rw-head">
        <span class="rw-title">连接</span><span class="rw-count">${shown.length} 条</span>
        <span class="grow"></span>
        <span class="sub">来自内核 /connections</span>
      </div>
      ${shown.length ? html`<div class="conn-head">
        <span class="h-ic"></span>
        <span class="grow">连接目标</span>
        <span class="h-policy">分流策略</span>
        <span class="h-traffic">上传流量</span>
        <span class="h-traffic">下载流量</span>
        <span class="h-total">上传总流量</span>
        <span class="h-total">下载总流量</span>
        <span class="h-x"></span>
      </div>` : null}
      ${!shown.length
        ? html`<${Empty} icon="activity" title="暂无活跃连接" sub=${S.core.running ? '内核已运行，但没有正在转发的连接。' : '启动内核后这里会显示实时连接。'} />`
        : html`<div class="rule-list">
            ${shown.map((c) => html`<button key=${c.id} class="conn-row" onClick=${() => setDetail(c)} style="background:none;text-align:left">
              <span class="ichi tint-grey" style="width:26px;height:26px"><${Icon} name="globe" cls="ico-14" /></span>
              <span class="grow" style="min-width:0">
                <span class="conn-host" style="display:block">${hostOf(c)}</span>
                <span class="conn-meta" style="display:block">${(c.metadata || {}).type || ''} · ${(c.metadata || {}).network || ''} · ${c.rule || ''} ${c.rulePayload || ''}</span>
              </span>
              <span class="conn-policy" title=${policyOf(c)}>${policyOf(c)}</span>
              <span class="conn-traffic">↑ ${fmtBytes((rates[c.id] || {}).up || 0).v}${fmtBytes((rates[c.id] || {}).up || 0).u}/s</span>
              <span class="conn-traffic">↓ ${fmtBytes((rates[c.id] || {}).down || 0).v}${fmtBytes((rates[c.id] || {}).down || 0).u}/s</span>
              <span class="conn-total" title="该连接累计上传">↑ ${fmtBytes(c.upload || 0).v}${fmtBytes(c.upload || 0).u}</span>
              <span class="conn-total" title="该连接累计下载">↓ ${fmtBytes(c.download || 0).v}${fmtBytes(c.download || 0).u}</span>
              <span class="btn ghost sm" title="结束连接" onClick=${async (e) => { e.stopPropagation(); await client.closeConnection(c.id); toast('连接已结束', 'ok'); }}>
                <${Icon} name="x" />
              </span>
            </button>`)}
          </div>`}
    </div>

    ${detail ? html`<${Detail} conn=${detail} onClose=${() => setDetail(null)} />` : null}
  </div>`;
}
