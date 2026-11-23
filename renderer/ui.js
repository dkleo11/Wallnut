import { h, Fragment } from './vendor/preact.mjs';
import htm from './vendor/htm.mjs';
import { useState, useEffect, useCallback, useMemo, useRef } from './vendor/hooks.mjs';
import { localizeVNode } from './i18n.js';

const rawHtml = htm.bind(h);
export const html = (strings, ...values) => localizeVNode(rawHtml(strings, ...values));
export { h, Fragment, useState, useEffect, useCallback, useMemo, useRef };
export { useStore } from './store.js';

/* ------------------------------------------------------------------ */
/* 基础组件                                                            */
/* ------------------------------------------------------------------ */

export const Icon = ({ name, cls = '', style }) => html`<svg class=${'ico ' + cls} viewBox="0 0 24 24" style=${style}><use href=${'#i-' + name} /></svg>`;

export const Flag = ({ emoji, sm = false }) => html`<span class=${'flag-em' + (sm ? ' sm' : '')}>${emoji || '🌐'}</span>`;

/** 运行模式：三条短横线；规则分红/蓝/橙，全局纯蓝，直连纯橙。 */
export const Windmill = ({ mode = 'rule', size = 24 }) => {
  const blue = 'rgb(93, 183, 201)';
  const orange = 'rgb(220, 160, 59)';
  const colors = mode === 'global' ? [blue, blue, blue]
    : mode === 'direct' ? [orange, orange, orange]
    : ['rgb(200, 44, 37)', blue, orange];
  return html`<svg class="windmill mode-lines" viewBox="0 0 24 24" style=${{ width: size + 'px', height: size + 'px' }} aria-hidden="true">
    ${colors.map((color, i) => html`<path d=${`M5 ${6 + i * 6}h14`} stroke=${color} stroke-width="2.6" stroke-linecap="round" fill="none" />`)}
  </svg>`;
};

export const Switch = ({ on, onChange, sm = true, title }) => html`<button
  class=${'switch' + (on ? ' on' : '') + (sm ? ' sm' : '')} title=${title}
  aria-checked=${on ? 'true' : 'false'} role="switch"
  onClick=${(e) => { e.stopPropagation(); onChange && onChange(!on); }}></button>`;

export const Button = ({ children, primary, danger, ghost, sm, icon, onClick, disabled, title, style }) => html`<button
  class=${'btn' + (primary ? ' primary' : '') + (danger ? ' danger' : '') + (ghost ? ' ghost' : '') + (sm ? ' sm' : '')}
  onClick=${onClick} disabled=${disabled} title=${title} style=${style}>
  ${icon ? html`<${Icon} name=${icon} />` : null}${children}
</button>`;

export const Chip = ({ children, on, onClick, cls = '' }) => html`<button class=${'chip' + (on ? ' on' : '') + ' ' + cls} onClick=${onClick}>${children}</button>`;

export const Seg = ({ value, options, onChange }) => html`<div class="seg">
  ${options.map((o) => html`<button key=${o.v} class=${value === o.v ? 'on' : ''} onClick=${() => onChange && onChange(o.v)}>${o.label}</button>`)}
</div>`;

export const Card = ({ children, cls = '', style, onClick }) => html`<div class=${'card ' + cls} style=${style} onClick=${onClick}>${children}</div>`;

export const PageHead = ({ title, sub, children }) => html`<div class="pagehead">
  <div class="ph-left"><span class="ph-title">${title}</span>${sub ? html`<span class="ph-sub">${sub}</span>` : null}</div>
  <div class="row">${children}</div>
</div>`;

export const Tag = ({ children, cls = 'type' }) => html`<span class=${'tag ' + cls}>${children}</span>`;

export const Lat = ({ ms, text }) => {
  if (text !== undefined) return html`<span class="lat none">${text}</span>`;
  if (ms === null || ms === undefined) return html`<span class="lat none">—</span>`;
  if (ms === false || ms < 0) return html`<span class="lat bad">超时</span>`;
  const cls = ms < 120 ? 'ok' : ms < 300 ? 'warn' : 'warn';
  return html`<span class=${'lat ' + cls}>${ms}ms</span>`;
};

export const Search = ({ value, onInput, placeholder, cls = '', style }) => html`<div class=${'search ' + cls} style=${style}>
  <${Icon} name="search" />
  <input value=${value} placeholder=${placeholder || '搜索'} onInput=${(e) => onInput && onInput(e.target.value)} />
</div>`;

export const Field = ({ label, children, style }) => html`<div class="field" style=${style}>
  ${label ? html`<span class="field-label">${label}</span>` : null}${children}
</div>`;

export const Input = ({ value, onInput, onChange, placeholder, type = 'text', style, cls = '', readOnly, disabled, onBlur, onKeyDown }) => html`<input
  class=${'input ' + cls} style=${style} type=${type} value=${value} placeholder=${placeholder}
  readOnly=${readOnly} disabled=${disabled} onInput=${onInput} onChange=${onChange} onBlur=${onBlur} onKeyDown=${onKeyDown} />`;

export const Textarea = ({ value, onInput, placeholder, style, cls = '', readOnly, rows }) => html`<textarea
  class=${'textarea ' + cls} style=${style} value=${value} placeholder=${placeholder} readOnly=${readOnly} rows=${rows}
  onInput=${onInput}></textarea>`;

export const Empty = ({ icon = 'folder', title, sub, children }) => html`<div class="empty">
  <${Icon} name=${icon} />
  ${title ? html`<span class="empty-title">${title}</span>` : null}
  ${sub ? html`<span class="empty-sub">${sub}</span>` : null}
  ${children}
</div>`;

export const Spinner = ({ cls = '' }) => html`<span class=${'spin ' + cls} style="display:inline-flex"><${Icon} name="refresh" cls="ico-14" /></span>`;

export const Modal = ({ title, onClose, children, foot, width, cls = '' }) => html`<div class="overlay" onClick=${onClose}>
  <div class=${'modal ' + cls} style=${width ? { width } : undefined} onClick=${(e) => e.stopPropagation()}>
    <div class="modal-head">
      <span class="modal-title">${title}</span>
      <button class="btn ghost sm" onClick=${onClose}><${Icon} name="x" /></button>
    </div>
    <div class="modal-body">${children}</div>
    ${foot ? html`<div class="modal-foot">${foot}</div>` : null}
  </div>
</div>`;

export const ToastHost = ({ toasts = [] }) => html`<div class="toast-host">
  ${toasts.map((t) => html`<div key=${t.id} class=${'toast ' + (t.kind === 'error' ? 'error' : t.kind === 'ok' ? 'ok' : '')}>
    <${Icon} name=${t.kind === 'error' ? 'alert' : t.kind === 'ok' ? 'check' : 'info'} />
    <span>${t.message}</span>
  </div>`)}
</div>`;

export const Dot = ({ color = 'var(--sub)' }) => html`<span style=${{ width: '6px', height: '6px', borderRadius: '50%', background: color, flex: 'none', display: 'inline-block' }}></span>`;

export const KV = ({ k, v }) => html`<div class="sc-prop"><span>${k}</span><b>${v}</b></div>`;

/** 数字与单位格式化 */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return { v: String(Math.round(v)), u: 'B' };
  if (v < 1024 * 1024) return { v: (v / 1024).toFixed(1), u: 'KB' };
  if (v < 1024 * 1024 * 1024) return { v: (v / 1024 / 1024).toFixed(1), u: 'MB' };
  return { v: (v / 1024 / 1024 / 1024).toFixed(2), u: 'GB' };
}

export function fmtSpeed(bytesPerSec) {
  const v = Number(bytesPerSec) || 0;
  if (v < 1024) return { v: String(Math.round(v)), u: 'B/s' };
  if (v < 1024 * 1024) return { v: (v / 1024).toFixed(1), u: 'KB/s' };
  return { v: (v / 1024 / 1024).toFixed(1), u: 'MB/s' };
}

export function timeAgo(ts) {
  if (!ts) return '从未';
  const d = Date.now() - Number(ts);
  if (d < 0) return '刚刚';
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  return Math.floor(d / 86400e3) + ' 天前';
}

export function fmtDuration(ms) {
  if (!ms) return '0 分钟';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${String(m).padStart(2, '0')} 分`;
  return `${m} 分钟`;
}
