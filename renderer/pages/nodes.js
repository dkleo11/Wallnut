/* 节点页：分段「节点 / 订阅与本地节点」；节点段为搜索 + 地区筛选 + 分组节点表 + 批量测速（对应原型画板 02） */

import { html, Icon, Chip, PageHead, Search, Tag, Lat, Empty, Spinner, useStore, useState } from '../ui.js';
import { S, call, toast, runAllTest, cancelTest, delayMap } from '../store.js';
import { SubsPanel } from './subs.js';

/* 兼容外壳顶栏的订阅入口；页面已合并为单一的「订阅与本地节点」 */
export function focusNodesTab() {}

function sourceGroups(nodes) {
  const map = new Map();
  for (const n of nodes) {
    const key = n.sourceId || 'local';
    if (!map.has(key)) {
      /* 本地节点不显示后端的分段名（server_local），统一叫「本地节点」 */
      const isLocal = key === 'local' || /server[_\s-]?local/i.test(n.source || '');
      map.set(key, { id: key, name: isLocal ? '本地节点' : (n.source || '本地节点'), nodes: [] });
    }
    map.get(key).nodes.push(n);
  }
  return [...map.values()];
}

export default function Nodes() {
  const s = useStore();
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('all');
  const [sortDelay, setSortDelay] = useState(false);
  const [localDelay, setLocalDelay] = useState({});
  const [testing, setTesting] = useState({});
  const [collapsed, setCollapsed] = useState({});

  const mainGroup = (S.state && S.state.settings.defaultTarget) || '主策略';
  const dmap = { ...delayMap(), ...localDelay };
  const now = (S.runtime.proxies && S.runtime.proxies.proxies && S.runtime.proxies.proxies[mainGroup] || {}).now;

  const regionFlags = {};
  for (const r of S.regions) regionFlags[r.id] = r.flag;
  const regionNames = {};
  for (const r of S.regions) regionNames[r.id] = r.name;

  let list = S.nodes.filter((n) => {
    if (region !== 'all' && n.region !== region) return false;
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return n.name.toLowerCase().includes(q) || (n.type || '').toLowerCase().includes(q)
      || (n.source || '').toLowerCase().includes(q) || (regionNames[n.region] || '').toLowerCase().includes(q);
  });

  if (sortDelay) {
    list = [...list].sort((a, b) => {
      const da = dmap[a.name]; const db = dmap[b.name];
      const va = da && da > 0 ? da : 1e9; const vb = db && db > 0 ? db : 1e9;
      return va - vb;
    });
  }

  const groups = sourceGroups(list);
  const total = list.length;
  const measured = list.filter((n) => dmap[n.name] && dmap[n.name] > 0).length;
  const fastest = list.reduce((best, n) => {
    const d = dmap[n.name];
    if (!d || d <= 0) return best;
    return !best || d < best.delay ? { name: n.name, delay: d } : best;
  }, null);

  const testOne = async (n) => {
    setTesting((t) => ({ ...t, [n.name]: true }));
    const r = await call('test:one', { name: n.name }, { silent: true });
    setTesting((t) => ({ ...t, [n.name]: false }));
    if (r && r.ok) setLocalDelay((d) => ({ ...d, [n.name]: r.delay }));
    else toast(`${n.name} 测速失败：${r.error || '超时'}`, 'error');
  };

  const subsCount = (S.state && S.state.subscriptions || []).length;
  const localCount = (S.state && S.state.localNodes || []).length;
  const headSub = `${S.nodes.length} 个节点 · ${subsCount} 个订阅 · ${localCount} 个本地节点 · 主策略「${mainGroup}」`;

  return html`<div class="nodes-page">
    <${PageHead} title="订阅与本地节点" sub=${`${S.nodes.length} 个可用节点 · ${S.regions.filter((r) => r.count > 0).length} 个地区 · 主策略「${mainGroup}」`} />


    <${SubsPanel} />

    <div class="node-pane card">
        <div class="np-head">
          <div class="np-title">
            <span>全部节点</span>
            <span class="np-count">${S.nodes.length}</span>
          </div>
          <div class="np-actions">
            <${Search} cls="node" value=${query} onInput=${setQuery} placeholder="搜索节点、协议或地区" style="width:230px;height:32px" />
            ${S.test && S.test.running
              ? html`<button class="btn primary sm" onClick=${() => cancelTest()}><${Spinner} />停止 ${S.test.done}/${S.test.total}</button>`
              : html`<button class="btn primary sm" disabled=${!S.core.running || !S.nodes.length} onClick=${() => runAllTest()}>
                  <${Icon} name="gauge" />批量测速
                </button>`}
          </div>
        </div>

        <div class="np-regions">
          <${Chip} on=${region === 'all'} onClick=${() => setRegion('all')}>全部 <span>${S.nodes.length}</span></${Chip}>
          ${S.regions.filter((r) => r.count > 0).map((r) => html`<${Chip} key=${r.id} on=${region === r.id} onClick=${() => setRegion(r.id)}>
            ${r.flag} ${r.name} <span>${r.count}</span>
          </${Chip}>`)}
        </div>

        <div class="np-body">
          ${!S.nodes.length
            ? html`<${Empty} icon="node" title="还没有节点" sub="在左侧添加订阅，或导入本地节点。" />`
            : !groups.length
              ? html`<div class="np-empty">没有匹配的节点，换一个搜索词或地区试试。</div>`
              : groups.map((g) => html`<div class="np-group" key=${g.id}>
                  <div class="grouphead">
                    <button class="gh-left" onClick=${() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))} style="background:none">
                      <${Icon} name="chev" style=${collapsed[g.id] ? 'transform:rotate(-90deg);transition:transform .15s' : 'transition:transform .15s'} />
                      <${Icon} name="server" />
                      <span class="gh-name">${g.name}</span>
                      <span class="gh-meta">${g.nodes.length} 个节点</span>
                    </button>
                  </div>
                  ${collapsed[g.id] ? null : html`<div class="node-card card">
                    <div class="node-list">
                      ${g.nodes.map((n) => {
                        const d = dmap[n.name];
                        const selected = now === n.name;
                        return html`<div key=${n.name} class=${'node-row' + (selected ? ' sel' : '')}>
                          ${selected ? html`<span class="selbar"></span>` : null}
                          <span class="flag-em">${regionFlags[n.region] || '🌐'}</span>
                          <span class=${'node-name' + (selected ? ' on' : '')}>${n.name}</span>
                          <span class="node-tags">
                            <${Tag}>${(n.type || '').toUpperCase()}</${Tag}>
                            ${n.udp ? html`<${Tag} cls="udp">UDP</${Tag}>` : null}
                          </span>
                          <${Lat} ms=${d} />
                          <button class="btn ghost sm" title="单独测速" onClick=${() => testOne(n)}>
                            ${testing[n.name] ? html`<${Spinner} />` : html`<${Icon} name="gauge" />`}
                          </button>
                        </div>`;
                      })}
                    </div>
                  </div>`}
                </div>`)}
        </div>

        <div class="np-bar">
          <div class="lb-left">
            <span class="lb-dot" style=${S.core.running ? 'background:var(--green)' : ''}></span>
            <strong>${total}</strong> 个节点
            <span class="sb-dot"></span>
            <span>已测 <strong>${measured}</strong></span>
            <span class="sb-dot"></span>
            <span>${fastest ? html`最快 <strong>${fastest.name}</strong> · ${fastest.delay}ms` : '未测速'}</span>
          </div>
          <div class="lb-right">
            <span class="np-current">当前 ${now || '—'}</span>
            <button class="btn sm" onClick=${() => setSortDelay(!sortDelay)}>
              <${Icon} name="filter" />${sortDelay ? '按延迟' : '按名称'}
            </button>
            <button class="btn sm" onClick=${async () => { await call('dns:flush'); toast('DNS 缓存已清空', 'ok'); }}>清缓存</button>
          </div>
        </div>
    </div>
  </div>`;
}
