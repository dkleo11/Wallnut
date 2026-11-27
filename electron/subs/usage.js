'use strict';

/**
 * 订阅流量解析。
 *
 * 机场普遍把账户用量放在响应头 `subscription-userinfo` 里（Clash / Clash.Meta / Stash 同一套约定）：
 *   subscription-userinfo: upload=1024; download=2048; total=107374182400; expire=1764547200
 * 其中 expire 是 Unix 秒级时间戳，0 表示不过期；total 为 0 表示不限量。
 *
 * 注意：这套协议只有「订阅级」总量，没有「节点级」流量——机场并不会按节点分别计量，
 * 所以界面上展示的是该节点所属订阅的剩余额度。
 */

const DAY = 86400e3;

function toNum(v) {
  const n = Number(String(v == null ? '' : v).replace(/["'\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function webPageOf(headers) {
  const raw = headers['profile-web-page-url'] || headers['profile-web-page'] || '';
  return typeof raw === 'string' && /^https?:\/\//i.test(raw.trim()) ? raw.trim() : null;
}

/**
 * @param {Record<string, any>} headers Node 响应头（键名已小写）
 * @returns {null | {upload:number, download:number, used:number, total:number, remain:number|null,
 *   percent:number|null, expireAt:number|null, daysLeft:number|null, at:number, webPage:string|null}}
 */
function parseUserInfo(headers, now = Date.now()) {
  if (!headers || typeof headers !== 'object') return null;
  const raw = headers['subscription-userinfo'] || headers['subscription-user_info'] || headers['user-info'];
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const acc = { upload: 0, download: 0, total: 0, expire: 0 };
  let hit = false;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = toNum(part.slice(eq + 1));
    if (key === 'upload') { acc.upload = val; hit = true; }
    else if (key === 'download') { acc.download = val; hit = true; }
    else if (key === 'total') { acc.total = val; hit = true; }
    else if (key === 'expire') { acc.expire = val; hit = true; }
  }
  if (!hit) return null;

  // 极少数机场把 expire 写成毫秒，超过 1e12 说明已经是毫秒
  const expireAt = acc.expire > 0 ? (acc.expire > 1e12 ? acc.expire : acc.expire * 1000) : null;
  const used = acc.upload + acc.download;
  const hasTotal = acc.total > 0;
  const remain = hasTotal ? Math.max(0, acc.total - used) : null;
  const percent = hasTotal ? Math.min(100, Math.round((used / acc.total) * 1000) / 10) : null;
  const daysLeft = expireAt ? Math.ceil((expireAt - now) / DAY) : null;

  return {
    upload: acc.upload,
    download: acc.download,
    used,
    total: hasTotal ? acc.total : 0,
    remain,
    percent,
    expireAt,
    daysLeft,
    at: now,
    webPage: webPageOf(headers)
  };
}

/* ---------------- 信息节点（订阅里伪装成节点的账户信息） ---------------- */

/** 「162.84 GB」→ 字节（机场写 GB 通常是 GiB，与 subscription-userinfo 口径一致） */
function toBytes(num, unit) {
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  const u = String(unit || '').toUpperCase();
  const mul = u.startsWith('T') ? 1024 ** 4
    : u.startsWith('G') ? 1024 ** 3
      : u.startsWith('M') ? 1024 ** 2
        : u.startsWith('K') ? 1024 : 1;
  return Math.round(n * mul);
}

/** 抽剩余流量：兼容「剩余流量：162.84 GB」「剩余流量 500G」「流量剩余:1.5TB」 */
const RE_REMAIN = /(?:剩余流量|流量剩余|可用流量|剩余)\s*[:：]?\s*([\d.]+)\s*(TB|GB|MB|T|G|M)\b/i;
/** 距离下次重置：兼容「距离下次重置剩余：20 天」「下次重置：20天」「20 天后重置」 */
const RE_RESET = /(?:下次重置|重置剩余|流量重置)\s*(?:剩余)?\s*[:：]?\s*(\d+)\s*天/i;
const RE_RESET_AFTER = /(\d+)\s*天\s*后重置/;
/** 套餐到期：兼容「套餐到期：2027-04-16」「到期时间: 2027/4/16」「套餐到期：长期有效」 */
const RE_EXPIRE = /(?:套餐到期|到期时间|过期时间|有效期至|到期日期)\s*[:：]?\s*(.+)$/;
/** 官网 / 永久网址：抓域名 */
const RE_SITE = /(?:(?:永久|官方|发布)?网址|官网)\s*[:：]?\s*([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/i;

/**
 * 判定一个节点名是不是「信息节点 / 广告节点」。
 * 原则：宁可漏判也不能误删真节点——真节点里常见的「勿跑大流量」「2倍率」「[联通入口]」
 * 都不能命中下面的规则。
 */
const JUNK_PATTERNS = [
  // 账户信息
  /^(?:剩余流量|流量剩余|可用流量|剩余天数|剩余|距[离離]下次重置|下次重置|套餐到期|到期时间|过期时间|有效期至)/,
  // 官网 / 更新提示 / 公告
  /(?:永久网址|官方网址|发布网址|去官网|官网更新|更新订阅|订阅更新|建议每天|如果很少节点可用|若無法更新|若无法更新|無法使用|无法使用|使用说明|免责声明|客服联系|tg群|telegram群|电报群)/i
];

function looksLikeJunk(name) {
  const s = String(name || '');
  if (!s.trim()) return false;
  return JUNK_PATTERNS.some((re) => re.test(s));
}

/** 指向回环地址的「节点」一定是信息节点（真节点不可能让你连本机） */
function isLoopback(node) {
  const host = String((node && node.server) || '').toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '0.0.0.0';
}

function parseExpireText(text) {
  const t = String(text || '').trim();
  if (!t) return { expireAt: null, expireText: null };
  if (/长期|永久|无限|不过期|无期限|n\/a/i.test(t)) return { expireAt: null, expireText: '长期有效' };
  const m = t.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (!m) return { expireAt: null, expireText: t.slice(0, 24) };
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime();
  const norm = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return { expireAt: Number.isFinite(at) ? at : null, expireText: norm };
}

/**
 * 从订阅节点列表里分离出账户信息，并返回可用节点。
 * @param {Array<{name:string, server?:string}>} nodes
 * @returns {{nodes:Array, junk:string[], traffic:null|object, resetDays:number|null,
 *   expireAt:number|null, expireText:string|null, site:string|null}}
 */
function parseInfoNodes(nodes, now = Date.now()) {
  const list = Array.isArray(nodes) ? nodes : [];
  const keep = [];
  const junk = [];
  let remain = null;
  let resetDays = null;
  let expireAt = null;
  let expireText = null;
  let site = null;

  for (const n of list) {
    const name = String((n && n.name) || '');
    if (!looksLikeJunk(name) && !isLoopback(n)) { keep.push(n); continue; }
    junk.push(name);

    const rm = name.match(RE_REMAIN);
    if (rm) {
      const b = toBytes(rm[1], rm[2]);
      if (b != null) remain = b; // 有多条时取最后一条（后面的通常更新）
    }
    const rs = name.match(RE_RESET) || name.match(RE_RESET_AFTER);
    if (rs) resetDays = Number(rs[1]);
    const ex = name.match(RE_EXPIRE);
    if (ex) {
      const parsed = parseExpireText(ex[1]);
      if (parsed.expireAt) expireAt = parsed.expireAt;
      if (parsed.expireText) expireText = parsed.expireText;
    }
    const st = name.match(RE_SITE);
    if (st) site = st[1];
  }

  const hasInfo = remain != null || expireAt != null || Boolean(expireText) || resetDays != null;
  const traffic = hasInfo ? {
    upload: 0,
    download: 0,
    used: 0,
    total: 0,
    remain,
    percent: null,
    expireAt,
    daysLeft: expireAt ? Math.ceil((expireAt - now) / DAY) : null,
    at: now,
    webPage: site ? `https://${site}` : null,
    resetDays,
    expireText,
    site,
    source: 'node'
  } : null;

  return { nodes: keep, junk, traffic, resetDays, expireAt, expireText, site };
}

/**
 * 合并「响应头用量」与「信息节点用量」。
 * 响应头按实际流量算，是权威数据，保留其 upload/download/total/remain/percent；
 * 信息节点补充响应头里没有的周期信息（重置天数、到期文案、官网）。
 */
function mergeUsage(base, fromNodes) {
  if (!base && !fromNodes) return null;
  const out = base ? { ...base } : { ...fromNodes };
  if (fromNodes) {
    if (out.remain == null && fromNodes.remain != null) out.remain = fromNodes.remain;
    if (!out.total && fromNodes.total) out.total = fromNodes.total;
    if (fromNodes.resetDays != null) out.resetDays = fromNodes.resetDays;
    if (!out.expireAt && fromNodes.expireAt) {
      out.expireAt = fromNodes.expireAt;
      out.daysLeft = fromNodes.daysLeft;
    }
    if (fromNodes.expireText) out.expireText = fromNodes.expireText;
    if (fromNodes.site) out.site = fromNodes.site;
    if (!out.webPage && fromNodes.webPage) out.webPage = fromNodes.webPage;
    if (!out.at) out.at = fromNodes.at;
    if (base) {
      out.source = 'header+node';
      // 响应头按实际流量算，机场信息节点按额度算；差得明显时以响应头为准，
      // 但保留机场标称值供界面核对（倍率扣减会造成这种差异）。
      if (fromNodes.remain != null && out.remain != null
        && Math.abs(fromNodes.remain - out.remain) > Math.max(64 * 1024 * 1024, out.remain * 0.02)) {
        out.nodeRemain = fromNodes.remain;
      }
    } else {
      out.source = 'node';
    }
  } else if (base) {
    out.source = base.source || 'header';
  }
  return out;
}

function human(bytes) {
  const n = Number(bytes) || 0;
  const gb = 1024 * 1024 * 1024;
  if (n >= gb) return (n / gb).toFixed(n / gb >= 10000 ? 0 : 1) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

/** 一行文字描述，用于日志/通知 */
function describe(usage) {
  if (!usage) return '无流量信息';
  const left = usage.remain == null ? '不限量' : `剩余 ${human(usage.remain)}`;
  const cap = usage.total ? ` / ${human(usage.total)}` : '';
  const pct = usage.percent == null ? '' : `（已用 ${usage.percent}%）`;
  const reset = usage.resetDays != null ? `，${usage.resetDays} 天后重置` : '';
  const exp = usage.expireAt
    ? usage.daysLeft > 0 ? `，${usage.daysLeft} 天后到期` : '，已到期'
    : (usage.expireText && usage.expireText !== '长期有效' ? `，到期 ${usage.expireText}` : '');
  return left + cap + pct + reset + exp;
}

module.exports = { parseUserInfo, parseInfoNodes, mergeUsage, looksLikeJunk, isLoopback, describe, human };