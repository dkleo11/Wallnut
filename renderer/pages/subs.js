/* 订阅与本地节点（对应 QX 的 [server_remote] / [server_local]） */

import { html, Icon, Button, Switch, Seg, PageHead, Tag, Lat, Empty, Spinner, Modal, Field, Input, Textarea, fmtDuration, timeAgo, useStore, useState } from '../ui.js';
import { S, call, toast, delayMap } from '../store.js';

function maskUrl(url = '') {
  try {
    const u = new URL(url);
    return u.host + (u.pathname && u.pathname !== '/' ? u.pathname.slice(0, 28) : '') + (u.search ? '?…' : '');
  } catch (_) {
    return url.length > 60 ? url.slice(0, 60) + '…' : url;
  }
}

function SubRow({ sub, onEdit }) {
  const [busy, setBusy] = useState(false);
  const update = async () => {
    setBusy(true);
    const r = await call('sub:update', { id: sub.id }, { silent: false });
    setBusy(false);
    if (r && r.ok) toast(`「${sub.name}」更新完成：${r.nodeCount} 个节点`, 'ok');
  };
  return html`<div class="card sub-card">
    <div class="sub-head">
      <span class="sub-ico" style="background:rgba(94,92,230,.12);color:var(--indigo)"><${Icon} name="download" /></span>
      <div class="grow">
        <div class="sub-name">${sub.name}</div>
        <div class="sub-url mono">${sub.url && sub.url.startsWith('inline:') ? '本地导入内容（' + (sub.format || 'inline') + '）' : maskUrl(sub.url)}</div>
      </div>
      <div class="sub-acts">
        <button class="btn sm" disabled=${busy} onClick=${update}>${busy ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`}更新</button>
        <${Switch} on=${sub.enabled !== false} onChange=${(v) => call('sub:toggle', { id: sub.id, enabled: v })} />
        <button class="btn ghost sm" title="编辑订阅" onClick=${() => onEdit && onEdit(sub)}><${Icon} name="edit" /></button>
        <button class="btn ghost sm danger" title="删除订阅" onClick=${async () => {
          if (!confirm(`删除订阅「${sub.name}」？其节点会从所有策略组移除。`)) return;
          await call('sub:remove', { id: sub.id });
          toast('已删除订阅', 'ok');
        }}><${Icon} name="trash" /></button>
      </div>
    </div>
    <div class="sub-stats">
      <span><${Tag} cls="type">${(sub.format || 'auto').toUpperCase()}</${Tag}></span>
      <span><b style="color:var(--text)">${sub.nodeCount || 0}</b> 个节点</span>
      <span>更新于 ${timeAgo(sub.updatedAt)}</span>
      <span>间隔 ${sub.interval ? fmtDuration(sub.interval * 60000) : '手动'}</span>
      ${sub.insecure ? html`<${Tag} cls="warn">跳过证书校验</${Tag}>` : null}
      ${sub.enabled === false ? html`<${Tag} cls="grey">已禁用</${Tag}>` : null}
      ${sub.remoteInfo && (sub.remoteInfo.proxyProviders || sub.remoteInfo.ruleProviders)
        ? html`<span class="sub">源文件含 provider 配置，已转换为本地节点</span>` : null}
    </div>
    ${sub.lastError ? html`<div class="cc-warn" style="margin:0"><${Icon} name="alert" /><span>${sub.lastError}</span></div>` : null}
  </div>`;
}

function AddSubModal({ onClose }) {
  const [mode, setMode] = useState('url');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [insecure, setInsecure] = useState(false);

  const pickFile = async () => {
    const r = await call('app:pickFile', { kind: 'sub' }, { silent: true });
    if (!r || !r.ok) return;
    setName(name || r.path.split('\\').pop().replace(/\.(yaml|yml|conf|txt)$/i, ''));
    setText(r.text);
    setMode('text');
    toast('已读取文件，点「导入」写入', 'ok');
  };

  const doPreview = async () => {
    if (!url.trim()) return;
    setBusy(true);
    const r = await call('sub:preview', { url: url.trim(), insecure });
    setBusy(false);
    if (r && r.ok) {
      setPreview(r);
      if (!name) setName('订阅 ' + new Date().toLocaleDateString());
      toast(`可解析：${r.nodeCount} 个节点（${r.format}）`, 'ok');
    }
  };

  const submit = async () => {
    setBusy(true);
    let r;
    if (mode === 'url') {
      if (!url.trim()) { setBusy(false); return toast('请填写订阅链接', 'error'); }
      r = await call('sub:add', { name: name || '订阅', url: url.trim(), insecure });
    } else {
      if (!text.trim()) { setBusy(false); return toast('请粘贴订阅内容', 'error'); }
      r = await call('sub:importText', { name: name || '导入配置', text });
    }
    setBusy(false);
    if (r && r.ok) {
      toast(`已导入「${name || '订阅'}」：${r.nodeCount} 个节点`, 'ok');
      onClose();
    }
  };

  return html`<${Modal} title="添加订阅" onClose=${onClose} width="680px"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button>
      <button class="btn primary" disabled=${busy} onClick=${submit}>${busy ? '导入中…' : '导入'}</button>`}>
    <div class="row" style="gap:10px">
      <${Seg} value=${mode} options=${[{ v: 'url', label: '订阅链接' }, { v: 'text', label: '粘贴内容' }]} onChange=${setMode} />
      <span class="grow"></span>
      <button class="btn sm" onClick=${pickFile}><${Icon} name="folder" />从文件导入</button>
    </div>
    <${Field} label="名称"><${Input} value=${name} placeholder="例如：机场 A" onInput=${(e) => setName(e.target.value)} /></${Field}>
    ${mode === 'url'
      ? html`<${Field} label="订阅地址（http/https，支持 Clash、QX、Surge、分享链接、base64）">
          <${Input} value=${url} placeholder="https://example.com/api/v1/client/subscribe?token=…" onInput=${(e) => setUrl(e.target.value)} />
        </${Field}>
        <div class="set-row inline-row">
          <div class="sl"><span>跳过证书校验</span><span class="note-grey">仅自签名证书的订阅源需要；开启后链接可能被中间人替换</span></div>
          <${Switch} on=${insecure} onChange=${setInsecure} />
        </div>
        <div class="row">
          <button class="btn sm" disabled=${busy || !url.trim()} onClick=${doPreview}>先解析试试</button>
          ${preview ? html`<span class="sub">${preview.format} · ${preview.nodeCount} 个节点</span>` : null}
        </div>
        ${preview && preview.sample && preview.sample.length
          ? html`<div class="sub mono" style="line-height:1.7">示例：${preview.sample.join(' · ')}</div>` : null}`
      : html`<${Field} label="配置内容（可直接粘贴 QX conf / Clash YAML / 节点分享链接 / base64）">
          <textarea class="textarea" style="min-height:180px" value=${text} placeholder="ss://… 或 [server_local] 段…" onInput=${(e) => setText(e.target.value)}></textarea>
        </${Field}>`}
    <span class="sub">导入后自动重建配置；更新间隔在设置页调整。</span>
  </${Modal}>`;
}

function SubEditModal({ sub, onClose }) {
  const inline = String(sub.url || '').startsWith('inline:');
  const [name, setName] = useState(sub.name || '');
  const [url, setUrl] = useState(inline ? '' : (sub.url || ''));
  const [interval, setInterval] = useState(String(sub.interval == null ? 1440 : sub.interval));
  const [insecure, setInsecure] = useState(sub.insecure === true);
  const [enabled, setEnabled] = useState(sub.enabled !== false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');

  const save = async () => {
    if (!name.trim()) return toast('请填写订阅名称', 'error');
    if (!inline && !/^https?:\/\//i.test(url.trim())) return toast('订阅地址需要是 http(s) 链接', 'error');
    const mins = Number(interval);
    if (!Number.isFinite(mins) || mins < 0 || mins > 10080) return toast('更新间隔需要是 0-10080 分钟', 'error');
    setBusy(true);
    setPhase('正在保存…');
    const payload = { id: sub.id, name: name.trim(), interval: mins, insecure, enabled };
    if (!inline) payload.url = url.trim();
    const r = await call('sub:save', payload);
    setBusy(false);
    setPhase('');
    if (!r || !r.ok) return toast((r && r.error) || '保存失败', 'error', 5000);
    if (r.urlChanged) toast(`订阅已保存，已重新拉取 ${r.nodeCount || 0} 个节点`, 'ok', 4200);
    else toast('订阅已保存', 'ok');
    onClose();
  };

  return html`<${Modal} title="编辑订阅" onClose=${onClose} width="640px"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button>
      <button class="btn primary" disabled=${busy} onClick=${save}>${busy ? (phase || '保存中…') : '保存'}</button>`}>
    <div class="form-grid">
      <${Field} label="名称" style="grid-column:1 / -1"><${Input} value=${name} placeholder="例如：机场 A" onInput=${(e) => setName(e.target.value)} /></${Field}>
      <${Field} label=${inline ? '订阅地址' : '订阅地址（http/https）'} style="grid-column:1 / -1">
        ${inline
          ? html`<${Input} value="本地导入内容，地址不可修改" disabled=${true} />`
          : html`<${Input} cls="mono" value=${url} placeholder="https://example.com/api/v1/client/subscribe?token=…" onInput=${(e) => setUrl(e.target.value)} />`}
      </${Field}>
      <${Field} label="自动更新间隔（分钟，0 为仅手动）"><${Input} value=${interval} placeholder="1440" onInput=${(e) => setInterval(e.target.value)} /></${Field}>
      <${Field} label="启用"><${Switch} on=${enabled} sm=${false} onChange=${setEnabled} /></${Field}>
    </div>
    <div class="set-row" style="padding-left:0;padding-right:0">
      <div class="sl"><span>跳过证书校验</span><span class="note-grey">仅自签名证书的订阅源需要；开启后链接可能被中间人替换</span></div>
      <${Switch} on=${insecure} onChange=${setInsecure} />
    </div>
    <span class="sub">${inline ? '这是粘贴导入的订阅，只能改名称与更新策略。' : '修改订阅地址后会自动重新下载并重建节点与策略组；只改名称或间隔不会重新拉取。'}</span>
  </${Modal}>`;
}

function LocalNodeModal({ initial, onClose }) {
  const node = initial || {};
  const [name, setName] = useState(node.name || '');
  const [type, setType] = useState(node.type || 'ss');
  const [server, setServer] = useState(node.server || '');
  const [port, setPort] = useState(String(node.port || ''));
  const [password, setPassword] = useState(node.password || '');
  const [uuid, setUuid] = useState(node.uuid || '');
  const [cipher, setCipher] = useState(node.cipher || 'aes-128-gcm');
  const [sni, setSni] = useState(node.sni || node.servername || '');
  const [enabled, setEnabled] = useState(node.enabled !== false);

  const save = async () => {
    if (!server.trim() || !port) return toast('服务器与端口必填', 'error');
    const rec = {
      ...node, id: node.id, name: name.trim() || `${server}:${port}`, type, server: server.trim(),
      port: Number(port), enabled, udp: true
    };
    if (['ss'].includes(type)) { rec.cipher = cipher; rec.password = password; }
    if (['vmess', 'vless'].includes(type)) { rec.uuid = uuid; rec.alterId = 0; rec.cipher = 'auto'; }
    if (type === 'trojan' || type === 'hysteria2') { rec.password = password; if (sni) rec.sni = sni; }
    if (type === 'tuic') { rec.uuid = uuid; rec.password = password; if (sni) rec.sni = sni; }
    if (type === 'http' || type === 'socks5') { rec.username = uuid; rec.password = password; }
    const r = await call('local:save', { node: rec });
    if (r && r.ok) { toast('已保存本地节点', 'ok'); onClose(); }
  };

  const types = ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'http', 'socks5'];

  return html`<${Modal} title=${node.id ? '编辑本地节点' : '添加本地节点'} onClose=${onClose} width="600px"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" onClick=${save}>保存并生效</button>`}>
    <div class="form-grid">
      <${Field} label="名称"><${Input} value=${name} placeholder="香港 01 · 家宽" onInput=${(e) => setName(e.target.value)} /></${Field}>
      <${Field} label="协议">
        <select class="select" style="width:100%;height:32px" value=${type} onChange=${(e) => setType(e.target.value)}>
          ${types.map((t) => html`<option key=${t} value=${t}>${t.toUpperCase()}</option>`)}
        </select>
      </${Field}>
      <${Field} label="服务器"><${Input} value=${server} placeholder="1.2.3.4 / 域名" onInput=${(e) => setServer(e.target.value)} /></${Field}>
      <${Field} label="端口"><${Input} value=${port} placeholder="443" onInput=${(e) => setPort(e.target.value)} /></${Field}>
    </div>
    ${['ss'].includes(type)
      ? html`<div class="form-grid">
          <${Field} label="加密方式"><${Input} value=${cipher} onInput=${(e) => setCipher(e.target.value)} /></${Field}>
          <${Field} label="密码"><${Input} value=${password} onInput=${(e) => setPassword(e.target.value)} /></${Field}>
        </div>` : null}
    ${['vmess', 'vless', 'tuic'].includes(type)
      ? html`<div class="form-grid">
          <${Field} label=${type === 'tuic' ? 'UUID' : 'UUID'}><${Input} value=${uuid} onInput=${(e) => setUuid(e.target.value)} /></${Field}>
          <${Field} label="密码${type === 'tuic' ? '' : '（可选）'}"><${Input} value=${password} onInput=${(e) => setPassword(e.target.value)} /></${Field}>
        </div>` : null}
    ${['trojan', 'hysteria2'].includes(type) || type === 'tuic'
      ? html`<div class="form-grid">
          <${Field} label="密码 / 认证"><${Input} value=${password} onInput=${(e) => setPassword(e.target.value)} /></${Field}>
          <${Field} label="SNI（可选）"><${Input} value=${sni} onInput=${(e) => setSni(e.target.value)} /></${Field}>
        </div>` : null}
    ${['http', 'socks5'].includes(type)
      ? html`<div class="form-grid">
          <${Field} label="用户名"><${Input} value=${uuid} onInput=${(e) => setUuid(e.target.value)} /></${Field}>
          <${Field} label="密码"><${Input} value=${password} onInput=${(e) => setPassword(e.target.value)} /></${Field}>
        </div>` : null}
    <div class="set-row" style="padding-left:0;padding-right:0">
      <div class="sl"><span>启用</span><span class="note-grey">关闭后节点保留但不参与配置</span></div>
      <${Switch} on=${enabled} onChange=${setEnabled} />
    </div>
    <span class="sub">支持常见协议；ws / reality 等复杂参数请用粘贴导入。</span>
  </${Modal}>`;
}

function PasteModal({ onClose }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);

  const parse = async () => {
    if (!text.trim()) return toast('请先粘贴内容', 'error');
    setBusy(true);
    const r = await call('local:importText', { text });
    setBusy(false);
    setParsed(r);
    if (r && r.ok) toast(`解析出 ${r.nodes.length} 个节点`, 'ok');
  };

  const commit = async () => {
    if (!parsed || !parsed.nodes) return;
    setBusy(true);
    for (const n of parsed.nodes) await call('local:save', { node: { ...n.raw, id: n.id, enabled: true } }, { silent: true });
    setBusy(false);
    toast(`已添加 ${parsed.nodes.length} 个本地节点`, 'ok');
    onClose();
  };

  return html`<${Modal} title="粘贴导入本地节点" onClose=${onClose} width="720px"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button>
      <button class="btn" disabled=${busy || !text.trim()} onClick=${parse}>解析</button>
      <button class="btn primary" disabled=${busy || !parsed || !parsed.ok} onClick=${commit}>添加 ${parsed && parsed.ok ? parsed.nodes.length : ''} 个节点</button>`}>
    <span class="sub">一行一个，可混合写法：</span>
    <div class="card mono" style="padding:10px 12px;background:var(--fill-2);font-size:11px;line-height:1.8">
      <div class="mono">ss, 名称, 服务器, 端口, 加密方式, 密码, udp-relay=true</div>
      <div class="mono">vmess, 名称, 服务器, 端口, auto, UUID, udp-relay=true</div>
      <div class="mono">trojan, 名称, 服务器, 端口, 密码, tls-host=example.com</div>
      <div class="mono">ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@1.2.3.4:8388#名称</div>
      <div class="mono">vmess://base64 / vless://… / trojan://… / hysteria2://… / tuic://…</div>
    </div>
    <textarea class="textarea" style="min-height:200px" value=${text} onInput=${(e) => setText(e.target.value)}
      placeholder="ss, 香港 01, 1.2.3.4, 8388, aes-128-gcm, password, udp-relay=true"></textarea>
    ${parsed
      ? html`<div class="row"><span class="sub">${parsed.format} · ${parsed.nodes ? parsed.nodes.length : 0} 个节点</span>
          ${parsed.warnings && parsed.warnings.length ? html`<span class="sub c-orange">${parsed.warnings.join('；')}</span>` : null}</div>
        ${parsed.nodes && parsed.nodes.length
          ? html`<div class="node-list card" style="box-shadow:none">
              ${parsed.nodes.slice(0, 8).map((n) => html`<div class="node-row" key=${n.id}>
                <span class="node-name">${n.name}</span>
                <span class="node-tags"><${Tag}>${(n.type || '').toUpperCase()}</${Tag}></span>
                <span class="sub mono">${n.server}:${n.port}</span>
              </div>`)}
            </div>` : null}`
      : null}
  </${Modal}>`;
}

export function SubsPanel() {
  const s = useStore();
  const [tab, setTab] = useState('subs');
  const [adding, setAdding] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [subEditing, setSubEditing] = useState(null);
  const [busyAll, setBusyAll] = useState(false);
  const dmap = delayMap();

  const updateAll = async () => {
    setBusyAll(true);
    const r = await call('sub:updateAll');
    setBusyAll(false);
    if (r && r.ok) toast(`已更新 ${r.results.filter((x) => x.ok).length}/${r.results.length} 个订阅`, 'ok');
  };

  return html`<div class="subs-block" style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <div class="toolbar" style="gap:10px">
      <${Seg} value=${tab} options=${[{ v: 'subs', label: '订阅' }, { v: 'local', label: '本地节点' }]} onChange=${setTab} />
      <span class="grow"></span>
      <button class="btn sm ghost" onClick=${() => call('app:openDataDir')}><${Icon} name="folder" />数据目录</button>
      <button class="btn sm" disabled=${busyAll} onClick=${updateAll}>${busyAll ? html`<${Spinner} />` : html`<${Icon} name="refresh" />`}全部更新</button>
      ${tab === 'local'
        ? html`<button class="btn sm" onClick=${() => setPasting(true)}><${Icon} name="plus" />粘贴导入</button>
            <button class="btn sm" onClick=${() => setEditing({})}><${Icon} name="edit" />手动添加</button>`
        : html`<button class="btn sm primary" onClick=${() => setAdding(true)}><${Icon} name="plus" />添加订阅</button>`}
    </div>

    ${tab === 'subs'
      ? (S.state.subscriptions.length
          ? html`<div class="sub-grid">
              ${S.state.subscriptions.map((sub) => html`<${SubRow} key=${sub.id} sub=${sub} onEdit=${setSubEditing} />`)}
            </div>`
          : html`<${Empty} icon="download" title="还没有订阅" sub="支持 Clash / mihomo YAML、QX conf、Surge conf、节点分享链接和 base64。导入后节点会自动按国家聚合到地区组。">
              <div class="row">
                <button class="btn primary" onClick=${() => setAdding(true)}><${Icon} name="plus" />添加订阅</button>
                <button class="btn" onClick=${() => setPasting(true)}>粘贴节点</button>
              </div>
            </${Empty}>`)
      : (S.state.localNodes.length
          ? html`<div class="card" style="overflow:hidden">
              <div class="rw-head"><span class="rw-title">本地节点</span>
                <span class="rw-count">${S.state.localNodes.length} 个 · 手动添加或从配置导入</span>
                <span class="grow"></span>
                <button class="btn sm" onClick=${() => setPasting(true)}><${Icon} name="plus" />粘贴导入</button>
              </div>
              <div class="node-list">
                ${S.state.localNodes.map((n) => html`<div class="node-row" key=${n.id}>
                  <span class="flag-em">${(S.regions.find((r) => r.nodes && r.nodes.includes(n.name)) || {}).flag || '🌐'}</span>
                  <span class="node-name">${n.name}</span>
                  <span class="node-tags"><${Tag}>${(n.type || '').toUpperCase()}</${Tag}>${n.udp ? html`<${Tag} cls="udp">UDP</${Tag}>` : null}</span>
                  <span class="sub mono">${n.server}:${n.port}</span>
                  <${Lat} ms=${dmap[n.name]} />
                  <${Switch} on=${n.enabled !== false} onChange=${(v) => call('local:save', { node: { ...n, enabled: v } })} />
                  <button class="btn ghost sm" onClick=${() => setEditing(n)}><${Icon} name="edit" /></button>
                  <button class="btn ghost sm danger" onClick=${async () => {
                    if (!confirm(`删除本地节点「${n.name}」？`)) return;
                    await call('local:remove', { id: n.id }); toast('已删除', 'ok');
                  }}><${Icon} name="trash" /></button>
                </div>`)}
              </div>
            </div>`
          : html`<${Empty} icon="server" title="还没有本地节点" sub="本地节点直接写进配置的 proxies，不依赖订阅；适合自建服务器、临时落地或测试。">
              <div class="row">
                <button class="btn primary" onClick=${() => setPasting(true)}><${Icon} name="plus" />粘贴导入</button>
                <button class="btn" onClick=${() => setEditing({})}>手动添加</button>
              </div>
            </${Empty}>`)}
    ${adding ? html`<${AddSubModal} onClose=${() => setAdding(false)} />` : null}
    ${pasting ? html`<${PasteModal} onClose=${() => setPasting(false)} />` : null}
    ${editing ? html`<${LocalNodeModal} initial=${editing} onClose=${() => setEditing(null)} />` : null}
    ${subEditing ? html`<${SubEditModal} sub=${subEditing} onClose=${() => setSubEditing(null)} />` : null}
  </div>`;
}

/* 兼容包装：单独渲染时自带 PageHead（导航已并入「节点」页，此处保留默认导出） */
export default function Subs() {
  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <${PageHead} title="订阅与本地节点" sub=${`${(S.state && S.state.subscriptions || []).length} 个订阅 · ${(S.state && S.state.localNodes || []).length} 个本地节点 · 共 ${S.nodes.length} 个可用节点`} />
    <${SubsPanel} />
  </div>`;
}
