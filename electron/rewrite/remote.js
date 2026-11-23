'use strict';

/**
 * 线上重写规则集：解析 Quantumult X / Surge 常见 rewrite 行，
 * 转换成 Wallnut 现有 rewrites 规则结构（type/pattern/action/header/value/replacement）。
 *
 * 支持：
 *   ^https?://example\.com/ad url reject
 *   ^https?://example\.com/ad url reject-200
 *   ^https?://example\.com/ad url 302 https://example.com/new
 *   ^https?://example\.com url request-header set X-Foo bar
 *   ^https?://example\.com url request-header remove X-Foo
 *   ^https?://example\.com url response-header add X-Foo bar
 *   ^https?://example\.com url response-body "foo" "bar"
 * 未支持的脚本 / 请求体改写会跳过并计入 warnings。
 */

const RULE_TYPES = new Set(['reject', 'redirect', 'rewrite', 'request-header', 'response-header', 'response-body']);
const MAX_RULES = 3000;

/** 按空白切分，但保留引号内的空格与转义反斜杠（正则里的 \s、\ 需要原样保留） */
function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === '\\' && i + 1 < line.length) {
        cur += c + line[++i];
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function validPattern(pattern) {
  if (!pattern || pattern.length > 2000) return false;
  try { new RegExp(pattern); return true; } catch (_) { return false; }
}

function validHttpUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) { return false; }
}

/**
 * 解析一条 rewrite 行。返回 { rule } / { skip: '...' } / null（不是重写行）
 */
function parseRewriteLine(raw) {
  const line = String(raw || '').trim();
  if (!line) return null;
  if (line.startsWith('#') || line.startsWith('//') || line.startsWith(';') || line.startsWith('!')) return null;

  const tokens = tokenize(line);
  if (tokens.length < 3) return null;

  /* 去掉 url 关键字（QX / Surge 都写作「pattern url action ...」） */
  let idx = 1;
  if (String(tokens[1]).toLowerCase() === 'url') idx = 2;
  const pattern = tokens[0];
  const action = String(tokens[idx] || '').toLowerCase();
  if (!action) return null;

  if (!validPattern(pattern)) return { skip: `URL 正则无效：${pattern.slice(0, 60)}` };

  /* 拒绝 */
  if (action === 'reject' || action.startsWith('reject-')) {
    let code = '403';
    if (action === 'reject-200' || action === 'reject-204') code = '204';
    else if (action === 'reject-img' || action === 'reject-dict' || action === 'reject-array') {
      // 这些按内容类型返回占位内容的写法目前统一按 403 拒绝，避免放行广告请求
      code = '403';
    }
    return { rule: { type: 'reject', pattern, action: code, header: '', value: '', replacement: '', enabled: true } };
  }

  /* 重定向 */
  if (['301', '302', '303', '307', '308'].includes(action)) {
    const target = tokens[idx + 1] || '';
    if (!validHttpUrl(target)) return { skip: `重定向目标无效：${target.slice(0, 60)}` };
    return { rule: { type: 'redirect', pattern, action: target, header: '', value: '', replacement: '', enabled: true } };
  }

  /* 请求 / 响应头 */
  if (action === 'request-header' || action === 'response-header') {
    const op = String(tokens[idx + 1] || 'set').toLowerCase();
    const header = tokens[idx + 2] || '';
    if (!/^[A-Za-z0-9-]+$/.test(header)) return { skip: `Header 名称无效：${header.slice(0, 40)}` };
    const remove = ['remove', 'del', 'delete'].includes(op);
    const value = remove ? '' : tokens.slice(idx + 3).join(' ');
    return { rule: { type: action, pattern, action: remove ? 'remove' : 'set', header, value, replacement: '', enabled: true } };
  }

  /* 响应体文本替换 */
  if (action === 'response-body' || action === 'response-body-replace') {
    const search = tokens[idx + 1] || '';
    const replace = tokens.slice(idx + 2).join(' ');
    try { new RegExp(search); } catch (err) { return { skip: `响应体匹配正则无效：${search.slice(0, 60)}` }; }
    return { rule: { type: 'response-body', pattern, action: search, replacement: replace, header: '', value: '', enabled: true } };
  }

  /* QX 的 url rewrite：pattern url rewrite target（近似映射为 URL 重写） */
  if (action === 'rewrite' || action === 'url-rewrite') {
    const target = tokens[idx + 1] || '';
    if (!target) return { skip: 'URL 重写缺少目标' };
    return { rule: { type: 'rewrite', pattern, action: target, replacement: '', header: '', value: '', enabled: true } };
  }

  if (['request-body', 'script-request-header', 'script-response-header', 'script-response-body', 'script-request-body', 'echo-response', 'response-body-json'].includes(action)) {
    return { skip: `暂不支持 ${action} 类型的线上规则` };
  }
  return { skip: `未知重写动作：${action.slice(0, 40)}` };
}

/**
 * 解析规则集文本。
 * @param {string} text
 * @param {{setName?: string}} opts
 * @returns {{rules: object[], warnings: string[]}}
 */
function parseRewriteText(text, opts = {}) {
  const rules = [];
  const warnings = [];
  const lines = String(text || '').split(/\r?\n/);
  let section = '';
  let sawSection = false;
  for (let i = 0; i < lines.length && rules.length < MAX_RULES; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { sawSection = true; section = sec[1].trim().toLowerCase(); continue; }
    // 有分区时只解析 [rewrite] / [url rewrite] 段；无分区（纯规则列表）则全部解析
    if (sawSection && !/rewrite/.test(section)) continue;
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith(';') || line.startsWith('!')) continue;
    // Quantumult X 允许行尾注释
    line = line.replace(/\s+(#|;)\s.*$/, '');
    const parsed = parseRewriteLine(line);
    if (!parsed) {
      if (line.includes(' url ')) warnings.push(`第 ${i + 1} 行无法识别：${line.slice(0, 80)}`);
      continue;
    }
    if (parsed.skip) {
      if (warnings.length < 30) warnings.push(`第 ${i + 1} 行：${parsed.skip}`);
      continue;
    }
    if (!RULE_TYPES.has(parsed.rule.type)) continue;
    rules.push(parsed.rule);
  }
  if (rules.length >= MAX_RULES) warnings.push(`规则数超过上限 ${MAX_RULES}，已截断`);
  if (!rules.length && !warnings.length) warnings.push('未解析到任何 rewrite 行（需 QX/Surge 的 pattern + url + 动作写法）');
  return { rules, warnings };
}

module.exports = { parseRewriteText, parseRewriteLine, tokenize, MAX_RULES, RULE_TYPES };
