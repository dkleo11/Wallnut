/* 日志：内核 stdout/stderr 兜底 + 控制器 WS 实时日志 */

import { html, Icon, Button, Search, Seg, Chip, Empty, PageHead, useStore, useState, useEffect, useRef } from '../ui.js';
import { S, call, toast, invoke } from '../store.js';

function parseLine(line) {
  const lv = (line.match(/level=(\w+)/) || [])[1];
  const msg = (line.match(/msg="([^"]*)"/) || [])[1] || line;
  return { level: lv || 'info', msg };
}

function hm(t) {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export default function Logs() {
  const s = useStore();
  const [source, setSource] = useState('all');
  const [level, setLevel] = useState('all');
  const [query, setQuery] = useState('');
  const [auto, setAuto] = useState(true);
  const boxRef = useRef(null);

  const entries = [];
  for (const l of S.logs || []) {
    const p = parseLine(l.line);
    entries.push({ t: l.t, level: p.level, msg: p.msg, source: 'core' });
  }
  for (const l of S.uiLogs || []) {
    entries.push({ t: l.t, level: l.level || 'info', msg: l.payload, source: 'api' });
  }
  entries.sort((a, b) => a.t - b.t);

  const filtered = entries.filter((e) => {
    if (source !== 'all' && e.source !== source) return false;
    if (level !== 'all' && e.level !== level) return false;
    if (query.trim() && !String(e.msg).toLowerCase().includes(query.trim().toLowerCase())) return false;
    return true;
  }).slice(-600);

  const counts = {};
  for (const e of entries) counts[e.level] = (counts[e.level] || 0) + 1;

  useEffect(() => {
    if (auto && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [filtered.length, auto]);

  return html`<div style="flex:1;min-height:0;display:flex;flex-direction:column;gap:10px">
    <${PageHead} title="日志" sub=${`${entries.length} 条 · 内核日志与控制器实时日志合并`}>
      <${Search} value=${query} onInput=${setQuery} placeholder="搜索关键字" style="width:200px" />
      <button class="btn sm" onClick=${async () => { await invoke('app:copyText', filtered.map((e) => `${hm(e.t)} [${e.level}] ${e.msg}`).join('\n')); toast('日志已复制', 'ok'); }}><${Icon} name="copy" />复制</button>
      <button class="btn sm" onClick=${() => setAuto(!auto)}><${Icon} name=${auto ? 'pause' : 'play'} />${auto ? '自动滚动' : '已暂停'}</button>
    </${PageHead}>

    <div class="chips logs-chips">
      <${Seg} value=${source} options=${[{ v: 'all', label: '全部来源' }, { v: 'core', label: '内核' }, { v: 'api', label: '实时 API' }]} onChange=${setSource} />
      <span class="chips-sep"></span>
      <${Chip} on=${level === 'all'} onClick=${() => setLevel('all')}>全部 <span>${entries.length}</span></${Chip}>
      ${['info', 'warning', 'error', 'debug'].map((lv) => html`<${Chip} key=${lv} on=${level === lv} onClick=${() => setLevel(lv)}>
        ${lv} <span>${counts[lv] || 0}</span>
      </${Chip}>`)}
    </div>

    <div class="card" style="flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden">
      <div class="rw-head"><span class="rw-title">实时输出</span><span class="rw-count">${filtered.length} 条</span>
        <span class="grow"></span>
        <span class="sub">${S.core.running ? '内核运行中 · 自动重连' : '内核未运行'}</span>
      </div>
      <div class="scroll log-list" ref=${boxRef} style="flex:1">
        ${!filtered.length
          ? html`<${Empty} icon="logs" title="还没有日志" sub="启动内核后，这里的日志会实时滚动；WS 只推新日志，历史由进程输出兜底。" />`
          : filtered.map((e, i) => html`<div class="log-line" key=${e.t + '-' + i}>
              <span class="log-time">${hm(e.t)}</span>
              <span class=${'log-lv ' + e.level}>${e.level.toUpperCase().slice(0, 5)}</span>
              <span class="log-msg">${e.msg}</span>
            </div>`)}
      </div>
    </div>
  </div>`;
}
