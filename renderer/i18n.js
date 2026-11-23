/* 轻量 i18n：文案以简体中文为源，运行时映射到目标语言。
   翻译数据由 resources/app/locales.json 提供，preload 注入 window.wallnutI18n。 */

const BUNDLE = (typeof window !== 'undefined' && window.wallnutI18n) || { messages: {}, terms: {} };

export const LANGUAGES = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-Hant', name: '繁體中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' }
];
const VALID = new Set(LANGUAGES.map((x) => x.code));
const CJK = /[\u3400-\u9fff]/;

let current = 'zh-CN';
let protectedStrings = [];
let termList = [];

function refs(lang) {
  const messages = (BUNDLE.messages && BUNDLE.messages[lang]) || {};
  const terms = (BUNDLE.terms && BUNDLE.terms[lang]) || {};
  return { messages, terms };
}

function rebuildTerms(lang) {
  const { terms } = refs(lang);
  termList = Object.keys(terms)
    .filter((k) => k && (k.length >= 2 || ['个','条','共','跨','分'].includes(k)))
    .sort((a, b) => b.length - a.length)
    .map((k) => [k, terms[k]]);
}

export function initLanguage() {
  let saved = '';
  try { saved = localStorage.getItem('wallnut.lang') || ''; } catch (_) {}
  setLanguage(VALID.has(saved) ? saved : 'zh-CN');
}

export function setLanguage(lang) {
  current = VALID.has(lang) ? lang : 'zh-CN';
  rebuildTerms(current);
  try { document.documentElement.lang = current; } catch (_) {}
}

export function getLanguage() { return current; }

export function setProtectedStrings(values) {
  const arr = Array.isArray(values) ? values : [];
  protectedStrings = arr.filter((v) => typeof v === 'string' && v.length >= 2);
  protectedStrings.sort((a, b) => b.length - a.length);
}

function maskProtected(text) {
  if (!protectedStrings.length) return { text, map: null };
  let out = text;
  let map = null;
  for (let i = 0; i < protectedStrings.length; i++) {
    const p = protectedStrings[i];
    if (p && out.includes(p)) {
      const token = '\uE000' + i + '\uE001';
      out = out.split(p).join(token);
      if (!map) map = [];
      map[i] = p;
    }
  }
  return { text: out, map };
}

function restoreProtected(text, map) {
  if (!map) return text;
  let out = text;
  for (let i = 0; i < map.length; i++) {
    if (map[i] != null) out = out.split('\uE000' + i + '\uE001').join(map[i]);
  }
  return out;
}

function polish(text) {
  if (current === 'zh-Hant') {
    return text
      .replace(/內核/g, '核心')
      .replace(/緩存/g, '快取')
      .replace(/用戶/g, '使用者')
      .replace(/密鑰/g, '金鑰')
      .replace(/便攜版/g, '免安裝版')
      .replace(/遠程/g, '遠端');
  }
  if (current === 'ja') return text.replace(/カーネル/g, 'コア');
  if (current === 'ko') return text.replace(/커널/g, '코어');
  return text;
}

/** 翻译一段 UI 文本；保留首尾空白，保护节点/订阅名不被误翻。 */
export function tr(value) {
  if (typeof value !== 'string' || current === 'zh-CN') return value;
  if (['en', 'fr', 'es'].includes(current) && (value === '「' || value === '」')) return value === '「' ? '“' : '”';
  if (!CJK.test(value)) return value;
  const m = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const lead = m ? m[1] : '';
  const core = m ? m[2] : value;
  const trail = m ? m[3] : '';
  if (!core) return value;
  if (protectedStrings.includes(core)) return value;
  const { messages } = refs(current);
  const exact = messages[core];
  if (exact) return lead + polish(exact) + trail;
  const masked = maskProtected(core);
  let out = masked.text;
  for (const [src, dst] of termList) {
    if (out.includes(src)) out = out.split(src).join(dst);
  }
  out = restoreProtected(out, masked.map);
  if (['en', 'fr', 'es'].includes(current)) out = out.replace(/「/g, '“').replace(/」/g, '”');
  return lead + polish(out) + trail;
}

const TEXT_PROPS = new Set(['title', 'placeholder', 'label', 'sub', 'note', 'hint', 'desc', 'alt']);
const ATTR_PROPS = new Set(['aria-label', 'aria-description']);
function localizeChildren(children) {
  if (typeof children === 'string') return tr(children);
  if (Array.isArray(children)) return children.map(localizeChildren);
  if (children && typeof children === 'object') return localizeVNode(children);
  return children;
}

export function localizeVNode(vnode) {
  if (typeof vnode === 'string') return tr(vnode);
  if (Array.isArray(vnode)) return vnode.map(localizeVNode);
  if (!vnode || typeof vnode !== 'object') return vnode;
  const props = vnode.props;
  if (!props) return vnode;
  if (props['data-no-i18n']) return vnode;
  const next = { ...props };
  if (Object.prototype.hasOwnProperty.call(next, 'children')) next.children = localizeChildren(next.children);
  for (const key of TEXT_PROPS) if (typeof next[key] === 'string') next[key] = tr(next[key]);
  for (const key of ATTR_PROPS) if (typeof next[key] === 'string') next[key] = tr(next[key]);
  if (Array.isArray(next.options)) {
    next.options = next.options.map((o) => (o && typeof o === 'object' && typeof o.label === 'string'
      ? { ...o, label: tr(o.label) } : o));
  }
  if (Array.isArray(next.steps)) {
    next.steps = next.steps.map((o) => (o && typeof o === 'object' && typeof o.label === 'string'
      ? { ...o, label: tr(o.label) } : o));
  }
  return { ...vnode, props: next };
}

initLanguage();
