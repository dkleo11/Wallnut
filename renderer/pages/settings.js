/* 设置页：通用 / 网络接管 / 内核 / 测速订阅 / DNS / 关于（对应原型画板 05 的两列卡片语言） */

import { html, Icon, Button, Switch, Seg, PageHead, Tag, Input, Modal, Spinner, fmtDuration, timeAgo, useStore, useState, useEffect } from '../ui.js';
import { S, call, invoke, toast, saveSettings, setTheme, refreshSys } from '../store.js';
import { LANGUAGES, setLanguage } from '../i18n.js';

function Row({ label, note, children }) {
  return html`<div class="set-row">
    <div class="sl"><div class="sl-gap"><span>${label}</span></div>${note ? html`<span class="note-grey">${note}</span>` : null}</div>
    <div class="sr">${children}</div>
  </div>`;
}

function NumRow({ label, note, value, unit, min = 0, max = 65535, onCommit }) {
  const [v, setV] = useState(String(value == null ? '' : value));
  const commit = () => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) { setV(String(value)); return toast('数值不合法', 'error'); }
    onCommit(n);
  };
  return html`<div class="set-row">
    <div class="sl"><div class="sl-gap"><span>${label}</span></div>${note ? html`<span class="note-grey">${note}</span>` : null}</div>
    <div class="sr">
      <${Input} value=${v} onInput=${(e) => setV(e.target.value)} onBlur=${commit}
        onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} style="width:110px;text-align:right" />
      ${unit ? html`<span class="sub">${unit}</span>` : null}
    </div>
  </div>`;
}

function TextRow({ label, note, value, placeholder, onCommit, mono }) {
  const [v, setV] = useState(value || '');
  return html`<div class="set-row">
    <div class="sl"><div class="sl-gap"><span>${label}</span></div>${note ? html`<span class="note-grey">${note}</span>` : null}</div>
    <div class="sr">
      <${Input} cls=${mono ? 'mono' : ''} value=${v} placeholder=${placeholder} onInput=${(e) => setV(e.target.value)}
        onBlur=${() => onCommit(v)} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} style="width:220px" />
    </div>
  </div>`;
}

function ValidateModal({ onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    call('core:validate', {}, { silent: true }).then((r) => setState({ loading: false, r }));
  }, []);
  return html`<${Modal} title="配置校验" onClose=${onClose} width="720px" foot=${html`<button class="btn" onClick=${onClose}>关闭</button>`}>
    ${state.loading ? html`<div class="row"><${Spinner} /><span class="sub">正在执行 mihomo -t …</span></div>` : null}
    ${state.r ? html`<div class="row"><${Tag} cls=${state.r.ok ? 'ok' : 'red'}>${state.r.ok ? '校验通过' : '校验失败'}</${Tag}>
      <span class="sub">${state.r.meta ? `${state.r.meta.nodeCount} 节点 / ${state.r.meta.groupCount} 组 / ${state.r.meta.ruleCount} 规则` : ''}</span></div>` : null}
    ${state.r ? html`<textarea class="textarea" style="min-height:300px" readonly value=${state.r.yaml || state.r.output || ''}></textarea>` : null}
  </${Modal}>`;
}

export default function Settings() {
  const s = useStore();
  const st = S.state.settings;
  const dns = st.dns || {};
  const [validate, setValidate] = useState(false);
  const [showDns, setShowDns] = useState(true);  // 默认展开，仍可点标题收起
  const closeAction = st.closeAction || (st.closeToTray === false ? 'quit' : 'tray');
  const [nsText, setNsText] = useState((dns.nameservers || []).join('\n'));
  const [fbText, setFbText] = useState((dns.fallback || []).join('\n'));
  const [hostsText, setHostsText] = useState((dns.hosts || []).map((h) => `${h.domain} ${h.ip}`).join('\n'));

  // 系统代理卡片读注册表实况：settings 里的值可能因异常退出/外部修改而与真实状态不一致
  useEffect(() => { refreshSys(); }, []);

  const set = (patch) => saveSettings(patch);
  const setDns = (patch) => saveSettings({ dns: { ...dns, ...patch } }, { silent: true });

  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <${PageHead} title="设置" sub="改动即时生效">
      <span class="sub">${S.core.running ? '内核运行中' : '内核未运行'}</span>
      <button class="btn sm" onClick=${() => setValidate(true)}><${Icon} name="shield" />校验配置</button>
      <button class="btn sm" onClick=${async () => { const r = await call('core:restart'); if (r && r.ok) toast('内核已重启', 'ok'); }}><${Icon} name="restart" />重启内核</button>
    </${PageHead}>

    <div class="set-grid">
      <div class="set-col">
        <div class="set-group">
          <div class="set-label">通用</div>
          <div class="set-card">
            <${Row} label="语言" note="界面语言，切换后自动刷新">
              <select class="select glass-select" style="min-width:150px" value=${st.language || 'zh-CN'} onChange=${async (e) => {
                const lang = e.target.value;
                const r = await saveSettings({ language: lang });
                if (!r || !r.ok) return;
                setLanguage(lang);
                try { localStorage.setItem('wallnut.lang', lang); } catch (_) {}
                location.reload();
              }}>
                ${LANGUAGES.map((l) => html`<option value=${l.code} data-no-i18n>${l.name}</option>`)}
              </select>
            </${Row}>
            <div class="set-row">
              <div class="sl"><div class="sl-gap"><${Icon} name="settings" />外观</div><span class="note-grey">浅色 / 深色 / 跟随系统</span></div>
              <div class="sr">
                <${Seg} value=${(S.state.ui && S.state.ui.theme) || 'system'}
                  options=${[{ v: 'light', label: '浅色' }, { v: 'dark', label: '深色' }, { v: 'system', label: '跟随' }]}
                  onChange=${async (theme) => {
                    await setTheme(theme);
                    toast(theme === 'system' ? '已跟随系统外观' : '外观已切换', 'ok');
                  }} />
              </div>
            </div>

            <${Row} label="随 Wallnut 启动内核" note="启动应用时自动拉起 mihomo">
              <${Switch} on=${st.autoStartCore !== false} onChange=${(v) => set({ autoStartCore: v })} />
            </${Row}>
            <${Row} label="开机自启动" note="开机后自动启动">
              <${Switch} on=${!!st.launchAtLogin} onChange=${async (v) => {
                const r = await call('app:autostart', { enable: v });
                if (r && r.ok) toast(v ? '已开启开机自启动' : '已关闭开机自启动', 'ok');
              }} />
            </${Row}>
            <${Row} label="关闭窗口时" note=${({ tray: '隐藏窗口，应用留在托盘', taskbar: '最小化到任务栏', quit: '直接退出应用' })[closeAction] || ''}>
              <${Seg} value=${closeAction}
                options=${[{ v: 'tray', label: '托盘' }, { v: 'taskbar', label: '任务栏' }, { v: 'quit', label: '退出' }]}
                onChange=${(v) => set({ closeAction: v, closeToTray: v === 'tray' })} />
            </${Row}>
            <${Row} label="桌面通知" note="内核异常、订阅失败、托盘操作">
              <${Switch} on=${st.notifications !== false} onChange=${(v) => set({ notifications: v })} />
            </${Row}>
            <${TextRow} label="默认策略组名" note="规则末尾 MATCH 的兜底目标" value=${st.defaultTarget}
              onCommit=${(v) => v.trim() && set({ defaultTarget: v.trim() })} />
            <${Row} label="数据目录" note=${S.paths.dataDir}>
              <button class="btn sm" onClick=${() => call('app:openDataDir')}><${Icon} name="folder" />打开</button>
            </${Row}>
          </div>
        </div>

        <div class="set-group">
          <div class="set-label">网络与系统接管</div>
          <div class="set-card">
            <${NumRow} label="混合端口" note="HTTP + SOCKS 同端口" value=${st.mixedPort} min=${1} max=${65535}
              onCommit=${(v) => set({ mixedPort: v })} />
            <${NumRow} label="控制器端口" note="GUI 与内核通信" value=${st.controllerPort} min=${1} max=${65535}
              onCommit=${(v) => set({ controllerPort: v })} />
            <${Row} label="控制器密钥" note=${st.secret ? '••••••••' + String(st.secret).slice(-4) : '未设置'}>
              <button class="btn sm ghost" onClick=${async () => { await invoke('app:copyText', st.secret); toast('密钥已复制', 'ok'); }}><${Icon} name="copy" />复制</button>
            </${Row}>
            <${Row} label="允许局域网连接" note="其他设备可通过本机端口代理">
              <${Switch} on=${!!st.allowLan} onChange=${(v) => set({ allowLan: v })} />
            </${Row}>
            <${Row} label="IPv6" note="内核与 DNS 同时生效">
              <${Switch} on=${!!st.ipv6} onChange=${(v) => set({ ipv6: v })} />
            </${Row}>
            <${Row} label="系统代理" note=${S.sys.systemProxy.enabled ? '已写入注册表并接管 WinINet' : '未接管'}>
              <${Switch} on=${!!S.sys.systemProxy.enabled} onChange=${async (v) => {
                const r = await call('net:systemProxy', { enable: v });
                await refreshSys();
                if (r && r.ok) toast(v ? '系统代理已开启' : '系统代理已关闭', 'ok');
              }} />
            </${Row}>
            <${Row} label="TUN 模式" note=${S.sys.elevated ? '已以管理员身份运行' : '需要管理员权限（右键以管理员身份运行）'}>
              <${Switch} on=${!!st.tunEnabled} onChange=${async (v) => {
                const r = await call('net:tun', { enable: v });
                if (r && r.needsAdmin) toast(r.error, 'error', 7000);
                else if (r && r.ok) toast(v ? 'TUN 已开启' : 'TUN 已关闭', 'ok');
              }} />
            </${Row}>
            <div class="set-row">
              <div class="sl"><span>TUN 栈</span><span class="note-grey">system 最省 CPU，gvisor 兼容性最好</span></div>
              <div class="sr">
                <${Seg} value=${st.tunStack || 'gvisor'} options=${[{ v: 'system', label: 'system' }, { v: 'gvisor', label: 'gvisor' }, { v: 'mixed', label: 'mixed' }]}
                  onChange=${(v) => set({ tunStack: v })} />
              </div>
            </div>
            <${Row} label="严格路由" note="防止 DNS / 流量泄漏">
              <${Switch} on=${st.strictRoute !== false} onChange=${(v) => set({ strictRoute: v })} />
            </${Row}>
          </div>
        </div>

        <div class="set-group">
          <button class="set-label" onClick=${() => setShowDns(!showDns)}
            style="display:flex;align-items:center;gap:4px;background:none;padding:0;margin:0 0 6px 4px">
            <${Icon} name="chev" cls="ico-12" style=${showDns ? '' : 'transform:rotate(-90deg)'} />DNS
            <span class="note-grey" style="font-weight:400">${showDns ? '收起' : `${dns.enabled === false ? '未启用' : (dns.fakeIp !== false ? 'fake-ip' : 'normal')} · ${(dns.nameservers || []).length} 个上游`}</span>
          </button>
          <div class="set-card" style=${showDns ? '' : 'display:none'}>
            <${Row} label="启用 DNS 模块" note=${dns.enabled !== false ? '已启用' : '未启用'}>
              <${Switch} on=${dns.enabled !== false} onChange=${(v) => setDns({ enabled: v })} />
            </${Row}>
            <${Row} label="fake-ip" note="拦截域名的 DNS 查询走假 IP">
              <${Switch} on=${dns.fakeIp !== false} onChange=${(v) => setDns({ fakeIp: v })} />
            </${Row}>
            <${TextRow} label="fake-ip 段" note="默认 198.18.0.1/16" value=${dns.fakeIpRange} mono
              onCommit=${(v) => v.trim() && setDns({ fakeIpRange: v.trim() })} />
            <div class="set-row" style="align-items:flex-start;padding-top:10px;padding-bottom:10px">
              <div class="sl"><span>上游 nameserver</span><span class="note-grey">每行一个，支持 DoH/DoT</span></div>
              <div class="sr" style="flex-direction:column;align-items:stretch;width:280px">
                <textarea class="textarea" style="min-height:70px;font-size:11px" value=${nsText} onInput=${(e) => setNsText(e.target.value)}
                  onBlur=${() => setDns({ nameservers: nsText.split(/\s+/).filter(Boolean) })}></textarea>
              </div>
            </div>
            <div class="set-row" style="align-items:flex-start;padding-top:10px;padding-bottom:10px">
              <div class="sl"><span>fallback</span><span class="note-grey">国内解析失败时使用</span></div>
              <div class="sr" style="flex-direction:column;align-items:stretch;width:280px">
                <textarea class="textarea" style="min-height:60px;font-size:11px" value=${fbText} onInput=${(e) => setFbText(e.target.value)}
                  onBlur=${() => setDns({ fallback: fbText.split(/\s+/).filter(Boolean) })}></textarea>
              </div>
            </div>
            <div class="set-row" style="align-items:flex-start;padding-top:10px;padding-bottom:10px">
              <div class="sl"><span>hosts</span><span class="note-grey">每行「域名 IP」</span></div>
              <div class="sr" style="flex-direction:column;align-items:stretch;width:280px">
                <textarea class="textarea" style="min-height:60px;font-size:11px" value=${hostsText} onInput=${(e) => setHostsText(e.target.value)}
                  onBlur=${() => {
                    const hosts = hostsText.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2).map(([domain, ip]) => ({ domain, ip }));
                    setDns({ hosts });
                  }}></textarea>
              </div>
            </div>
            <${Row} label="清空 DNS 缓存" note="调用内核 /cache/dns/flush">
              <button class="btn sm" onClick=${async () => { await call('dns:flush'); toast('已清空 DNS 缓存', 'ok'); }}>清空</button>
            </${Row}>
          </div>
        </div>
      </div>

      <div class="set-col">
        <div class="set-group">
          <div class="set-label">内核</div>
          <div class="set-card">
            <${Row} label="状态" note=${S.core.error || ''}>
              <span class=${'sv ' + (S.core.running ? 'ok' : '')}>${S.core.running ? '运行中 · ' + (S.core.version || '') : S.core.status}</span>
            </${Row}>
            <${Row} label="PID / 运行时长">
              <span class="sv mono">${S.core.pid || '—'} · ${S.core.startedAt ? fmtDuration(Date.now() - S.core.startedAt) : '—'}</span>
            </${Row}>
            <${Row} label="实际端口" note="端口被占用时会自动顺延">
              <span class="sv mono">mixed ${S.core.ports.mixedPort || st.mixedPort} · ctl ${S.core.ports.port || st.controllerPort}</span>
            </${Row}>
            <div class="set-row">
              <div class="sl"><span>日志级别</span><span class="note-grey">debug 会显著增加日志量</span></div>
              <div class="sr">
                <${Seg} value=${st.logLevel || 'info'} options=${[{ v: 'debug', label: 'debug' }, { v: 'info', label: 'info' }, { v: 'warning', label: 'warn' }, { v: 'error', label: 'error' }]}
                  onChange=${(v) => set({ logLevel: v })} />
              </div>
            </div>
            <${Row} label="Geo 数据走镜像" note="GitHub 不可达时保持开启">
              <${Switch} on=${st.geoMirror !== false} onChange=${(v) => set({ geoMirror: v })} />
            </${Row}>
            <${Row} label="统一延迟 / TCP 并发" note="开启后延迟数字更接近真实体验">
              <${Switch} on=${st.unifiedDelay !== false} onChange=${(v) => set({ unifiedDelay: v })} />
            </${Row}>
            <${Row} label="配置文件" note=${S.paths.config}>
              <button class="btn sm" onClick=${() => setValidate(true)}><${Icon} name="list" />查看</button>
            </${Row}>
            <${Row} label="内核二进制" note=${S.paths.core} />
          </div>
        </div>

        <div class="set-group">
          <div class="set-label">测速与订阅</div>
          <div class="set-card">
            <${TextRow} label="测速 URL" note="建议用 generate_204" value=${st.testUrl} mono
              onCommit=${(v) => v.trim() && set({ testUrl: v.trim() })} />
            <${NumRow} label="测速超时" unit="ms" value=${st.testTimeout} min=${1000} max=${30000}
              onCommit=${(v) => set({ testTimeout: v })} />
            <${NumRow} label="并发数" note="同时测几个节点" value=${st.testConcurrency} min=${1} max=${32}
              onCommit=${(v) => set({ testConcurrency: v })} />
            <${Row} label="自动更新订阅" note="应用运行期间按间隔巡检">
              <${Switch} on=${st.autoUpdateSubs !== false} onChange=${(v) => set({ autoUpdateSubs: v })} />
            </${Row}>
            ${st.autoUpdateSubs !== false ? html`<${NumRow} label="自动更新间隔" unit="分钟" value=${st.subscriptionInterval} min=${0} max=${10080}
              onCommit=${(v) => set({ subscriptionInterval: v })} />` : null}
          </div>
        </div>

        <div class="set-group">
          <div class="set-label">关于</div>
          <div class="set-card">
            <div class="about-row"><span>Wallnut</span><span class="about-val">0.5.1</span></div>
            <div class="about-row"><span>内核</span><span class="about-val">${S.core.version || 'mihomo'}</span></div>
            <div class="about-row"><span>许可证</span><span class="about-val">GPL-3.0</span></div>
            <div class="about-row"><span>项目地址</span>
              <a class="about-link" href="https://github.com/dkleo11/Wallnut" title="打开 GitHub 项目主页"
                onClick=${(e) => { e.preventDefault(); call('app:openExternal', 'https://github.com/dkleo11/Wallnut'); }}>
                <${Icon} name="link" />github.com/dkleo11/Wallnut
              </a>
            </div>
          </div>
        </div>
      </div>


    </div>

    ${validate ? html`<${ValidateModal} onClose=${() => setValidate(false)} />` : null}
  </div>`;
}
