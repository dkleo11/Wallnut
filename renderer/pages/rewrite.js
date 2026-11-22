/* 重写：本地 HTTP 重写代理 + 可选 MITM（只对白名单域名终止 TLS） */

import { html, Icon, PageHead, Tag, Switch, Empty, Modal, Input, useStore, useState, useEffect } from '../ui.js';
import { S, call, toast, saveSettings, set, setPage } from '../store.js';

const TYPES = [
  { v: 'reject', label: '拒绝请求', hint: '返回 403 或 204' },
  { v: 'redirect', label: '302 重定向', hint: 'action 填目标 URL' },
  { v: 'rewrite', label: 'URL 重写', hint: 'action 正则替换，replacement 填替换文本' },
  { v: 'request-header', label: '请求头', hint: '修改发往服务器的请求头' },
  { v: 'response-header', label: '响应头', hint: '修改返回客户端的响应头' },
  { v: 'response-body', label: '响应体', hint: '仅文本 / JSON / HTML / JS，支持压缩响应' }
];

const typeName = (v) => (TYPES.find((t) => t.v === v) || {}).label || v;

function ruleAction(r) {
  if (r.type === 'reject') return r.action === '204' ? '返回 204' : '返回 403';
  if (r.type === 'redirect') return `302 → ${r.action || ''}`;
  if (r.type === 'rewrite') return `${r.action || ''} → ${r.replacement || ''}`;
  if (r.type === 'request-header' || r.type === 'response-header') return `${r.action === 'remove' ? '删除' : '设置'} ${r.header || ''}${r.action === 'remove' ? '' : ': ' + (r.value || '')}`;
  if (r.type === 'response-body') return `${r.action || ''} → ${r.replacement || ''}`;
  return '';
}

function RuleModal({ initial, onClose }) {
  const editing = !!initial;
  const [type, setType] = useState(initial?.type || 'reject');
  const [pattern, setPattern] = useState(initial?.pattern || '');
  const [action, setAction] = useState(initial?.action || (initial?.type === 'reject' ? '403' : ''));
  const [header, setHeader] = useState(initial?.header || '');
  const [value, setValue] = useState(initial?.value || '');
  const [replacement, setReplacement] = useState(initial?.replacement || '');
  const [note, setNote] = useState(initial?.note || '');
  const [busy, setBusy] = useState(false);
  const isHeader = type === 'request-header' || type === 'response-header';
  const hint = (TYPES.find((t) => t.v === type) || {}).hint;

  const save = async () => {
    if (!pattern.trim()) return toast('请填写匹配 URL 的正则表达式', 'error');
    try { new RegExp(pattern); } catch (e) { return toast('正则无效：' + e.message, 'error'); }
    if (isHeader && !header.trim()) return toast('请填写 Header 名称', 'error');
    setBusy(true);
    const rule = {
      ...(initial || {}), type, pattern: pattern.trim(), action, header: header.trim(), value, replacement, note: note.trim(),
      enabled: initial ? initial.enabled !== false : true
    };
    const r = await call('rewrite:save', { rule });
    setBusy(false);
    if (r && r.ok) { toast(editing ? '规则已保存' : '规则已添加', 'ok'); onClose(); }
  };

  return html`<${Modal} title=${editing ? '编辑重写规则' : '添加重写规则'} onClose=${onClose} width="560px"
    foot=${html`<button class="btn ghost" onClick=${onClose}>取消</button><button class="btn primary" disabled=${busy} onClick=${save}>保存</button>`}>
    <div class="form-grid">
      <label class="field"><span>规则类型</span><select class="input" value=${type} onChange=${(e) => setType(e.target.value)}>${TYPES.map((t) => html`<option value=${t.v}>${t.label}</option>`)}</select></label>
      <label class="field field-wide"><span>URL 正则</span><${Input} value=${pattern} onInput=${(e) => setPattern(e.target.value)} placeholder="^https?://example\\.com/ad/.*$" /><small>${hint}</small></label>
      ${type === 'reject' ? html`<label class="field"><span>拒绝方式</span><select class="input" value=${action} onChange=${(e) => setAction(e.target.value)}><option value="403">403 Forbidden</option><option value="204">204 No Content</option></select></label>` : null}
      ${type === 'redirect' ? html`<label class="field field-wide"><span>目标 URL</span><${Input} value=${action} onInput=${(e) => setAction(e.target.value)} placeholder="https://example.com/" /></label>` : null}
      ${type === 'rewrite' || type === 'response-body' ? html`<label class="field"><span>匹配正则</span><${Input} value=${action} onInput=${(e) => setAction(e.target.value)} placeholder="要替换的内容" /></label><label class="field"><span>替换为</span><${Input} value=${replacement} onInput=${(e) => setReplacement(e.target.value)} /></label>` : null}
      ${isHeader ? html`<label class="field"><span>Header 名称</span><${Input} value=${header} onInput=${(e) => setHeader(e.target.value)} placeholder="User-Agent" /></label><label class="field"><span>操作</span><select class="input" value=${action || 'set'} onChange=${(e) => setAction(e.target.value)}><option value="set">新增 / 修改</option><option value="remove">删除</option></select></label>${action !== 'remove' ? html`<label class="field field-wide"><span>Header 值</span><${Input} value=${value} onInput=${(e) => setValue(e.target.value)} /></label>` : null}` : null}
      <label class="field field-wide"><span>备注（可选）</span><${Input} value=${note} onInput=${(e) => setNote(e.target.value)} /></label>
    </div>
  </${Modal}>`;
}

function HostsModal({ onClose }) {
  const [text, setText] = useState((S.state.mitmHosts || []).join('\n'));
  const save = async () => {
    const hosts = [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
    const r = await call('mitm:saveHosts', { hosts });
    if (r && r.ok) { toast(`已保存 ${hosts.length} 个解密主机`, 'ok'); onClose(); }
  };
  return html`<${Modal} title="解密主机白名单" onClose=${onClose} width="520px"
    foot=${html`<button class="btn ghost" onClick=${onClose}>取消</button><button class="btn primary" onClick=${save}>保存</button>`}>
    <p class="sub">每行一个，支持 <span class="mono">example.com</span> 与 <span class="mono">*.example.com</span>；不在列表内的 HTTPS 请求始终原样透传。</p>
    <textarea class="input textarea" rows="8" value=${text} onInput=${(e) => setText(e.target.value)} placeholder="*.example.com\napi.example.com"></textarea>
  </${Modal}>`;
}

export default function Rewrite() {
  useStore();
  const [modal, setModal] = useState(null);
  const st = S.state.settings;
  const rw = S.rewrite || {};
  const ca = S.ca || {};
  const rules = S.state.rewrites || [];
  const hosts = S.state.mitmHosts || [];
  const enabled = st.rewriteEnabled === true;
  const mitm = st.mitmEnabled === true;
  const active = rules.filter((r) => r.enabled !== false).length;
  const refresh = async () => {
    const r = await call('rewrite:status');
    if (r && r.ok) set({ rewrite: r.engine || S.rewrite, ca: r.ca || S.ca });
  };
  useEffect(() => { refresh(); }, []);

  const toggle = async (v) => {
    if (v && st.tunEnabled) toast('TUN 不经过本地 HTTP 重写代理，请使用系统代理模式', 'info', 5000);
    await saveSettings({ rewriteEnabled: v });
    await refresh();
  };
  const toggleMitm = async (v) => {
    if (v && !ca.installed) return toast('请先在「证书」页生成并安装 Wallnut Root CA', 'error');
    await saveSettings({ mitmEnabled: v });
    await refresh();
  };
  const remove = async (r) => {
    if (!confirm(`删除这条重写规则？\n${r.pattern}`)) return;
    await call('rewrite:remove', { id: r.id });
  };
  const mb = ((rw.bytes || 0) / 1048576).toFixed(1);

  return html`<div class="page">
    <${PageHead} title="重写" sub=${`${active}/${rules.length} 条启用 · ${hosts.length} 个解密主机`}>
      <button class="btn sm ghost" onClick=${refresh}><${Icon} name="refresh" />刷新</button>
      <button class="btn sm primary" onClick=${() => setModal({ type: 'rule' })}><${Icon} name="plus" />添加规则</button>
    </${PageHead}>

    <div class=${'card master-card' + (enabled ? ' on' : '')}>
      <span class=${'ichi ' + (enabled ? 'tint-blue' : 'tint-grey')}><${Icon} name="rewrite" /></span>
      <div class="mc-text">
        <span class="mc-title">重写代理</span>
        <span class="sub">${rw.running ? `运行中 · 127.0.0.1:${rw.port}` : '已关闭 · 开启后接管系统代理端口，关闭后交还 mihomo'}</span>
      </div>
      ${rw.running ? html`<div class="mc-stats">
        <span><b>${rw.hits || 0}</b> 次命中</span>
        <span><b>${mb}</b> MB 处理</span>
      </div>` : null}
      <${Switch} on=${enabled} sm=${false} onChange=${toggle} title="开关重写代理" />
    </div>

    <div class="rw-grid">
      <div class="card rule-card rw-card">
        <div class="rw-head"><span class="rw-title">重写规则</span><span class="rw-count">${rules.length} 条</span></div>
        <div class="rule-list">
          ${rules.length ? rules.map((r) => html`<div class=${'rule-row' + (r.enabled === false ? ' disabled' : '')} key=${r.id}>
            <span class="rule-tag"><${Tag}>${typeName(r.type)}</${Tag}></span>
            <span class="rule-main" title=${r.pattern}><span class="rule-match mono">${r.pattern}</span><span class="rule-act"><${Icon} name="arrow-r" /><b>${ruleAction(r)}</b>${r.note ? html`<span class="sub">· ${r.note}</span>` : null}</span></span>
            <button class="btn ghost sm" title="编辑" onClick=${() => setModal({ type: 'rule', rule: r })}><${Icon} name="edit" /></button>
            <button class="btn ghost sm danger" title="删除" onClick=${() => remove(r)}><${Icon} name="trash" /></button>
            <${Switch} on=${r.enabled !== false} onChange=${(v) => call('rewrite:save', { rule: { ...r, enabled: v } })} />
          </div>`) : html`<${Empty} icon="rewrite" title="还没有重写规则" sub="支持 URL 重写、302、请求/响应头与文本响应体替换。">
            <button class="btn primary" onClick=${() => setModal({ type: 'rule' })}><${Icon} name="plus" />添加规则</button>
          </${Empty}>`}
        </div>
        <div class="rw-note"><${Icon} name="info" /><span>仅在系统代理指向 Wallnut 时生效；TUN 模式下不经过重写。</span></div>
      </div>

      <div class="mitm-col">
        <div class="card side-card">
          <div class="side-head">
            <div class="mc-text"><span class="side-title">HTTPS 解密（MITM）</span><span class="sub">只解密白名单内的主机</span></div>
            <${Switch} on=${mitm} onChange=${toggleMitm} />
          </div>
          <button class="side-row" onClick=${() => setPage('cert')}>
            <${Icon} name="shield" cls="ico-16 c-sub" />
            <span class="grow">根证书</span>
            <${Tag} cls=${ca.installed ? 'ok' : ca.exists ? 'warn' : 'grey'}>${ca.installed ? '已安装' : ca.exists ? '未安装' : '未生成'}</${Tag}>
            <${Icon} name="chev-r" cls="ico-12 c-sub" />
          </button>
          <div class="side-sec">
            <div class="side-sec-head"><span>解密主机</span><span class="sub">${hosts.length} 个</span>
              <button class="btn ghost sm" onClick=${() => setModal({ type: 'hosts' })}><${Icon} name="edit" />编辑</button></div>
            ${hosts.length
              ? html`<div class="host-tags">${hosts.map((h) => html`<${Tag} key=${h} cls="grey">${h}</${Tag}>`)}</div>`
              : html`<span class="sub side-empty">白名单为空，HTTPS 全部原样透传。</span>`}
          </div>
          ${mitm && !hosts.length ? html`<div class="cc-warn"><${Icon} name="alert" /><span>MITM 已开启但白名单为空，不会解密任何请求。</span></div>` : null}
        </div>
      </div>
    </div>

    ${modal?.type === 'rule' ? html`<${RuleModal} initial=${modal.rule} onClose=${() => setModal(null)} />` : null}
    ${modal?.type === 'hosts' ? html`<${HostsModal} onClose=${() => setModal(null)} />` : null}
  </div>`;
}

export { HostsModal };
