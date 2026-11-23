/* 策略组页：地区组 + 自定义组（对应原型画板 03） */

import { html, Icon, Button, Switch, Chip, PageHead, Search, Tag, Lat, Empty, Spinner, Modal, Field, Input, useStore, useState } from '../ui.js';
import { S, call, toast, applyFastest, runAllTest, cancelTest, delayMap, setPage } from '../store.js';
import * as client from '../client.js';

function selectedPolicy() {
  const main = (S.state && S.state.settings && S.state.settings.defaultTarget) || '主策略';
  const proxies = S.runtime && S.runtime.proxies && S.runtime.proxies.proxies;
  return proxies && proxies[main] ? proxies[main].now : null;
}

async function selectPolicy(name) {
  if (!S.core.running) return toast('mihomo 未运行，请先在首页连接', 'error');
  const main = (S.state && S.state.settings && S.state.settings.defaultTarget) || '主策略';
  try {
    await client.selectProxy(main, name);
    toast(`已将「${main}」切换到「${name}」`, 'ok');
  } catch (e) { toast(`切换策略失败：${e.message}`, 'error'); }
}

function RegionStrat({ region }) {
  const [expanded, setExpanded] = useState(false);
  const dmap = delayMap();
  const p = (S.runtime.proxies && S.runtime.proxies.proxies) || {};
  const g = p[region.name] || {};
  const nowName = region.mode === 'auto' ? (g.now || region.selected || region.nodes[0] || null) : (region.selected || g.now || region.nodes[0] || null);
  const nowDelay = nowName ? dmap[nowName] : undefined;
  const members = [...region.nodes].sort((a, b) => {
    const da = dmap[a]; const db = dmap[b];
    const va = Number.isFinite(da) && da > 0 ? da : Infinity;
    const vb = Number.isFinite(db) && db > 0 ? db : Infinity;
    return va - vb || a.localeCompare(b);
  });
  const visibleMembers = expanded ? members : members.slice(0, 3);
  const active = selectedPolicy() === region.name;

  return html`<div class=${'card strat' + (active ? ' is-active' : '')}
    onClick=${(e) => { if (!e.target.closest('button')) selectPolicy(region.name); }}>
    <div class="sc-head">
      <div class="sc-id">
        <span class="ichi tint-blue"><${Icon} name="globe" /></span>
        <div><div class="sc-name">${region.flag} ${region.name}</div>
        <div class="sc-type">${region.count} 个节点 · 跨 ${(region.sources || []).length} 个订阅 · ${region.mode === 'auto' ? 'url-test 自动' : 'select 手动'}</div></div>
      </div>
      <div class="sc-acts">
        ${active ? html`<${Tag} cls="ok">当前策略</${Tag}>` : null}
        <button class="mini sc-mode-btn" title=${region.mode === 'auto' ? '切换为手动选择节点' : '切换为由内核自动测速选优'}
          onClick=${async (e) => {
            e.stopPropagation();
            const nextMode = region.mode === 'auto' ? 'select' : 'auto';
            const patch = { ...region, mode: nextMode };
            if (nextMode === 'select' && !patch.selected) patch.selected = nowName || region.nodes[0] || null;
            const r = await call('region:save', { region: patch });
            if (!r || !r.ok) return toast('切换模式失败', 'error');
            toast(nextMode === 'auto' ? '已切换为自动测速' : '已切换为手动选择', 'ok');
          }}>
          ${region.mode === 'auto' ? '手动' : '自动'}
        </button>
        <button class=${'sc-select-btn' + (active ? ' on' : '')} title=${active ? '当前已选择该地区' : '选择该地区节点'}
          disabled=${active}
          onClick=${(e) => { e.stopPropagation(); if (!active) selectPolicy(region.name); }}>
          选择
        </button>
      </div>
    </div>

    <div class="sc-current">
      <div class="sc-cur-row">
        <span class="sub">${region.mode === 'auto' ? '自动选中' : '当前节点'}</span>
        <span class="sc-cur-name grow">${nowName || '暂无节点'}</span>
        <${Lat} ms=${nowDelay} />
      </div>
      <span class="sub">${region.best && region.best !== nowName ? `本次测速最快：${region.best}` : region.mode === 'auto' ? '由内核每 300 秒自动测速选优' : '点成员可立即切换'}</span>
    </div>

    <div class="sc-members">
      ${visibleMembers.map((name) => html`<button key=${name} class="sc-pill" onClick=${async (e) => {
          e.stopPropagation();
          if (!S.core.running) return toast('mihomo 未运行，请先在首页连接', 'error');
          try {
            if (region.mode === 'auto') {
              const changed = await call('region:save', { region: { ...region, mode: 'select', selected: name, best: name } });
              if (!changed || !changed.ok) return;
              await call('core:apply');
            } else {
              await client.selectProxy(region.name, name);
            }
            await selectPolicy(region.name);
          } catch (err) { toast(err.message, 'error'); }
        }}>
          <span class="nm">${name}</span>
          <${Lat} ms=${dmap[name]} />
        </button>`)}
      ${members.length > 3
        ? html`<button class="btn ghost sm" onClick=${() => setExpanded(!expanded)}>
            ${expanded ? '收起' : `展开全部 ${region.nodes.length} 个`}
          </button>` : null}
    </div>

  </div>`;
}

function CustomStrat({ group, onEdit }) {
  const p = (S.runtime.proxies && S.runtime.proxies.proxies) || {};
  const g = p[group.name] || {};
  const now = g.now || '—';
  const dmap = delayMap();
  const members = g.all || g.proxies || [];
  const active = selectedPolicy() === group.name;
  const memberLabel = (m) => {
    if (m.startsWith('@region:')) return '地区 ' + (S.regions.find((r) => r.id === m.slice(8)) || {}).name;
    return m;
  };
  return html`<div class=${'card strat' + (active ? ' is-active' : '')}
    onClick=${(e) => { if (!e.target.closest('button')) selectPolicy(group.name); }}>
    <div class="sc-head">
      <div class="sc-id">
        <span class="ichi tint-indigo"><${Icon} name="strategy" /></span>
        <div><div class="sc-name">${group.name}</div>
        <div class="sc-type">${group.type === 'auto' ? 'url-test 自动' : group.type === 'fallback' ? 'fallback 回退' : 'select 手动'} · 自定义组</div></div>
      </div>
      <div class="sc-acts">
        <button class="mini" onClick=${() => onEdit(group)}><${Icon} name="edit" />编辑</button>
        <${Switch} on=${group.enabled !== false} onChange=${async (v) => {
          const next = S.state.groups.map((x) => x.id === group.id ? { ...x, enabled: v } : x);
          await call('group:save', { groups: next });
        }} />
      </div>
    </div>
    <div class="sc-current">
      <div class="sc-cur-row"><span class="sub">当前节点</span><span class="sc-cur-name grow">${now}</span><${Lat} ms=${dmap[now]} /></div>
      <span class="sub">${(group.members || []).length} 个成员 · ${group.type === 'auto' ? '自动测速选优' : '手动选择'}</span>
    </div>
    <div class="sc-members">
      ${(group.members || []).slice(0, 6).map((m) => html`<button key=${m} class="sc-pill"
              onClick=${async (e) => {
                e.stopPropagation();
                if (!S.core.running) return toast('mihomo 未运行，请先在首页连接', 'error');
                const target = m.startsWith('@region:') ? (S.regions.find((r) => r.id === m.slice(8)) || {}).name : m;
                if (!target) return;
                try { await client.selectProxy(group.name, target); toast(`已切到 ${target}`, 'ok'); } catch (e) { toast(e.message, 'error'); }
              }}>
        <span class="nm">${memberLabel(m)}</span>
      </button>`)}
      ${(group.members || []).length > 6 ? html`<span class="sub">+${(group.members || []).length - 6} 个</span>` : null}
    </div>
    <div class="sc-foot"><span class="okdot"></span><span>${S.state.settings.routingOptimize ? '规则可直接命中该组' : '规则命中该组'}</span>
      <span class="grow"></span>
      <button class="btn sm danger" onClick=${async () => {
        const next = S.state.groups.filter((x) => x.id !== group.id);
        await call('group:save', { groups: next });
        toast('已删除自定义组', 'ok');
      }}>删除</button>
    </div>
  </div>`;
}

function GroupModal({ initial, onClose }) {
  const g = initial || {};
  const [name, setName] = useState(g.name || '');
  const [type, setType] = useState(g.type || 'select');
  const [members, setMembers] = useState(g.members || []);
  const regions = S.regions;
  const targets = [...regions.map((r) => ({ v: '@region:' + r.id, label: `${r.flag} ${r.name} 组`, count: r.count }),
    { v: 'DIRECT', label: 'DIRECT 直连' })];
  const toggle = (v) => setMembers(members.includes(v) ? members.filter((m) => m !== v) : [...members, v]);

  const save = async () => {
    if (!name.trim()) return toast('请填写组名', 'error');
    const list = [...S.state.groups];
    const rec = { ...g, id: g.id || 'g_' + Date.now().toString(36), name: name.trim(), type, members, enabled: g.enabled !== false };
    const idx = list.findIndex((x) => x.id === rec.id);
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    const r = await call('group:save', { groups: list });
    if (r && r.ok) { toast('策略组已保存', 'ok'); onClose(); }
  };

  return html`<${Modal} title=${g.id ? '编辑自定义策略组' : '新建自定义策略组'} onClose=${onClose} width="620px" cls="glass-modal"
    foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" onClick=${save}>保存并生效</button>`}>
    <div class="row" style="gap:10px">
      <${Field} label="组名" style="flex:1"><${Input} value=${name} placeholder="例如：流媒体" onInput=${(e) => setName(e.target.value)} /></${Field}>
      <${Field} label="类型" style="width:180px">
        <select class="select" style="width:100%;height:32px" value=${type} onChange=${(e) => setType(e.target.value)}>
          <option value="select">select（手动）</option>
          <option value="auto">url-test（自动最快）</option>
          <option value="fallback">fallback（按序回退）</option>
        </select>
      </${Field}>
    </div>
    <span class="sub">成员可以是地区组（跨订阅自动聚合）或 DIRECT；地区组内依然可以再选具体节点。</span>
    <div class="card" style="padding:8px;display:flex;flex-direction:column;gap:4px">
      ${targets.map((t) => html`<button key=${t.v} class="node-row" style="border-radius:8px;border-bottom:0;min-height:36px" onClick=${() => toggle(t.v)}>
        <${Icon} name=${members.includes(t.v) ? 'check' : 'plus'} cls="ico-14" />
        <span class="node-name">${t.label}</span>
        ${t.count ? html`<span class="sub">${t.count} 个节点</span>` : null}
      </button>`)}
    </div>
    <span class="sub">已选 ${members.length} 个；规则目标可直接写组名。</span>
  </${Modal}>`;
}

function ProxyPanel() {
  const [source, setSource] = useState('all');
  const [region, setRegion] = useState('all');
  const [query, setQuery] = useState('');
  const dmap = delayMap();
  const main = (S.state.settings && S.state.settings.defaultTarget) || '主策略';
  const current = selectedPolicy();
  const sources = [];
  for (const n of S.nodes) {
    if (!sources.some((x) => x.id === (n.sourceId || 'local'))) sources.push({ id: n.sourceId || 'local', name: n.source || '本地节点' });
  }
  const regions = S.regions.filter((r) => r.count > 0);
  let list = (S.nodes || []).filter((n) => {
    if (source !== 'all' && (n.sourceId || 'local') !== source) return false;
    if (region !== 'all' && n.region !== region) return false;
    const q = query.trim().toLowerCase();
    return !q || n.name.toLowerCase().includes(q) || (n.type || '').toLowerCase().includes(q) || (n.source || '').toLowerCase().includes(q);
  });
  list = [...list].sort((a, b) => {
    const da = dmap[a.name]; const db = dmap[b.name];
    const va = Number.isFinite(da) && da > 0 ? da : Infinity;
    const vb = Number.isFinite(db) && db > 0 ? db : Infinity;
    return va - vb || a.name.localeCompare(b.name);
  });
  const shown = list;
  const measured = list.filter((n) => Number.isFinite(dmap[n.name]) && dmap[n.name] > 0).length;

  const selectNode = async (n) => {
    if (!S.core.running) return toast('mihomo 未运行，请先在首页连接', 'error');
    try {
      await client.selectProxy(main, n.name);
      toast(`已将「${main}」切换到 ${n.name}`, 'ok');
    } catch (e) { toast(`切换失败：${e.message}`, 'error'); }
  };

  return html`<div class="card proxy-panel">
    <div class="pp-head">
      <div class="pp-title"><span class="ichi tint-blue"><${Icon} name="server" /></span>
        <div><div class="sc-name">Proxy 面板</div><div class="sc-type">${list.length} 个节点 · 已测 ${measured} 个 · 切换写入「${main}」</div></div>
      </div>
      <div class="pp-tools">
        <${Search} value=${query} onInput=${setQuery} placeholder="按节点 / 类型过滤" style="width:200px" />
      </div>
    </div>
    <div class="pp-filters">
      <div class="pp-filter-row">
        <span class="pp-label">订阅</span>
        <${Chip} on=${source === 'all'} onClick=${() => setSource('all')}>全部 <span>${S.nodes.length}</span></${Chip}>
        ${sources.map((x) => html`<${Chip} key=${x.id} on=${source === x.id} onClick=${() => setSource(x.id)}>${x.name}</${Chip}>`)}
      </div>
      <div class="pp-filter-row">
        <span class="pp-label">地区</span>
        <${Chip} on=${region === 'all'} onClick=${() => setRegion('all')}>全部 <span>${S.nodes.length}</span></${Chip}>
        ${regions.map((r) => html`<${Chip} key=${r.id} on=${region === r.id} onClick=${() => setRegion(r.id)}>${r.flag} ${r.name}</${Chip}>`)}
      </div>
    </div>
    <div class="pp-head pp-cols">
      <span class="grow">节点</span><span class="pp-lat-h">延迟</span><span class="pp-action-h">操作</span>
    </div>
    <div class="pp-list">
      ${shown.map((n) => html`<div class=${'pp-row' + (n.name === current ? ' is-current' : '')} key=${n.name}>
        <span class="pp-node">
          <span class="nm">${n.name}</span>
          <span class="mt">${n.type || ''} · ${n.source || '本地节点'}${n.region ? ' · ' + ((S.regions.find((r) => r.id === n.region) || {}).name || '') : ''}</span>
        </span>
        <span class="pp-lat"><${Lat} ms=${dmap[n.name]} /></span>
        <button class=${'btn sm ' + (n.name === current ? 'ghost' : 'primary')} disabled=${n.name === current} onClick=${() => selectNode(n)}>
          ${n.name === current ? '当前' : '使用'}
        </button>
      </div>`)}
      ${!list.length ? html`<${Empty} icon="server" title="没有符合条件的节点" sub="换一个订阅、地区或搜索词。" />` : null}
    </div>
  </div>`;
}

export default function Groups() {
  const s = useStore();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [globalTesting, setGlobalTesting] = useState(false);
  const regionGroups = S.regions.filter((r) => r.enabled !== false && r.count > 0);
  const custom = S.state.groups || [];

  const findAndUseGlobalFastest = async () => {
    if (!S.core.running) return toast('mihomo 未运行，请先在首页连接', 'error');
    if (S.test && S.test.running) return toast('已有测速任务进行中', 'info');
    setGlobalTesting(true);
    try {
      const result = await call('test:start', { scope: 'all', url: (S.state.settings && S.state.settings.testUrl) || 'https://www.gstatic.com/generate_204' });
      const fastest = result && result.ok && result.summary && result.summary.fastest;
      if (!fastest) return toast('没有节点测速成功，未更改当前策略', 'error', 5000);
      const region = S.regions.find((r) => (r.nodes || []).includes(fastest.name));
      if (region) {
        const applied = await applyFastest(region, fastest.name);
        if (!applied || !applied.ok) return;
        await selectPolicy(region.name);
      } else {
        const main = (S.state.settings && S.state.settings.defaultTarget) || '主策略';
        await client.selectProxy(main, fastest.name);
        toast(`已将「${main}」切换到最快节点 ${fastest.name}`, 'ok');
      }
    } finally { setGlobalTesting(false); }
  };

  const goNodes = () => { setPage('nodes'); toast('已切到「节点」页，可在「订阅与本地节点」导入', 'info'); };

  return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
    <${PageHead} title="策略组"
      sub=${`${regionGroups.length} 个地区组 · ${custom.length} 个自定义组 · 主策略「${S.state.settings.defaultTarget}」`}>
      ${S.test && S.test.running
        ? html`<button class="btn sm" onClick=${() => cancelTest()}><${Spinner} />停止测速 ${S.test.done || 0}/${S.test.total || S.nodes.length}</button>`
        : html`<button class="btn sm groups-top-action" disabled=${!S.core.running || !S.nodes.length} onClick=${() => runAllTest()}>
            <${Icon} name="gauge" />全部测速
          </button>`}
      <button class="btn sm primary groups-top-action" disabled=${globalTesting || !!(S.test && S.test.running) || !S.core.running || !S.nodes.length} onClick=${findAndUseGlobalFastest}>
        ${globalTesting ? html`<${Spinner} />测速中 ${S.test && S.test.done || 0}/${S.test && S.test.total || S.nodes.length}` : html`<${Icon} name="gauge" />最快节点`}
      </button>
      <button class="btn sm primary groups-top-action" onClick=${() => setCreating(true)}><${Icon} name="plus" />新建策略组</button>
    </${PageHead}>

    <div class="row" style="gap:10px">
      <span class="sub grow">地区组按国家自动聚合，自定义组可再组合它们；点击卡片切换主策略。</span>
    </div>

    <div style="display:flex;flex-direction:column;gap:12px;min-height:0">
      <div class="card" style="padding:10px 16px;display:flex;align-items:center;gap:8px">
        <${Icon} name="info" cls="c-sub" />
        <span class="sub grow">地区组成员来自全部订阅 + 本地节点；主策略组收纳全部地区组、自定义组与 DIRECT。</span>
      </div>

      ${!regionGroups.length && !custom.length
        ? html`<${Empty} icon="strategy" title="还没有可用的策略组" sub="先导入订阅节点，或在下方 Proxy 面板选择具体节点。">
            <div class="row">
              <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" />新建策略组</button>
              <button class="btn" onClick=${goNodes}>去导入节点</button>
            </div>
          </${Empty}>`
        : html`<div class="strat-grid">
            ${regionGroups.map((r) => html`<${RegionStrat} key=${r.id} region=${r} />`)}
            ${custom.map((g) => html`<${CustomStrat} key=${g.id} group=${g} onEdit=${setEditing} />`)}
          </div>`}

      <${ProxyPanel} />

      ${creating ? html`<${GroupModal} onClose=${() => setCreating(false)} />` : null}
      ${editing ? html`<${GroupModal} initial=${editing} onClose=${() => setEditing(null)} />` : null}
    </div>
  </div>`;
}
