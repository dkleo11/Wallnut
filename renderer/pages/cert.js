/* 证书页：Wallnut Root CA 与 MITM 白名单的真实状态和管理 */

import { html, Icon, PageHead, Tag, Empty, useStore, useState, useEffect } from '../ui.js';
import { S, call, toast, set } from '../store.js';
import { HostsModal } from './rewrite.js';

export default function Cert() {
  useStore();
  const [editing, setEditing] = useState(false);
  const ca = S.ca || {};
  const rw = S.rewrite || {};
  const hosts = S.state.mitmHosts || [];
  const refresh = async () => {
    const r = await call('rewrite:status');
    if (r && r.ok) set({ rewrite: r.engine || S.rewrite, ca: r.ca || S.ca });
  };
  useEffect(() => { refresh(); }, []);
  const action = async (channel) => {
    const r = await call(channel);
    if (r && r.ok) { toast(channel.includes('Uninstall') ? '根证书已吊销' : '操作成功', 'ok'); await refresh(); }
  };

  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <${PageHead} title="证书" sub="Wallnut Root CA · 仅当前用户 · 可随时吊销">
      <${Tag} cls=${ca.installed ? 'ok' : ca.exists ? 'warn' : 'grey'}>${ca.installed ? '已安装并信任' : ca.exists ? '已生成，未安装' : '未生成'}</${Tag}>
    </${PageHead}>

    <div class="set-grid">
      <div class="set-col">
        <div class="set-group"><div class="set-label">根证书</div><div class="set-card">
          <div class="about-row"><span>CA 名称</span><span class="about-val">Wallnut Root CA</span></div>
          <div class="about-row"><span>算法</span><span class="about-val">RSA 2048 · SHA-256</span></div>
          <div class="about-row"><span>SHA-256 指纹</span><span class="about-val mono" style="max-width:62%;overflow-wrap:anywhere">${ca.sha256 || '—'}</span></div>
          <div class="about-row"><span>安装状态</span><span class="about-val"><${Tag} cls=${ca.installed ? 'ok' : 'grey'}>${ca.installed ? '已安装' : '未安装'}</${Tag}></span></div>
          <div class="about-row"><span>有效期</span><span class="about-val">${ca.validUntil || '—'}</span></div>
          <div class="about-row"><span>存储位置</span><span class="about-val">Windows 当前用户根证书库</span></div>
        </div></div>
        <div class="set-group"><div class="set-label">证书操作</div><div class="set-card" style="padding:14px;display:flex;gap:8px;flex-wrap:wrap">
          <button class=${'btn' + (ca.exists ? '' : ' primary')} onClick=${() => action('rewrite:caGenerate')}><${Icon} name="plus" />${ca.exists ? '重新生成' : '生成 CA'}</button>
          <button class=${'btn' + (ca.installed ? ' danger' : ca.exists ? ' primary' : '')} disabled=${!ca.exists} onClick=${() => action(ca.installed ? 'rewrite:caUninstall' : 'rewrite:caInstall')}><${Icon} name="shield" />${ca.installed ? '吊销并移除' : '安装并信任'}</button>
          <button class="btn ghost" disabled=${!ca.exists} onClick=${() => action('rewrite:caExport')}>导出 .crt</button>
        </div></div>
      </div>

      <div class="set-col">
        <div class="set-group"><div class="set-label">解密主机白名单</div><div class="set-card">
          ${hosts.length ? html`<div class="host-rows host-tags">${hosts.map((h) => html`<${Tag} key=${h} cls="grey">${h}</${Tag}>`)}</div>` : html`<${Empty} icon="globe" title="白名单为空" sub="HTTPS 默认全部透传，只有明确添加的域名才会被解密。" />`}
          <div style="padding:0 12px 12px"><button class="btn sm" onClick=${() => setEditing(true)}><${Icon} name="edit" />编辑白名单</button></div>
        </div></div>
        <div class="set-group"><div class="set-label">当前状态</div><div class="set-card">
          <div class="about-row"><span>重写引擎</span><span class="about-val">${rw.running ? `运行中 · 端口 ${rw.port}` : '已停止'}</span></div>
          <div class="about-row"><span>规则命中</span><span class="about-val">${rw.hits || 0} 次</span></div>
          <div class="about-row"><span>处理流量</span><span class="about-val">${((rw.bytes || 0) / 1048576).toFixed(2)} MB</span></div>
          <div class="about-row"><span>非白名单 HTTPS</span><span class="about-val">原样 CONNECT 透传</span></div>
        </div></div>
        <div class="set-group"><div class="set-label">安全说明</div><div class="set-card" style="padding:14px"><ul class="bullets" style="margin:0"><li>安装 CA 前请确认你信任本机上的 Wallnut。</li><li>只解密白名单域名，不上传解密内容。</li><li>吊销会同时移除 Windows 信任。</li></ul></div></div>
      </div>
    </div>
    ${editing ? html`<${HostsModal} onClose=${() => { setEditing(false); refresh(); }} />` : null}
  </div>`;
}
