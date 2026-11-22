/* 规则页：本地规则（filter_local）+ 远程规则集链接（filter_remote）+ 分流优化 */

import { html, Icon, Button, Switch, PageHead, Tag, Empty, Spinner, Modal, Field, Input, Textarea, useStore, useState, useEffect } from '../ui.js';
import { S, call, toast, saveSettings, groupTargets } from '../store.js';
import * as client from '../client.js';

const RULE_TYPES = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'GEOSITE',
  'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN', 'SRC-IP-CIDR',
  'DST-PORT', 'SRC-PORT', 'NETWORK', 'PROCESS-NAME', 'PROCESS-PATH', 'MATCH'
];

const RUNTIME_TYPE = {
  Domain: 'DOMAIN', DomainSuffix: 'DOMAIN-SUFFIX', DomainKeyword: 'DOMAIN-KEYWORD',
  DomainRegex: 'DOMAIN-REGEX', DomainWildcard: 'DOMAIN-WILDCARD', GeoIP: 'GEOIP',
  Geosite: 'GEOSITE', IpCidr: 'IP-CIDR', IpCidr6: 'IP-CIDR6', IpAsn: 'IP-ASN',
  SrcIpCidr: 'SRC-IP-CIDR', DstPort: 'DST-PORT', SrcPort: 'SRC-PORT', Network: 'NETWORK',
  ProcessName: 'PROCESS-NAME', ProcessPath: 'PROCESS-PATH', Match: 'MATCH', RuleSet: 'RULE-SET',
  And: 'AND', Or: 'OR', Not: 'NOT', SubRule: 'SUB-RULE'
};

const QX_MAP = {
  host: 'DOMAIN', 'host-suffix': 'DOMAIN-SUFFIX', 'host-keyword': 'DOMAIN-KEYWORD',
  ip: 'IP-CIDR', 'ip-cidr': 'IP-CIDR', 'ip6-cidr': 'IP-CIDR6', geoip: 'GEOIP', geosite: 'GEOSITE',
  final: 'MATCH', match: 'MATCH'
};

function targetOptions(extra) {
  const list = groupTargets();
  const names = list.map((t) => t.name);
  if (extra && !names.includes(extra)) list.unshift({ name: extra, kind: 'unknown' });
  return list;
}

function TargetSelect({ value, onChange, extra, style }) {
  const opts = targetOptions(extra);
  return html`<select class="select" style=${style} value=${value} onChange=${(e) => onChange(e.target.value)}>
    ${opts.map((t) => html`<option key=${t.name} value=${t.name}>${t.flag ? t.flag + ' ' : ''}${t.name}</option>`)}
    ${opts.every((t) => t.name !== value) ? html`<option value=${value}>${value}</option>` : null}
  </select>`;
}

function RuleModal({ initial, onClose }) {
  const r = initial || {};
  const [type, setType] = useState(r.type || 'DOMAIN-SUFFIX');
  const [payload, setPayload] = useState(r.payload || '');
  const [target, setTarget] = useState(r.target || (S.state.settings.defaultTarget || '主策略'));
  const [note, setNote] = useState(r.note || '');

  const save = async () => {
    if (!payload.trim() && type !== 'MATCH') return toast('请填写匹配内容', 'error');
    const rules = [...S.state.rules];
    const rec = { ...r, id: r.id || 'r_' + Date.now().toString(36), type, payload: payload.trim(), target, note: note.trim(), disabled: !!r.disabled };
    const idx = rules.findIndex((x) => x.id === rec.id);
    if (idx >= 0) rules[idx] = rec; else rules.push(rec);
    const res = await call('rule:save', { rules });
    if (res && res.ok) { toast(`规则已保存，共 ${rules.filter((x) => !x.disabled).length} 条生效`, 'ok'); onClose(); }
  };

  return html`<${Modal} title=${r.id ? '编辑规则' : '添加规则'} onClose=${onClose} width="620px"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" onClick=${save}>保存并生效</button>`}>
    <div class="row" style="gap:10px">
      <${Field} label="规则类型" style="width:190px">
        <select class="select" style="width:100%;height:32px" value=${type} onChange=${(e) => setType(e.target.value)}>
          ${RULE_TYPES.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}
        </select>
      </${Field}>
      <${Field} label="匹配内容" style="flex:1">
        <${Input} value=${payload} placeholder="例如 google.com / 香港 / 1.2.3.4/32" onInput=${(e) => setPayload(e.target.value)} />
      </${Field}>
    </div>
    <div class="row" style="gap:10px">
      <${Field} label="策略目标" style="flex:1">
        <${TargetSelect} value=${target} onChange=${setTarget} extra=${r.target} style="width:100%;height:32px" />
      </${Field}>
      <${Field} label="备注（可选）" style="flex:1">
        <${Input} value=${note} placeholder="为什么要这条规则" onInput=${(e) => setNote(e.target.value)} />
      </${Field}>
    </div>
    <span class="sub">目标可以是地区组（跨订阅聚合）、主策略组、自定义组、DIRECT 或单个节点名。保存后会重建配置并热加载内核。</span>
  </${Modal}>`;
}

function BatchModal({ onClose }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const targets = groupTargets().map((t) => t.name);

  const parse = () => {
    const rows = [];
    const bad = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 2) { bad.push(line); continue; }
      const type = QX_MAP[parts[0].toLowerCase()] || parts[0].toUpperCase();
      if (!RULE_TYPES.includes(type) && !['AND', 'OR', 'NOT', 'SUB-RULE', 'RULE-SET'].includes(type)) { bad.push(line); continue; }
      const target = parts[2] && !/^(no-resolve|extended-matching)$/i.test(parts[2])
        ? parts[2]
        : (S.state.settings.defaultTarget || '主策略');
      rows.push({ id: 'r_' + Date.now().toString(36) + rows.length, type, payload: parts[1], target, disabled: false, note: '批量导入' });
    }
    setParsed({ rows, bad });
  };

  const commit = async () => {
    if (!parsed || !parsed.rows.length) return;
    const rules = [...S.state.rules, ...parsed.rows];
    const r = await call('rule:save', { rules });
    if (r && r.ok) { toast(`已追加 ${parsed.rows.length} 条规则`, 'ok'); onClose(); }
  };

  return html`<${Modal} title="批量粘贴规则" onClose=${onClose} width="720px"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button>
      <button class="btn" onClick=${parse}>解析</button>
      <button class="btn primary" disabled=${!parsed || !parsed.rows.length} onClick=${commit}>
        追加 ${parsed ? parsed.rows.length : ''} 条
      </button>`}>
    <span class="sub">每行 <span class="mono">类型, 匹配, 目标</span>，兼容 QX 写法：</span>
    <div class="card mono" style="padding:10px 12px;background:var(--fill-2);font-size:11px;line-height:1.8">
      <div>DOMAIN-SUFFIX, netflix.com, 美国</div>
      <div>host-suffix, disneyplus.com, 新加坡</div>
      <div>IP-CIDR, 10.0.0.0/8, DIRECT</div>
      <div>GEOIP, CN, DIRECT</div>
    </div>
    <textarea class="textarea" style="min-height:190px" value=${text} onInput=${(e) => setText(e.target.value)}
      placeholder="DOMAIN-SUFFIX, example.com, 香港"></textarea>
    ${parsed ? html`<div class="row wrap">
      <span class="sub">解析成功 ${parsed.rows.length} 条${parsed.bad.length ? ` · 无法识别 ${parsed.bad.length} 条` : ''}</span>
      ${parsed.bad.slice(0, 3).map((b) => html`<span class="sub c-red mono">${b}</span>`)}
    </div>` : null}
    ${parsed && parsed.rows.length
      ? html`<div class="rule-list card" style="box-shadow:none;max-height:200px;overflow:auto">
          ${parsed.rows.slice(0, 10).map((r) => html`<div class="rule-row" key=${r.id}>
            <span class="rule-tag"><${Tag}>${r.type}</${Tag}></span>
            <span class="rule-main"><span class="rule-match">${r.payload}</span></span>
            <span class="rule-act"><${Icon} name="arrow-r" /><b>${r.target}</b></span>
          </div>`)}
        </div>` : null}
  </${Modal}>`;
}

function ProviderModal({ initial, onClose }) {
  const p = initial || {};
  const [name, setName] = useState(p.name || '');
  const [url, setUrl] = useState(p.url || '');
  const [behavior, setBehavior] = useState(p.behavior || 'domain');
  const [interval, setInterval] = useState(String(p.interval || 86400));
  const [target, setTarget] = useState(p.target || (S.state.settings.defaultTarget || '主策略'));
  const [enabled, setEnabled] = useState(p.enabled !== false);
  const [format, setFormat] = useState(p.format === 'text' ? 'text' : 'yaml');

  const save = async () => {
    if (!url.trim()) return toast('请填写规则集链接', 'error');
    const provider = {
      ...p, id: p.id || 'rp_' + Date.now().toString(36), name: name.trim() || '远程规则集',
      url: url.trim(), behavior, format, interval: Number(interval) || 86400, target, enabled
    };
    const r = await call('ruleprovider:save', { provider });
    if (r && r.ok) { toast('远程规则集已保存并生效', 'ok'); onClose(); }
  };

  return html`<${Modal} title=${p.id ? '编辑远程规则集' : '添加远程规则集'} onClose=${onClose} width="640px"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" onClick=${save}>保存并生效</button>`}>
    <span class="sub">对应 QX 的 <span class="mono">[filter_remote]</span>：一条链接 = 一个规则集，内核按 interval 自动更新，命中即走目标策略。</span>
    <${Field} label="名称"><${Input} value=${name} placeholder="例如：AdBlock / 流媒体规则" onInput=${(e) => setName(e.target.value)} /></${Field}>
    <${Field} label="规则集链接（Clash domain / ipcidr 列表）">
      <${Input} value=${url} placeholder="https://example.com/rules/adblock.yaml" onInput=${(e) => setUrl(e.target.value)} />
    </${Field}>
    <div class="row" style="gap:12px">
      <${Field} label="行为类型" style="flex:1">
        <select class="select" style="width:100%;height:32px" value=${behavior} onChange=${(e) => setBehavior(e.target.value)}>
          <option value="domain">domain（域名列表）</option>
          <option value="ipcidr">ipcidr（IP 列表）</option>
          <option value="classical">classical（完整规则）</option>
        </select>
      </${Field}>
      <${Field} label="文件格式" style="width:130px">
        <select class="select" style="width:100%;height:32px" value=${format} onChange=${(e) => setFormat(e.target.value)}>
          <option value="yaml">YAML（payload）</option>
          <option value="text">纯文本（每行一条）</option>
        </select>
      </${Field}>
      <${Field} label="更新间隔（秒）" style="width:120px"><${Input} value=${interval} onInput=${(e) => setInterval(e.target.value)} /></${Field}>
      <${Field} label="命中后走" style="flex:1"><${TargetSelect} value=${target} onChange=${setTarget} extra=${p.target} style="width:100%;height:32px" /></${Field}>
    </div>
    <div class="set-row" style="padding-left:0;padding-right:0">
      <div class="sl"><span>启用</span><span class="note-grey">启用后会生成一条 RULE-SET 规则插在本地规则之后、MATCH 之前</span></div>
      <${Switch} on=${enabled} onChange=${setEnabled} />
    </div>
  </${Modal}>`;
}

function ValidateModal({ onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    call('core:validate', {}, { silent: true }).then((r) => setState({ loading: false, r }));
  }, []);
  return html`<${Modal} title="配置校验（mihomo -t）" onClose=${onClose} width="720px"
    foot=${html`<button class="btn" onClick=${onClose}>关闭</button>`}>
    ${state.loading ? html`<div class="row"><${Spinner} /><span class="sub">正在校验生成的 YAML…</span></div>` : null}
    ${state.r && html`<div class="row"><${Tag} cls=${state.r.ok ? 'ok' : 'red'}>${state.r.ok ? '校验通过' : '校验失败'}</${Tag}>
      <span class="sub">${state.r.meta ? `${state.r.meta.nodeCount} 节点 · ${state.r.meta.groupCount} 策略组 · ${state.r.meta.ruleCount} 条规则` : ''}</span></div>`}
    ${state.r && state.r.meta && state.r.meta.warnings && state.r.meta.warnings.length
      ? html`<div class="card" style="padding:10px 12px;background:var(--fill-2);font-size:11px;line-height:1.7">
          ${state.r.meta.warnings.slice(0, 8).map((w) => html`<div class="c-orange">${w}</div>`)}
        </div>` : null}
    ${state.r ? html`<textarea class="textarea" style="min-height:300px" readonly value=${state.r.yaml || state.r.output || ''}></textarea>` : null}
  </${Modal}>`;
}

export default function Rules() {
  const s = useStore();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [batch, setBatch] = useState(false);
  const [provider, setProvider] = useState(null);
  const [validate, setValidate] = useState(false);
  const rules = S.state.rules || [];
  const providers = S.state.ruleProviders || [];
  const enabled = rules.filter((r) => !r.disabled).length;
  const hits = {};
  for (const r of S.runtime.rules || []) {
    const type = RUNTIME_TYPE[r.type] || String(r.type || '').toUpperCase();
    hits[`${type}|${r.payload}|${r.proxy || r.target}`] = r.extra ? r.extra.hitCount : r.hitCount;
  }

  const move = async (idx, delta) => {
    const next = [...rules];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    await call('rule:save', { rules: next });
  };

  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <${PageHead} title="规则" sub=${`${enabled} 条生效 · ${providers.filter((p) => p.enabled !== false).length} 个远程规则集`}>
      <button class="btn sm ghost" onClick=${() => setValidate(true)}><${Icon} name="shield" />校验</button>
      <button class="btn sm" onClick=${() => setBatch(true)}><${Icon} name="list" />批量粘贴</button>
      <button class="btn sm primary" onClick=${() => setAdding(true)}><${Icon} name="plus" />添加规则</button>
    </${PageHead}>

    <div class="card flow-card">
      <div class="flow">
        <span class="flow-step"><b>${enabled}</b> 本地规则</span><${Icon} name="chev-r" cls="ico-12 c-sub" />
        <span class="flow-step"><b>${providers.filter((p) => p.enabled !== false).length}</b> 远程规则集</span><${Icon} name="chev-r" cls="ico-12 c-sub" />
        <span class="flow-step">MATCH → <b>${S.state.settings.defaultTarget}</b></span>
      </div>
      <span class="grow"></span>
      <div class="mc-text" style="text-align:right"><span>分流优化</span><span class="sub">${S.state.settings.routingOptimize ? '按精度重排：host > suffix > keyword > IP' : '按列表顺序自上而下匹配'}</span></div>
      <${Switch} on=${!!S.state.settings.routingOptimize} onChange=${(v) => saveSettings({ routingOptimize: v }).then(() => toast(v ? '已启用分流优化' : '已关闭分流优化', 'ok'))} />
    </div>

    <div class="card rule-card">
      <div class="rw-head">
        <span class="rw-title">本地规则</span><span class="rw-count">${rules.length} 条</span>
        <span class="grow"></span>
        <span class="sub">filter_local</span>
      </div>
      ${rules.length
        ? html`<div class="rule-list">
            ${rules.map((r, i) => html`<div key=${r.id} class=${'rule-row' + (r.disabled ? ' disabled' : '')}>
              <span class="rule-tag"><${Tag}>${r.type}</${Tag}></span>
              <span class="rule-main">
                <span class="rule-match">${r.payload}</span>
                <span class="rule-act"><${Icon} name="arrow-r" /><b>${r.target}</b>${r.note ? html`<span class="sub">${r.note}</span>` : null}</span>
              </span>
              <span class="rule-hits">${hits[`${r.type}|${r.payload}|${r.target}`] ? hits[`${r.type}|${r.payload}|${r.target}`] + ' 次' : ''}</span>
              <button class="btn ghost sm" title="上移" disabled=${i === 0} onClick=${() => move(i, -1)}><${Icon} name="up" /></button>
              <button class="btn ghost sm" title="下移" disabled=${i === rules.length - 1} onClick=${() => move(i, 1)}><${Icon} name="down" /></button>
              <button class="btn ghost sm" title="编辑" onClick=${() => setEditing(r)}><${Icon} name="edit" /></button>
              <${Switch} on=${!r.disabled} onChange=${async (v) => {
                const next = rules.map((x) => x.id === r.id ? { ...x, disabled: !v } : x);
                await call('rule:save', { rules: next });
              }} />
              <button class="btn ghost sm danger" title="删除" onClick=${async () => {
                if (!confirm(`删除规则 ${r.type}, ${r.payload}？`)) return;
                const next = rules.filter((x) => x.id !== r.id);
                await call('rule:save', { rules: next });
              }}><${Icon} name="trash" /></button>
            </div>`)}
          </div>`
        : html`<${Empty} icon="rules" title="还没有本地规则" sub="添加域名 / IP / 进程规则，或者从 QX、Surge 配置里批量粘贴。">
            <button class="btn primary" onClick=${() => setAdding(true)}><${Icon} name="plus" />添加规则</button>
          </${Empty}>`}
      <div class="rw-note"><${Icon} name="info" /><span>禁用后从配置中移除，重启仍保持禁用。</span></div>
    </div>

    <div class="card rule-card">
      <div class="rw-head">
        <span class="rw-title">远程规则集</span><span class="rw-count">${providers.length} 个</span>
        <span class="grow"></span>
        <button class="btn sm" onClick=${() => setProvider({})}><${Icon} name="link" />添加链接</button>
      </div>
      ${providers.length
        ? html`<div class="rule-list">
            ${providers.map((p) => html`<div key=${p.id} class="rule-row">
              <span class="rule-tag"><${Tag} cls="udp">${p.behavior}${p.format === 'text' ? ' · text' : ''}</${Tag}></span>
              <span class="rule-main">
                <span class="rule-match">${p.name}</span>
                <span class="rule-act mono" style="max-width:520px">${p.url}</span>
              </span>
              <span class="rule-act"><${Icon} name="arrow-r" /><b>${p.target}</b></span>
              <span class="sub" style="min-width:70px;text-align:right">${p.updatedAt ? '更新于 ' + new Date(p.updatedAt).toLocaleDateString() : '未更新'}</span>
              <button class="btn sm" onClick=${async () => {
                toast('正在拉取规则集…', 'info');
                const r = await call('ruleprovider:update', { id: p.id });
                if (r && r.ok) toast('规则集已更新', 'ok');
              }}><${Icon} name="refresh" />更新</button>
              <button class="btn ghost sm" title="编辑" onClick=${() => setProvider(p)}><${Icon} name="edit" /></button>
              <${Switch} on=${p.enabled !== false} onChange=${(v) => call('ruleprovider:save', { provider: { ...p, enabled: v } })} />
              <button class="btn ghost sm danger" title="删除" onClick=${async () => {
                if (!confirm(`删除远程规则集「${p.name}」？`)) return;
                await call('ruleprovider:remove', { id: p.id });
                toast('已移除规则集', 'ok');
              }}><${Icon} name="trash" /></button>
            </div>`)}
          </div>`
        : html`<${Empty} icon="link" title="还没有远程规则集" sub="填一个规则集链接（Clash / mihomo 的 domain、ipcidr 或 classical 格式），内核会按间隔自动更新。">
            <button class="btn primary" onClick=${() => setProvider({})}><${Icon} name="link" />添加远程规则集</button>
          </${Empty}>`}
      <div class="rw-note"><${Icon} name="info" /><span>每条生成 <span class="mono">RULE-SET, &lt;集合名&gt;, &lt;目标&gt;</span>，插在本地规则之后。</span></div>
    </div>

    ${adding ? html`<${RuleModal} onClose=${() => setAdding(false)} />` : null}
    ${editing ? html`<${RuleModal} initial=${editing} onClose=${() => setEditing(null)} />` : null}
    ${batch ? html`<${BatchModal} onClose=${() => setBatch(false)} />` : null}
    ${provider ? html`<${ProviderModal} initial=${provider} onClose=${() => setProvider(null)} />` : null}
    ${validate ? html`<${ValidateModal} onClose=${() => setValidate(false)} />` : null}
  </div>`;
}
