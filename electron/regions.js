'use strict';

/**
 * 地区（固定国家）识别：国旗 emoji + 中英文关键词。
 * regions 存于 state，用户可在 UI 里改关键词 / 新增地区。
 */

const REGION_PRESETS = [
  { id: 'hk', name: '香港', flag: '🇭🇰', keywords: ['香港', '港区', 'HK', 'Hong Kong', 'HongKong'] },
  { id: 'tw', name: '台湾', flag: '🇹🇼', keywords: ['台湾', '台灣', '台北', 'TW', 'Taiwan', 'Taipei'] },
  { id: 'jp', name: '日本', flag: '🇯🇵', keywords: ['日本', '东京', '大阪', 'JP', 'Japan', 'Tokyo', 'Osaka'] },
  { id: 'sg', name: '新加坡', flag: '🇸🇬', keywords: ['新加坡', '狮城', 'SG', 'Singapore'] },
  { id: 'us', name: '美国', flag: '🇺🇸', keywords: ['美国', '洛杉矶', '圣何塞', '硅谷', '芝加哥', '纽约', '西雅图', '达拉斯', 'US', 'USA', 'United States', 'Los Angeles', 'San Jose', 'Seattle', 'New York', 'Dallas', 'Chicago'] },
  { id: 'kr', name: '韩国', flag: '🇰🇷', keywords: ['韩国', '首尔', 'KR', 'Korea', 'Seoul'] },
  { id: 'gb', name: '英国', flag: '🇬🇧', keywords: ['英国', '伦敦', 'UK', 'GB', 'Britain', 'London'] },
  { id: 'de', name: '德国', flag: '🇩🇪', keywords: ['德国', '法兰克福', 'DE', 'Germany', 'Frankfurt'] },
  { id: 'fr', name: '法国', flag: '🇫🇷', keywords: ['法国', '巴黎', 'FR', 'France', 'Paris'] },
  { id: 'nl', name: '荷兰', flag: '🇳🇱', keywords: ['荷兰', '阿姆斯特丹', 'NL', 'Netherlands', 'Amsterdam'] },
  { id: 'ru', name: '俄罗斯', flag: '🇷🇺', keywords: ['俄罗斯', '莫斯科', 'RU', 'Russia', 'Moscow'] },
  { id: 'au', name: '澳大利亚', flag: '🇦🇺', keywords: ['澳大利亚', '澳洲', '悉尼', 'AU', 'Australia', 'Sydney'] },
  { id: 'ca', name: '加拿大', flag: '🇨🇦', keywords: ['加拿大', '多伦多', 'CA', 'Canada', 'Toronto'] },
  { id: 'in', name: '印度', flag: '🇮🇳', keywords: ['印度', '孟买', 'IN', 'India', 'Mumbai'] },
  { id: 'my', name: '马来西亚', flag: '🇲🇾', keywords: ['马来西亚', '吉隆坡', 'MY', 'Malaysia', 'Kuala Lumpur'] },
  { id: 'th', name: '泰国', flag: '🇹🇭', keywords: ['泰国', '曼谷', 'TH', 'Thailand', 'Bangkok'] },
  { id: 'vn', name: '越南', flag: '🇻🇳', keywords: ['越南', 'VN', 'Vietnam'] },
  { id: 'ph', name: '菲律宾', flag: '🇵🇭', keywords: ['菲律宾', '马尼拉', 'PH', 'Philippines', 'Manila'] },
  { id: 'tr', name: '土耳其', flag: '🇹🇷', keywords: ['土耳其', '伊斯坦布尔', 'TR', 'Turkey', 'Istanbul'] },
  { id: 'ae', name: '阿联酋', flag: '🇦🇪', keywords: ['阿联酋', '迪拜', 'AE', 'UAE', 'Dubai'] },
  { id: 'br', name: '巴西', flag: '🇧🇷', keywords: ['巴西', '圣保罗', 'BR', 'Brazil', 'Sao Paulo'] },
  { id: 'ar', name: '阿根廷', flag: '🇦🇷', keywords: ['阿根廷', 'AR', 'Argentina'] }
];

/** 默认启用的地区组（QX 常见六区） */
const DEFAULT_REGION_IDS = ['hk', 'jp', 'sg', 'us', 'tw', 'kr'];

function flagToCode(flag) {
  const cps = Array.from(String(flag || ''));
  if (cps.length !== 2) return null;
  const a = cps[0].codePointAt(0) - 0x1f1e6;
  const b = cps[1].codePointAt(0) - 0x1f1e6;
  if (a < 0 || a > 25 || b < 0 || b > 25) return null;
  return String.fromCharCode(65 + a) + String.fromCharCode(65 + b);
}

function codeToFlag(code) {
  const s = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return '';
  return String.fromCodePoint(0x1f1e6 + s.charCodeAt(0) - 65, 0x1f1e6 + s.charCodeAt(1) - 65);
}

function regionFlag(region) {
  if (!region) return '';
  if (region.flag) return region.flag;
  const code = codeToFlag(region.code || '');
  return code;
}

/** 默认地区配置（state 初始化用） */
function defaultRegions() {
  return REGION_PRESETS.filter((r) => DEFAULT_REGION_IDS.includes(r.id)).map((r, i) => ({
    ...r,
    enabled: true,
    order: i,
    mode: 'select', // select = 手动（测速后应用最快）；auto = url-test 自动选优
    selected: null,
    best: null
  }));
}

function allPresets() {
  return REGION_PRESETS.map((r) => ({ ...r }));
}

/**
 * 从节点名推断地区。
 * @param {string} name 节点名
 * @param {Array} regions state.regions（含 keywords）
 * @returns {string|null} region.id
 */
function detectRegion(name, regions) {
  const raw = String(name || '');
  const lower = raw.toLowerCase();

  // 1) 国旗 emoji 优先（最可靠）
  const cps = Array.from(raw);
  for (let i = 0; i < cps.length - 1; i++) {
    const code = flagToCode(cps[i] + cps[i + 1]);
    if (!code) continue;
    const byCode = regions.find((r) => String(r.code || '').toUpperCase() === code);
    if (byCode) return byCode.id;
  }

  // 2) 关键词（长关键词优先，避免 "US" 命中 "Russia"）
  for (const r of regions) {
    const kws = (r.keywords || []).map((k) => String(k)).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const kw of kws) {
      const k = kw.toLowerCase();
      if (!k) continue;
      // 纯 ASCII 关键词要求词边界，避免 "hk" 命中 "shark"
      if (/^[a-z0-9]+$/.test(k)) {
        const re = new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`, 'i');
        if (re.test(lower)) return r.id;
      } else if (lower.includes(k)) {
        return r.id;
      }
    }
  }
  return null;
}

/** 生成 url-test 组用的 filter 正则（对节点名） */
function regionFilter(region) {
  const kws = (region.keywords || []).filter(Boolean);
  if (!kws.length) return '(?!x)x';
  const parts = kws.map((k) => {
    const esc = String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[a-zA-Z0-9]+$/.test(k) ? `(?i)(?:^|[^a-zA-Z0-9])${esc}(?:[^a-zA-Z0-9]|$)` : `(?i)${esc}`;
  });
  return parts.join('|');
}

module.exports = { REGION_PRESETS, DEFAULT_REGION_IDS, defaultRegions, allPresets, detectRegion, regionFilter, flagToCode, codeToFlag, regionFlag };
