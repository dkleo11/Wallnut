'use strict';

const YAML = require('yaml');
const { detectRegion } = require('../regions');
const { dedupeNames } = require('../subs/parse');
const { isReservedName, sanitizeProxyName } = require('../util');

const MIRROR = 'https://gh-proxy.com/';
const GEOX = {
  geoip: MIRROR + 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb',
  mmdb: MIRROR + 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb',
  geosite: MIRROR + 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
  asn: MIRROR + 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb'
};

/** QX / Surge 规则写法 → mihomo 规则类型 */
const RULE_TYPE_MAP = {
  host: 'DOMAIN',
  'host-suffix': 'DOMAIN-SUFFIX',
  'host-keyword': 'DOMAIN-KEYWORD',
  'host-wildcard': 'DOMAIN-WILDCARD',
  domain: 'DOMAIN',
  'domain-suffix': 'DOMAIN-SUFFIX',
  'domain-keyword': 'DOMAIN-KEYWORD',
  'domain-wildcard': 'DOMAIN-WILDCARD',
  'domain-regex': 'DOMAIN-REGEX',
  'url-regex': 'DOMAIN-REGEX',
  geoip: 'GEOIP',
  geosite: 'GEOSITE',
  'ip-cidr': 'IP-CIDR',
  'ip6-cidr': 'IP-CIDR6',
  'ip-asn': 'IP-ASN',
  'src-ip-cidr': 'SRC-IP-CIDR',
  'dst-port': 'DST-PORT',
  'src-port': 'SRC-PORT',
  'process-name': 'PROCESS-NAME',
  'process-path': 'PROCESS-PATH',
  network: 'NETWORK',
  'user-agent': 'USER-AGENT',
  'rule-set': 'RULE-SET',
  match: 'MATCH',
  final: 'MATCH',
  and: 'AND',
  or: 'OR',
  not: 'NOT',
  'sub-rule': 'SUB-RULE',
  'in-type': 'IN-TYPE',
  'in-user': 'IN-USER',
  'in-name': 'IN-NAME'
};

const PRECISION = {
  DOMAIN: 0,
  'DOMAIN-REGEX': 1,
  'DOMAIN-WILDCARD': 1,
  'DOMAIN-SUFFIX': 2,
  'DOMAIN-KEYWORD': 3,
  'PROCESS-NAME': 4,
  'PROCESS-PATH': 4,
  GEOSITE: 5,
  'RULE-SET': 6,
  'IP-CIDR': 7,
  'IP-CIDR6': 7,
  GEOIP: 8,
  'IP-ASN': 9,
  MATCH: 99
};

function normalizeRule(r) {
  const type = RULE_TYPE_MAP[String(r.type || '').toLowerCase()] || String(r.type || '').toUpperCase();
  return { ...r, type };
}

/** 按"精度"重排（QX 的分流优化）：host > suffix > keyword > geoip/ip-cidr */
function optimizeRules(rules) {
  return rules
    .map((r, i) => ({ r, i, rank: PRECISION[r.type] === undefined ? 50 : PRECISION[r.type] }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((x) => x.r);
}

function collectNodes(state) {
  const regions = (state.regions || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const nodes = [];
  const regionOf = new Map();

  for (const sub of state.subscriptions || []) {
    if (sub.enabled === false) continue;
    for (const n of sub.nodes || []) {
      const clone = { ...n, _src: sub.name, _srcId: sub.id };
      nodes.push(clone);
    }
  }
  for (const n of state.localNodes || []) {
    if (n.enabled === false) continue;
    nodes.push({ ...n, _src: '本地节点', _srcId: 'local' });
  }

  // 名称去重（mihomo 不允许重名）
  const withNames = dedupeNames(nodes);
  const names = new Set(withNames.map((n) => n.name.toLowerCase()));

  for (const n of withNames) {
    const rid = detectRegion(n.name, regions);
    if (rid) regionOf.set(n.name, rid);
  }

  return { nodes: withNames, regionOf, regions, names };
}

function groupNameForRegion(region, used) {
  let base = region.name;
  if (isReservedName(base)) base = base + ' 组';
  let name = base;
  let i = 2;
  while (used.has(name)) { name = `${base} ${i++}`; }
  used.add(name);
  return name;
}

/**
 * 生成 mihomo 配置。
 * @param {object} state Wallnut state
 * @returns {{yaml:string, meta:object}}
 */
function buildConfig(state) {
  const s = state.settings;
  const collected = collectNodes(state);
  const { nodes, regionOf, regions } = collected;

  const usedNames = new Set(collected.names);
  const groupNames = [];
  const groups = [];
  const regionInfo = [];

  const mainName = sanitizeProxyName(s.defaultTarget || '主策略', '主策略');

  /* ---------- 地区组（跨订阅聚合，核心卖点 #1） ---------- */
  const regionGroups = [];
  for (const region of regions) {
    if (region.enabled === false) continue;
    const members = nodes.filter((n) => regionOf.get(n.name) === region.id).map((n) => n.name);
    if (!members.length) continue;
    const gname = groupNameForRegion(region, new Set([...usedNames, ...groupNames]));
    groupNames.push(gname);
    const g = {
      name: gname,
      type: region.mode === 'auto' ? 'url-test' : 'select',
      proxies: members,
      hidden: false
    };
    if (region.mode === 'auto') {
      g.url = s.testUrl;
      g.interval = 300;
      g.tolerance = 50;
      g.lazy = true;
    }
    if (region.selected && members.includes(region.selected)) {
      // select 组默认选中（mihomo 会通过 cache.db 记住实际选择）
      g.proxies = [region.selected, ...members.filter((m) => m !== region.selected)];
    }
    groups.push(g);
    regionGroups.push(gname);
    regionInfo.push({ id: region.id, name: region.name, flag: region.flag, group: gname, count: members.length, nodes: members, mode: region.mode || 'select' });
  }

  /* ---------- 自定义策略组 ---------- */
  const customGroups = [];
  for (const cg of state.groups || []) {
    if (cg.enabled === false) continue;
    const name = sanitizeProxyName(cg.name, '组');
    if (!name || isReservedName(name) || usedNames.has(name)) continue;
    const members = [];
    for (const m of cg.members || []) {
      if (typeof m === 'string' && m.startsWith('@region:')) {
        const rid = m.slice(8);
        const info = regionInfo.find((r) => r.id === rid);
        if (info) members.push(...info.nodes);
      } else if (regionGroups.includes(m) || groups.some((g) => g.name === m)) {
        members.push(m);
      } else if (collected.names.has(m.toLowerCase())) {
        members.push(m);
      }
    }
    if (!members.length) continue;
    const g = { name, type: cg.type === 'auto' ? 'url-test' : cg.type === 'fallback' ? 'fallback' : 'select', proxies: members };
    if (g.type !== 'select') { g.url = s.testUrl; g.interval = 300; g.tolerance = 50; g.lazy = true; }
    groups.push(g);
    customGroups.push(name);
  }

  /* ---------- 主策略组 ---------- */
  const mainMembers = [...regionGroups, ...customGroups, 'DIRECT'];
  groups.push({ name: mainName, type: 'select', proxies: mainMembers });

  /* ---------- 规则 ---------- */
  const targets = new Set([...regionGroups, ...customGroups, mainName, 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']);
  const allNodeNames = new Set(nodes.map((n) => n.name));
  const warn = [];

  const resolvedTarget = (t, fallback = mainName) => {
    const s0 = String(t || '').trim();
    if (!s0) return fallback;
    if (targets.has(s0)) return s0;
    if (allNodeNames.has(s0)) return s0;
    // 允许 QX 写法：地区名 / GROUP 名大小写差异
    const ci = [...targets].find((x) => x.toLowerCase() === s0.toLowerCase());
    if (ci) return ci;
    const ciNode = [...allNodeNames].find((x) => x.toLowerCase() === s0.toLowerCase());
    if (ciNode) return ciNode;
    warn.push(`规则目标 "${s0}" 不存在，已回落到 ${fallback}`);
    return fallback;
  };

  const localRules = [];
  for (const r of state.rules || []) {
    if (r.disabled) continue;
    const norm = normalizeRule(r);
    const payload = String(norm.payload || '').trim();
    if (!payload) continue;
    const extra = [];
    if (norm.params) extra.push(String(norm.params));
    if (['USER-AGENT', 'URL-REGEX'].includes(norm.type)) {
      warn.push(`mihomo 内核不支持 ${norm.type} 规则，已跳过：${payload}`);
      continue;
    }
    localRules.push(`${norm.type},${payload},${resolvedTarget(norm.target)}${extra.length ? ',' + extra.join(',') : ''}`);
  }

  const ruleProviders = {};
  const ruleSetRules = [];
  for (const rp of state.ruleProviders || []) {
    if (rp.enabled === false) continue;
    if (!rp.url) continue;
    const rname = 'rp_' + String(rp.id || rp.name).replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
    ruleProviders[rname] = {
      type: 'http',
      behavior: rp.behavior === 'ipcidr' ? 'ipcidr' : rp.behavior === 'classical' ? 'classical' : 'domain',
      url: rp.url,
      path: `./providers/${rname}.${rp.format === 'text' ? 'txt' : 'yaml'}`,
      interval: Number(rp.interval) > 0 ? Number(rp.interval) : 86400,
      // 许多公开 rule-provider 是纯文本行列表（format: text），硬编码 yaml 会让 mihomo 加载失败。
      format: rp.format === 'text' ? 'text' : 'yaml',
      proxy: 'DIRECT'
    };
    ruleSetRules.push(`RULE-SET,${rname},${resolvedTarget(rp.target)}`);
  }

  let rules = [...localRules, ...ruleSetRules];
  if (s.routingOptimize) rules = optimizeRules(rules.map((r) => ({ type: r.split(',')[0], payload: r })));
  rules = (s.routingOptimize ? rules.map((x) => x.payload) : rules);
  rules.push(`MATCH,${mainName}`);

  /* ---------- 基础段 ---------- */
  const config = {
    'mixed-port': Number(s.mixedPort) || 7890,
    'allow-lan': !!s.allowLan,
    'bind-address': '127.0.0.1',
    mode: ['rule', 'global', 'direct'].includes(s.mode) ? s.mode : 'rule',
    'log-level': s.logLevel || 'info',
    ipv6: !!s.ipv6,
    'external-controller': `127.0.0.1:${Number(s.controllerPort) || 9090}`,
    secret: String(s.secret || ''),
    'unified-delay': !!s.unifiedDelay,
    'tcp-concurrent': true,
    'find-process-mode': s.findProcessMode || 'off',
    // store-fake-ip 关闭：fake-ip 映射不落盘 cache.db，重启内核即自然清空，
    // 避免「昨天能用、今天还走旧 IP」；store-selected 保留，记住策略组选择。
    profile: { 'store-selected': true, 'store-fake-ip': false },
    'geox-url': GEOX,
    'geo-auto-update': false
  };

  if (s.tunEnabled) {
    config.tun = {
      enable: true,
      // 独立适配器名：mihomo 默认用 "Meta"，会和 Clash Verge 等服务模式的同名 wintun 适配器撞车
      // （对方清理/接管时会 TerminateProcess 掉占用者，表现为内核被外部杀掉后重启超时）。改成 Wallnut 互不干扰。
      device: 'Wallnut',
      stack: s.tunStack || 'gvisor',
      'auto-route': true,
      'auto-detect-interface': true,
      'strict-route': s.strictRoute !== false,
      // 完整排除 192.168/16，而非仅排除 192.168.1.x；例如 192.168.31.x 不进入 TUN。
      'route-exclude-address': ['192.168.0.0/16'],
      'dns-hijack': ['any:53']
    };
  }

  const dns = s.dns || {};
  if (dns.enabled !== false) {
    config.dns = {
      enable: true,
      ipv6: !!s.ipv6,
      'listen': '127.0.0.1:1053',
      'enhanced-mode': dns.fakeIp === false ? 'normal' : 'fake-ip',
      'fake-ip-range': dns.fakeIpRange || '198.18.0.1/16',
      'default-nameserver': ['223.5.5.5', '119.29.29.29'],
      nameserver: (dns.nameservers && dns.nameservers.length ? dns.nameservers : ['223.5.5.5', '119.29.29.29']),
      fallback: dns.fallback && dns.fallback.length ? dns.fallback : undefined,
      'fallback-filter': { geoip: true, 'geoip-code': 'CN' },
      'fake-ip-filter': ['*.lan', '*.local', 'localhost.ptlogin2.qq.com', '+.msftconnecttest.com', '+.msftncsi.com'],
      hosts: (dns.hosts || []).reduce((acc, h) => { if (h && h.domain && h.ip) acc[h.domain] = h.ip; return acc; }, {})
    };
  }

  config.proxies = nodes.map((n) => {
    const p = { ...n };
    delete p._src; delete p._srcId; delete p._region; delete p.enabled; delete p.id; delete p.updatedAt;
    const clean = {};
    for (const k of Object.keys(p)) if (k !== 'raw') clean[k] = p[k];
    return clean;
  });

  config['proxy-groups'] = groups;
  config.rules = rules;
  if (Object.keys(ruleProviders).length) config['rule-providers'] = ruleProviders;

  const yaml = YAML.stringify(config, { lineWidth: 0 });

  return {
    yaml,
    meta: {
      nodeCount: nodes.length,
      groupCount: groups.length,
      regions: regionInfo,
      regionGroups,
      mainGroup: mainName,
      customGroups,
      ruleCount: rules.length,
      ruleProviders: Object.keys(ruleProviders).length,
      warnings: warn,
      nodeNames: nodes.map((n) => n.name),
      regionOf: Object.fromEntries(regionOf)
    }
  };
}

module.exports = { buildConfig, collectNodes, optimizeRules, RULE_TYPE_MAP, GEOX };
