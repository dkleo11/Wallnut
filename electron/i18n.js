'use strict';

/* 主进程 i18n：与渲染层共用 resources/app/locales.json，按简体中文源串匹配。 */

const fs = require('fs');
const path = require('path');

let BUNDLE = { messages: {}, terms: {} };
try {
  BUNDLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales.json'), 'utf8'));
} catch (_) {}

const CJK = /[\u3400-\u9fff]/;
const VALID = new Set(['zh-CN', 'zh-Hant', 'ja', 'ko', 'en', 'fr', 'es']);
let current = 'zh-CN';
let termList = [];

function rebuild() {
  const terms = (BUNDLE.terms && BUNDLE.terms[current]) || {};
  termList = Object.keys(terms)
    .filter((k) => k && (k.length >= 2 || ['个','条','共','跨','分'].includes(k)))
    .sort((a, b) => b.length - a.length)
    .map((k) => [k, terms[k]]);
}

function setLanguage(lang) {
  current = VALID.has(lang) ? lang : 'zh-CN';
  rebuild();
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

function tr(value) {
  if (typeof value !== 'string' || current === 'zh-CN') return value;
  if (['en', 'fr', 'es'].includes(current) && (value === '「' || value === '」')) return value === '「' ? '“' : '”';
  if (!CJK.test(value)) return value;
  const m = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const lead = m ? m[1] : '';
  const core = m ? m[2] : value;
  const trail = m ? m[3] : '';
  if (!core) return value;
  const messages = (BUNDLE.messages && BUNDLE.messages[current]) || {};
  const exact = messages[core];
  if (exact) return lead + polish(exact) + trail;
  let out = core;
  for (const [src, dst] of termList) {
    if (out.includes(src)) out = out.split(src).join(dst);
  }
  if (['en', 'fr', 'es'].includes(current)) out = out.replace(/「/g, '“').replace(/」/g, '”');
  return lead + polish(out) + trail;
}

setLanguage('zh-CN');

module.exports = { setLanguage, getLanguage: () => current, tr };
