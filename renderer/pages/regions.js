/* 地区测速页：把「多个订阅里同一国家的所有节点」聚到一起测速，找出最快的那个 */

import { html, Icon, Button, Seg, PageHead, Tag, Lat, Empty, Spinner, Modal, Field, Input, Switch, fmtDuration, useStore, useState } from '../ui.js';
import { S, call, toast, runRegionTest, runAllTest, cancelTest, applyFastest, sortedRegions, testUrl, setPage } from '../store.js';
import { focusNodesTab } from './nodes.js';
import * as client from '../client.js';

const modeLabel = { select: '手动选优', auto: '自动选优（url-test）' };

function selectedPolicyName() {
  const main = (S.state && S.state.settings && S.state.settings.defaultTarget) || '主策略';
  const proxies = S.runtime && S.runtime.proxies && S.runtime.proxies.proxies;
  return proxies && proxies[main] ? proxies[main].now : null;
}

function groupNow(region) {
  const p = S.runtime && S.runtime.proxies && S.runtime.proxies.proxies;
  if (!p) return null;
  const g = p[region.name];
  return (g && (g.now || (g.all && g.all[0]))) || null;
}

function nodeDelay(name) {
  const map = {};
  if (S.test && S.test.results) for (const r of S.test.results) map[r.name] = r.ok ? r.delay : -1;
  const p = S.runtime && S.runtime.proxies && S.runtime.proxies.proxies;
  if (p && p[name] && p[name].history && p[name].history.length) {
    const h = p[name].history[p[name].history.length - 1];
    if (!map[name] && h && h.delay) map[name] = h.delay;
  }
  return map[name];
}

function sourceOf(name) {
  const n = S.nodes.find((x) => x.name === name);
  return n ? n.source : '';
}

function RegionCard({ region, onEdit, onRank, testing, active }) {
  const now = groupNow(region);
  const sources = (region.sources || []).filter(Boolean);
  const delays = {};
  for (const name of region.nodes || []) delays[name] = nodeDelay(name);

  const setMode = async (mode) => {
    await call('region:save', { region: { ...region, mode } });
    toast(`「${region.name}」已切换为${modeLabel[mode]}`, 'ok');
  };

  const selectRegion = async () => {
    if (!S.core.running) return toast('mihomo 未运行，请先在首页连接', 'error');
    const main = (S.state && S.state.settings && S.state.settings.defaultTarget) || '主策略';
    try {
      await client.selectProxy(main, region.name);
      toast(`已将「${main}」切换到「${region.name}」`, 'ok');
    } catch (e) { toast(`切换策略失败：${e.message}`, 'error'); }
  };

  return html`<div class=${'card region-card' + (active ? ' is-active' : '')} onClick=${(e) => { if (!e.target.closest('button')) selectRegion(); }}>
    <div class="rc-head">
      <div class="rc-flag">${region.flag || '🌐'}</div>
      <div class="grow">
        <div class="rc-name">${region.name}</div>
        <div class="rc-meta">${region.count} 个节点 · ${sources.length} 个来源${region.mode === 'auto' ? ' · 自动' : ''}</div>
      </div>
      ${region.mode === 'auto' ? html`<${Tag} cls="ok">自动</${Tag}>` : null}
      ${active ? html`<${Tag} cls="ok">当前策略</${Tag}>` : null}
      <button class="btn ghost sm" title="编辑地区" onClick=${() => onEdit(region)}><${Icon} name="edit" cls="ico-12" /></button>
    </div>

    <div class="rc-best">
      ${region.count === 0
        ? html`<span class="nm" style="color:var(--sub);font-weight:500">该地区暂无节点</span>
               <span class="mt">试试修改关键词，或在节点名里加上国家</span>`
        : html`<span class="nm">${now || '尚未测速'}</span>
                 <span class="mt">
                   ${now ? html`<${Lat} ms=${delays[now]} />` : html`<span class="sub">点「测速」查看延迟</span>`}
                   <span class="sub">跨 ${sources.length} 个订阅</span>
                 </span>`}
    </div>

    <div class="rc-foot">
      <${Seg} value=${region.mode || 'select'} options=${[{ v: 'select', label: '手动' }, { v: 'auto', label: '自动' }]} onChange=${setMode} />
      <button class="btn sm" disabled=${testing || !region.count} onClick=${() => runRegionTest(region.id, region.nodes)}>
        ${testing ? html`<${Spinner} /> 测速中` : html`<${Icon} name="gauge" />测速`}
      </button>
      <button class="btn sm primary" disabled=${!region.nodes.length} onClick=${() => onRank(region)}>
        结果
      </button>
    </div>

    <div class="row wrap" style="gap:4px">
      ${sources.slice(0, 3).map((s) => html`<${Tag} key=${s} cls="type">${s}</${Tag}>`)}
      ${sources.length > 3 ? html`<span class="sub">+${sources.length - 3}</span>` : null}
    </div>
  </div>`;
}

function RankPanel({ region, onClose }) {
  const testing = S.test && S.test.running && S.test.regionId === region.id;
  const results = ((S.test && S.test.results) || []).filter((r) => region.nodes.includes(r.name));
  const sorted = [...results].sort((a, b) => (b.ok ? b.delay : 1e9) - (a.ok ? a.delay : 1e9));
  const now = groupNow(region);

  const apply = async (name) => {
    await applyFastest(region, name);
    onClose();
  };

  return html`<${Modal} title=${`${region.flag || ''} ${region.name} · 测速结果`} onClose=${onClose} width="640px"
    foot=${html`<button class="btn" onClick=${onClose}>关闭</button>
      <button class="btn" onClick=${() => runRegionTest(region.id, region.nodes)} disabled=${testing}>
        ${testing ? '测速中…' : '重新测速'}
      </button>`}>
    ${testing ? html`<div class="row"><${Spinner} /><span class="sub">正在测 ${S.test.done || 0}/${S.test.total || region.nodes.length}（并发走真实代理链路）</span></div>` : null}
    ${!sorted.length
      ? html`<${Empty} icon="gauge" title="还没有结果" sub="点「重新测速」把该地区所有订阅的节点跑一遍，按延迟排序。" />`
      : html`<div class="rank-list card" style="box-shadow:none;border-color:var(--line)">
          ${sorted.map((r, i) => html`<div key=${r.name} class=${'rank-row' + (i === 0 && r.ok ? ' best' : '')}>
            <span class="rank-no">${i + 1}</span>
            <span class="node-name" style="flex:1">${r.name}</span>
            <span class="rank-src">${sourceOf(r.name)}</span>
            <${Lat} ms=${r.ok ? r.delay : -1} />
            ${r.ok
              ? html`<button class="btn sm ${i === 0 ? 'primary' : ''}" onClick=${() => apply(r.name)}>
                  ${now === r.name ? '当前' : '应用'}
                </button>`
              : html`<span class="sub" style="min-width:56px;text-align:right">失败</span>`}
          </div>`)}
        </div>`}
    <span class="sub">应用即切到该组；自动组会转为手动，避免被 url-test 覆盖。</span>
  </${Modal}>`;
}

function AddRegionModal({ onClose }) {
  const exists = new Set(S.regions.map((r) => r.id));
  const presets = (S.presets || []).filter((p) => !exists.has(p.id));
  return html`<${Modal} title="添加地区分组" onClose=${onClose} width="640px" foot=${html`<button class="btn" onClick=${onClose}>完成</button>`}>
    <span class="sub">按国旗或关键词识别节点，如「香港 01」「HK」「🇯🇵 Tokyo」。</span>
    ${presets.length === 0
      ? html`<${Empty} icon="check" title="所有内置地区都已添加" sub="也可以手动新建自定义地区并填写关键词。" />`
      : html`<div class="region-grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">
          ${presets.map((p) => html`<button key=${p.id} class="card" style="padding:10px 12px;display:flex;align-items:center;gap:8px;text-align:left"
            onClick=${async () => { await call('region:presetAdd', { presetId: p.id }); }}>
            <span style="font-size:18px">${p.flag}</span>
            <span class="grow"><span style="font-size:13px;font-weight:600">${p.name}</span>
            <span class="sub" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(p.keywords || []).slice(0, 3).join(' / ')}</span></span>
            <${Icon} name="plus" cls="ico-12 c-sub" />
          </button>`)}
        </div>`}
  </${Modal}>`;
}

function EditRegionModal({ region, onClose }) {
  const [name, setName] = useState(region.name);
  const [flag, setFlag] = useState(region.flag || '🌐');
  const [keywords, setKeywords] = useState((region.keywords || []).join(', '));
  const [enabled, setEnabled] = useState(region.enabled !== false);
  const save = async () => {
    const kws = keywords.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!name.trim()) return toast('地区名不能为空', 'error');
    await call('region:save', { region: { ...region, name: name.trim(), flag, keywords: kws, enabled } });
    toast('已保存地区设置', 'ok');
    onClose();
  };
  return html`<${Modal} title=${`编辑「${region.name}」`} onClose=${onClose} width="560px"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" onClick=${save}>保存</button>`}>
    <div class="row" style="gap:10px">
      <${Field} label="国旗 / 图标"><${Input} value=${flag} onInput=${(e) => setFlag(e.target.value)} style="width:70px" /></${Field}>
      <${Field} label="地区名" style="flex:1"><${Input} value=${name} onInput=${(e) => setName(e.target.value)} /></${Field}>
    </div>
    <${Field} label="识别关键词（逗号分隔，大小写不敏感）">
      <textarea class="textarea" style="min-height:80px" value=${keywords} onInput=${(e) => setKeywords(e.target.value)}></textarea>
    </${Field}>
    <span class="sub">英文关键词按词边界匹配（US 不会命中 Russia）。</span>
    <div class="set-row" style="padding-left:0;padding-right:0">
      <div class="sl"><span>启用该地区分组</span><span class="note-grey">关闭后不再生成策略组，也不参与聚合</span></div>
      <${Switch} on=${enabled} onChange=${setEnabled} />
    </div>
    <div class="hr"></div>
    <div class="row wrap">
      <span class="sub">当前匹配：</span>
      <span class="sv-strong">${region.count} 个节点</span>
      ${(region.sources || []).map((s) => html`<${Tag} key=${s} cls="type">${s}</${Tag}>`)}
    </div>
  </${Modal}>`;
}

export function RegionsPanel() {
  const s = useStore();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [rank, setRank] = useState(null);
  const regions = sortedRegions();
  const activePolicy = selectedPolicyName();
  const testing = !!(S.test && S.test.running);
  const runningRegion = testing ? S.test.regionId : null;
  const untracked = S.nodes.filter((n) => !n.region);

  const gotoNodes = () => {
    focusNodesTab('nodes');
    setPage('nodes');
    toast('已切到「节点」页查看全部可用节点', 'info');
  };

  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <div class="toolbar" style="gap:10px">
      <span class="sub grow">成员来自全部订阅 + 本地节点；按延迟排序，一键应用最快。</span>
      <button class="btn ghost sm" onClick=${() => setAdding(true)}><${Icon} name="plus" />添加地区</button>
      ${testing
        ? html`<button class="btn sm danger" onClick=${() => cancelTest()}>停止测速 ${S.test.done}/${S.test.total}</button>`
        : html`<button class="btn primary sm" disabled=${!S.core.running || !S.nodes.length} onClick=${() => runAllTest()}>
            <${Icon} name="gauge" />一键测全部地区
          </button>`}
    </div>

    ${!regions.length
      ? html`<${Empty} icon="globe" title="还没有地区分组" sub="点「添加地区」，选几个常用国家；导入订阅后节点会自动归类。">
          <button class="btn primary" onClick=${() => setAdding(true)}><${Icon} name="plus" />添加地区</button>
        </${Empty}>`
      : html`<div class="region-grid">
          ${regions.map((r) => html`<${RegionCard} key=${r.id} region=${r} active=${activePolicy === r.name} testing=${runningRegion === r.id}
            onEdit=${setEditing} onRank=${setRank} />`)}
        </div>`}

    ${untracked.length
      ? html`<div class="card" style="padding:12px 16px;display:flex;align-items:center;gap:10px">
          <${Icon} name="info" cls="c-orange" />
          <span class="grow"><span class="sv-strong">${untracked.length} 个节点没有匹配到地区</span>
          <span class="sub" style="display:block">仍可在「节点」页选择；改关键词可归组。</span></span>
          <button class="btn sm" onClick=${gotoNodes}>去节点页</button>
        </div>`
      : null}

    ${testing ? html`<div class="card" style="padding:12px 16px;display:flex;align-items:center;gap:10px">
      <${Spinner} />
      <span class="grow"><span class="sv-strong">正在测速 ${S.test.done || 0}/${S.test.total || '?'}</span>
      <span class="sub" style="display:block">结果会实时写入下方排名与地区卡片。</span></span>
      <button class="btn sm" onClick=${() => runRegionTest(S.test.regionId)}>重跑</button>
    </div>` : null}

    ${S.test && S.test.results && S.test.results.length && !testing
      ? html`<div class="card" style="overflow:hidden">
          <div class="rw-head"><span class="rw-title">最近一次测速</span>
            <span class="rw-count">${S.test.summary ? `成功 ${S.test.summary.okCount} / 失败 ${S.test.summary.failCount}` : ''}</span>
            <span class="grow"></span>
            <span class="sub">${S.test.scope === 'region' ? '地区：' + ((S.regions.find((r) => r.id === S.test.regionId) || {}).name || '') : '全部节点'}</span>
          </div>
          <div class="rank-list">
            ${[...S.test.results].sort((a, b) => (b.ok ? b.delay : 1e9) - (a.ok ? a.delay : 1e9)).slice(0, 8).map((r, i) => html`<div key=${r.name} class=${'rank-row' + (i === 0 && r.ok ? ' best' : '')}>
              <span class="rank-no">${i + 1}</span>
              <span class="node-name">${r.name}</span>
              <span class="rank-src">${sourceOf(r.name)}</span>
              <${Lat} ms=${r.ok ? r.delay : -1} />
            </div>`)}
          </div>
        </div>`
      : null}

    ${adding ? html`<${AddRegionModal} onClose=${() => setAdding(false)} />` : null}
    ${editing ? html`<${EditRegionModal} region=${editing} onClose=${() => setEditing(null)} />` : null}
    ${rank ? html`<${RankPanel} region=${rank} onClose=${() => setRank(null)} />` : null}
  </div>`;
}

/* 兼容包装：单独渲染时自带 PageHead（导航已并入「策略」页，此处保留默认导出） */
export default function Regions() {
  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <${PageHead} title="地区测速" sub="跨订阅聚合 · 同一国家所有节点一起跑，找出最快的那条" />
    <${RegionsPanel} />
  </div>`;
}
