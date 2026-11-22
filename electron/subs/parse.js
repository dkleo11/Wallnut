'use strict';

const YAML = require('yaml');
const { sanitizeProxyName } = require('../util');

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function decodeB64(str) {
  try {
    let s = String(str || '').trim().replace(/\s+/g, '');
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
  } catch (_) {
    return null;
  }
}

function tryB64(str) {
  try {
    let s = String(str || '').trim().replace(/\s+/g, '');
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const out = Buffer.from(s, 'base64').toString('utf8');
    // 只有确实是 base64 内容时才返回（避免把普通文本误判）
    if (/[^\x00-\x7F]/.test(out) || out.includes('://') || out.includes('proxies:')) return out;
    return null;
  } catch (_) {
    return null;
  }
}

function qsParse(u) {
  const out = {};
  (u.searchParams || new URLSearchParams(u.query || '')).forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

function toBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return /^(1|true|yes|on)$/i.test(v);
  return false;
}

function toNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 只保留 mihomo 能接受的 proxy 字段，防止订阅里夹带奇怪键 */
const PROXY_KEYS = new Set([
  'name', 'type', 'server', 'port', 'username', 'password', 'uuid', 'alterId', 'cipher',
  'udp', 'tls', 'sni', 'servername', 'skip-cert-verify', 'network', 'ws-opts', 'grpc-opts',
  'http-opts', 'h2-opts', 'reality-opts', 'client-fingerprint', 'flow', 'plugin', 'plugin-opts',
  'obfs', 'obfs-password', 'obfs-param', 'up', 'down', 'protocol', 'protocol-param', 'auth',
  'server-cert-fingerprint', 'ip-version', 'interface-name', 'routing-mark', 'packet-encoding',
  'ports', 'hop-interval', 'peers', 'dialer-proxy', 'smux', 'alpn', 'public-key', 'short-id',
  'ca', 'ca-str', 'ec-opts', 'udp-relay-mode', 'congestion-controller', 'heartbeat-interval',
  'tls-cert', 'tls-key', 'auth-type', 'congestion-control', 'reduce-rtt', 'disable-sni',
  'fingerprint', 'global-padding', 'authenticated-length', 'recv-window-conn', 'recv-window',
  'request', 'cipher-suites', 'ech-opts', 'idle-session-timeout', 'disable-mtu-discovery',
  'hop-interval', 'health-check', 'tfo', 'mptcp', 'early-data', 'quic', 'wireguard'
]);

function sanitizeProxy(p, fallbackName) {
  const out = {};
  for (const k of Object.keys(p)) {
    if (PROXY_KEYS.has(k) && p[k] !== undefined && p[k] !== null) out[k] = p[k];
  }
  out.name = sanitizeProxyName(out.name, fallbackName);
  if (!out.type || !out.server || !(out.port > 0)) return null;
  out.type = String(out.type).toLowerCase();
  out.port = toNum(out.port, 0);
  if (out.type === 'ss') {
    if (!out.cipher) return null;
  }
  if (['vmess', 'vless'].includes(out.type)) {
    if (!out.uuid) return null;
    out.alterId = toNum(out.alterId, 0);
  }
  if (out.type === 'trojan' && !out.password) return null;
  if (!out.udp) out.udp = true;
  return out;
}

/* ------------------------------------------------------------------ */
/* URI 解析（ss / vmess / vless / trojan / hysteria2 / tuic / socks5）  */
/* ------------------------------------------------------------------ */

function parseSs(uri, fallbackName) {
  let rest = uri.slice(5);
  let tag = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    tag = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const qIndex = rest.indexOf('?');
  const query = qIndex >= 0 ? rest.slice(qIndex + 1) : '';
  if (qIndex >= 0) rest = rest.slice(0, qIndex);
  let decoded = rest;
  if (!rest.includes('@')) {
    const b = decodeB64(rest.replace(/^\/+/, ''));
    if (!b) return null;
    decoded = b;
  }
  const at = decoded.lastIndexOf('@');
  if (at < 0) return null;
  const userinfo = decoded.slice(0, at);
  const hostport = decoded.slice(at + 1);
  let method, password;
  if (userinfo.includes(':')) {
    const ci = userinfo.indexOf(':');
    method = userinfo.slice(0, ci);
    password = decodeURIComponent(userinfo.slice(ci + 1));
  } else {
    const b = decodeB64(userinfo);
    if (!b) return null;
    const ci = b.indexOf(':');
    method = b.slice(0, ci);
    password = b.slice(ci + 1);
  }
  const hp = hostport.replace(/\/$/, '').split(':');
  const server = hp.shift();
  const port = toNum(hp.join(':'), 0);
  const q = new URLSearchParams(query);
  const out = {
    name: decodeURIComponent(tag || '').trim() || `${server}:${port}` || fallbackName,
    type: 'ss', server, port,
    cipher: method, password, udp: true
  };
  if (q.get('plugin')) {
    const pluginRaw = decodeURIComponent(q.get('plugin'));
    const parts = pluginRaw.split(';');
    out.plugin = parts[0];
    const opts = {};
    parts.slice(1).forEach((kv) => {
      const [k, v] = kv.split('=');
      opts[k] = v === undefined ? true : v;
    });
    if (parts[0] === 'obfs') {
      out.plugin = 'obfs';
      out['plugin-opts'] = { mode: opts.mode || 'http', host: opts.host || '' };
    } else if (parts[0] === 'v2ray-plugin') {
      out.plugin = 'v2ray-plugin';
      out['plugin-opts'] = { mode: opts.mode || 'websocket', host: opts.host || '', path: opts.path || '/', tls: !!opts.tls, mux: !!opts.mux };
    }
  }
  return out;
}

function parseVmess(uri, fallbackName) {
  const b = decodeB64(uri.slice(8));
  if (!b) return null;
  let j;
  try { j = JSON.parse(b); } catch (_) { return null; }
  const net = String(j.net || 'tcp');
  const out = {
    name: String(j.ps || j.name || '').trim() || `${j.add}:${j.port}` || fallbackName,
    type: 'vmess',
    server: String(j.add || ''),
    port: toNum(j.port, 0),
    uuid: String(j.id || ''),
    alterId: toNum(j.aid, 0),
    cipher: String(j.scy || 'auto'),
    udp: true
  };
  if (/tls|reality|xhttp/i.test(String(j.tls || ''))) out.tls = true;
  if (j.sni) out.sni = String(j.sni);
  if (j.host && out.tls) out.servername = String(j.host);
  if (net === 'ws') {
    out.network = 'ws';
    out['ws-opts'] = {
      path: String(j.path || '/'),
      headers: j.host ? { Host: String(j.host) } : undefined
    };
  } else if (net === 'grpc') {
    out.network = 'grpc';
    out['grpc-opts'] = { 'grpc-service-name': String(j.path || '') };
  } else if (net === 'h2' || net === 'http') {
    out.network = 'h2';
    out['h2-opts'] = { host: j.host ? [String(j.host)] : undefined, path: String(j.path || '/') };
  } else if (net === 'tcp' && String(j.type || '') === 'http') {
    out.network = 'http';
    out['http-opts'] = { path: [String(j.path || '/')], headers: j.host ? { Host: [String(j.host)] } : undefined };
  }
  return out;
}

function parseVless(uri, fallbackName) {
  let u;
  try { u = new URL(uri); } catch (_) { return null; }
  const q = qsParse(u);
  const out = {
    name: decodeURIComponent(u.hash.slice(1) || '').trim() || `${u.hostname}:${u.port}` || fallbackName,
    type: 'vless',
    server: u.hostname,
    port: toNum(u.port, 0),
    uuid: decodeURIComponent(u.username || ''),
    udp: true
  };
  if (q.flow) out.flow = q.flow;
  if (q.security === 'tls' || q.security === 'reality' || toBool(q.tls)) out.tls = true;
  if (q.security === 'reality') {
    out.tls = true;
    out['reality-opts'] = {};
    if (q.pbk) out['reality-opts']['public-key'] = q.pbk;
    if (q.sid) out['reality-opts']['short-id'] = q.sid;
  }
  if (q.sni) out.servername = q.sni;
  else if (q.host && out.tls) out.servername = q.host;
  if (q.fp) out['client-fingerprint'] = q.fp;
  if (toBool(q.allowinsecure) || toBool(q.insecure) || toBool(q['skip-cert-verify'])) out['skip-cert-verify'] = true;
  const net = q.type || 'tcp';
  if (net === 'ws') {
    out.network = 'ws';
    out['ws-opts'] = { path: q.path || '/', headers: q.host ? { Host: q.host } : undefined };
  } else if (net === 'grpc') {
    out.network = 'grpc';
    out['grpc-opts'] = { 'grpc-service-name': q.servicename || q.serviceName || '' };
  } else if (net === 'tcp') {
    out.network = 'tcp';
  } else if (net === 'http' || net === 'xhttp') {
    out.network = 'http';
    out['http-opts'] = { path: [q.path || '/'], headers: q.host ? { Host: [q.host] } : undefined };
  }
  return out;
}

function parseTrojan(uri, fallbackName) {
  let u;
  try { u = new URL(uri); } catch (_) { return null; }
  const q = qsParse(u);
  const out = {
    name: decodeURIComponent(u.hash.slice(1) || '').trim() || `${u.hostname}:${u.port}` || fallbackName,
    type: 'trojan',
    server: u.hostname,
    port: toNum(u.port, 0),
    password: decodeURIComponent(u.username || ''),
    udp: true
  };
  if (q.sni) out.sni = q.sni;
  else if (q.peer) out.sni = q.peer;
  if (toBool(q.allowinsecure) || toBool(q.insecure) || toBool(q['skip-cert-verify'])) out['skip-cert-verify'] = true;
  if (q.type === 'ws') {
    out.network = 'ws';
    out['ws-opts'] = { path: q.path || '/', headers: q.host ? { Host: q.host } : undefined };
  } else if (q.type === 'grpc') {
    out.network = 'grpc';
    out['grpc-opts'] = { 'grpc-service-name': q.servicename || q.serviceName || '' };
  }
  if (q.alpn) out.alpn = q.alpn.split(',');
  return out;
}

function parseHysteria2(uri, fallbackName) {
  let u;
  try { u = new URL(uri); } catch (_) { return null; }
  const q = qsParse(u);
  const out = {
    name: decodeURIComponent(u.hash.slice(1) || '').trim() || `${u.hostname}:${u.port}` || fallbackName,
    type: 'hysteria2',
    server: u.hostname,
    port: toNum(u.port, 443),
    password: decodeURIComponent(u.username || ''),
    udp: true
  };
  if (q.sni) out.sni = q.sni;
  if (toBool(q.insecure) || toBool(q['skip-cert-verify']) || toBool(q.allowinsecure)) out['skip-cert-verify'] = true;
  if (q.obfs) { out.obfs = q.obfs; out['obfs-password'] = q['obfs-password'] || ''; }
  if (q.alpn) out.alpn = q.alpn.split(',');
  if (q.ports) out.ports = q.ports;
  return out;
}

function parseTuic(uri, fallbackName) {
  let u;
  try { u = new URL(uri); } catch (_) { return null; }
  const q = qsParse(u);
  const out = {
    name: decodeURIComponent(u.hash.slice(1) || '').trim() || `${u.hostname}:${u.port}` || fallbackName,
    type: 'tuic',
    server: u.hostname,
    port: toNum(u.port, 0),
    uuid: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    udp: true
  };
  if (q.sni) out.sni = q.sni;
  if (toBool(q.insecure) || toBool(q['skip-cert-verify'])) out['skip-cert-verify'] = true;
  if (q.alpn) out.alpn = q.alpn.split(',');
  if (q.congestion_control) out['congestion-controller'] = q.congestion_control;
  if (q.udp_relay_mode) out['udp-relay-mode'] = q.udp_relay_mode;
  return out;
}

function parseSocksOrHttp(uri, fallbackName, type) {
  let u;
  try { u = new URL(uri); } catch (_) { return null; }
  const q = qsParse(u);
  const out = {
    name: decodeURIComponent(u.hash.slice(1) || '').trim() || `${u.hostname}:${u.port}` || fallbackName,
    type,
    server: u.hostname,
    port: toNum(u.port, type === 'http' ? 80 : 1080),
    udp: true
  };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  if (type === 'http' && (toBool(q.tls) || u.protocol === 'https:')) { out.tls = true; if (q.sni) out.sni = q.sni; }
  return out;
}

/** 单个分享链接 → mihomo proxy */
function parseUri(uriRaw) {
  const uri = String(uriRaw || '').trim();
  const scheme = (uri.match(/^([a-z0-9+.-]+):\/\//i) || [])[1];
  if (!scheme) return null;
  const lower = scheme.toLowerCase();
  switch (lower) {
    case 'ss': return parseSs(uri, 'ss');
    case 'ssr': return null;
    case 'vmess': return parseVmess(uri, 'vmess');
    case 'vless': return parseVless(uri, 'vless');
    case 'trojan': return parseTrojan(uri, 'trojan');
    case 'hysteria2':
    case 'hy2': return parseHysteria2(uri.replace(/^hy2:/, 'hysteria2:'), 'hy2');
    case 'tuic': return parseTuic(uri, 'tuic');
    case 'socks':
    case 'socks5': return parseSocksOrHttp(uri, 'socks5', 'socks5');
    case 'http':
    case 'https': return parseSocksOrHttp(uri, 'http', 'http');
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/* Clash / mihomo YAML                                                 */
/* ------------------------------------------------------------------ */

function parseClashYaml(text) {
  let doc;
  try { doc = YAML.parse(text); } catch (err) { return { nodes: [], warnings: ['YAML 解析失败: ' + err.message] }; }
  const warnings = [];
  let list = [];
  if (Array.isArray(doc)) list = doc;
  else if (doc && Array.isArray(doc.proxies)) list = doc.proxies;
  else if (doc && doc.proxies && typeof doc.proxies === 'object') list = Object.values(doc.proxies);
  else return { nodes: [], warnings: ['未找到 proxies 段'] };
  const nodes = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const clean = sanitizeProxy(p, 'proxy');
    if (clean) nodes.push(clean);
    else warnings.push(`节点 ${p.name || '(未命名)'} 字段不完整，已跳过`);
  }
  // 保留 provider / 远程规则集信息，供导入订阅时提示
  return { nodes, warnings, clash: { proxyProviders: doc && doc['proxy-providers'], ruleProviders: doc && doc['rule-providers'] } };
}

/* ------------------------------------------------------------------ */
/* QX conf / Surge conf                                                */
/* ------------------------------------------------------------------ */

const QX_TYPE_MAP = { ss: 'ss', shadowsocks: 'ss', vmess: 'vmess', vless: 'vless', trojan: 'trojan', http: 'http', https: 'http', socks5: 'socks5', hysteria2: 'hysteria2', tuic: 'tuic' };

function parseQxLine(line, warnings) {
  const parts = line.split(',').map((s) => s.trim());
  const type = String(parts[0] || '').toLowerCase();
  const mapped = QX_TYPE_MAP[type];
  if (!mapped) {
    warnings.push(`不支持的 QX 节点类型: ${type}`);
    return null;
  }
  const name = parts[1] || `${parts[2]}:${parts[3]}`;
  const server = parts[2];
  const port = toNum(parts[3], 0);
  if (!server || !port) return null;
  const opts = {};
  parts.slice(4).forEach((p) => {
    const eq = p.indexOf('=');
    if (eq > 0) opts[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
    else if (/^\d+$/.test(p)) opts._pos = (opts._pos || '') + p + ',';
  });
  // 位置参数：ss/trojan = 密码在第 5 位；http/socks5 = 用户名、密码
  const pos = opts._pos ? opts._pos.split(',') : parts.slice(4);
  const out = { name, server, port, type: mapped, udp: opts['udp-relay'] !== 'false' };
  if (mapped === 'ss') { out.cipher = pos[0] || opts.method || 'aes-128-gcm'; out.password = pos[1] || ''; }
  else if (mapped === 'vmess') { out.uuid = pos[1] || pos[0] || ''; out.alterId = toNum(opts['alter-id'] || opts.aid, 0); out.cipher = opts.method || 'auto'; }
  else if (mapped === 'vless') { out.uuid = pos[0] || ''; if (opts['tls-host'] || opts.sni) out.servername = opts['tls-host'] || opts.sni; }
  else if (mapped === 'trojan') { out.password = pos[0] || ''; if (opts['tls-host'] || opts.sni) out.sni = opts['tls-host'] || opts.sni; }
  else if (mapped === 'http' || mapped === 'socks5') { out.username = pos[0] || opts.username || ''; out.password = pos[1] || opts.password || ''; }
  else if (mapped === 'hysteria2') { out.password = pos[0] || ''; if (opts.sni) out.sni = opts.sni; }
  else if (mapped === 'tuic') { out.uuid = pos[0] || ''; out.password = pos[1] || ''; }
  if (opts['obfs'] && (mapped === 'ss')) {
    out.plugin = 'obfs';
    out['plugin-opts'] = { mode: opts.obfs, host: opts['obfs-host'] || '' };
  }
  if (opts['over-tls'] === 'true') { out.tls = true; out.servername = opts['tls-host'] || server; }
  if (opts['skip-cert-verify'] === 'true') out['skip-cert-verify'] = true;
  return sanitizeProxy(out, name);
}

function parseQxConf(text) {
  const warnings = [];
  const nodes = [];
  const remotes = { servers: [], filters: [], rewrites: [] };
  let section = '';
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }
    if (section === 'server_local' || section === 'proxy' || section === 'proxies') {
      if (/^(ss|vmess|vless|trojan|http|https|socks5|hysteria2|tuic)\s*,/i.test(line)) {
        const n = parseQxLine(line, warnings);
        if (n) nodes.push(n);
      } else if (line.includes('://')) {
        const n = parseUri(line.split(',')[0]);
        if (n) nodes.push(n);
      }
    } else if (section === 'server_remote') {
      const url = line.split(',')[0].trim();
      if (/^http(s)?:\/\//i.test(url)) remotes.servers.push({ url, raw: line });
    } else if (section === 'filter_remote') {
      const url = line.split(',')[0].trim();
      if (/^http(s)?:\/\//i.test(url)) remotes.filters.push({ url, raw: line });
    } else if (section.startsWith('rewrite_remote')) {
      const url = line.split(',')[0].trim();
      if (/^http(s)?:\/\//i.test(url)) remotes.rewrites.push({ url, raw: line });
    }
  }
  return { nodes, warnings, remotes };
}

const SURGE_TYPE_MAP = { ss: 'ss', vmess: 'vmess', vless: 'vless', trojan: 'trojan', http: 'http', https: 'http', socks5: 'socks5', snell: null, wireguard: null };

function parseSurgeConf(text) {
  const warnings = [];
  const nodes = [];
  let section = '';
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }
    if (section !== 'proxy' && section !== 'proxies') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim();
    const parts = line.slice(eq + 1).split(',').map((s) => s.trim());
    const type = String(parts[0] || '').toLowerCase();
    const mapped = SURGE_TYPE_MAP[type];
    if (!mapped) { warnings.push(`Surge 节点 ${name} 类型 ${type} 暂不支持`); continue; }
    const server = parts[1];
    const port = toNum(parts[2], 0);
    if (!server || !port) continue;
    const kv = {};
    parts.slice(3).forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) kv[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim();
      else if (p) kv._positional = (kv._positional || '') + p + ',';
    });
    const out = { name: name || `${server}:${port}`, server, port, type: mapped, udp: kv['udp-relay'] !== 'false' };
    if (mapped === 'ss') { out.cipher = kv['encrypt-method'] || 'aes-128-gcm'; out.password = kv.password || ''; }
    else if (mapped === 'vmess') { out.uuid = kv.username || ''; out.alterId = toNum(kv['alter-id'], 0); out.cipher = 'auto'; }
    else if (mapped === 'trojan') { out.password = kv.password || ''; }
    else if (mapped === 'http' || mapped === 'socks5') { out.username = kv.username || ''; out.password = kv.password || ''; }
    if (toBool(kv.tls) || mapped === 'trojan') out.tls = mapped === 'trojan' ? undefined : true;
    if (kv.sni) out.sni = kv.sni;
    if (toBool(kv['skip-cert-verify'])) out['skip-cert-verify'] = true;
    if (toBool(kv.ws)) {
      out.network = 'ws';
      const headers = {};
      if (kv['ws-headers']) {
        kv['ws-headers'].split('|').forEach((h) => {
          const [k, v] = h.split(':');
          if (k && v) headers[k.trim()] = v.trim();
        });
      }
      out['ws-opts'] = { path: kv['ws-path'] || '/', headers: Object.keys(headers).length ? headers : undefined };
    }
    if (mapped === 'trojan') delete out.tls;
    if (mapped === 'ss' && kv.obfs && kv.obfs !== 'none') {
      out.plugin = 'obfs';
      out['plugin-opts'] = { mode: kv.obfs, host: kv['obfs-host'] || '' };
    }
    const clean = sanitizeProxy(out, name);
    if (clean) nodes.push(clean);
  }
  return { nodes, warnings };
}

/* ------------------------------------------------------------------ */
/* 自动识别入口                                                        */
/* ------------------------------------------------------------------ */

/**
 * 解析任意订阅内容（自动识别格式）。
 * @returns {{format:string, nodes:Array, warnings:Array, remotes?:object}}
 */
function parseSubscriptionText(text, name = '订阅') {
  const src = String(text || '').trim();
  if (!src) return { format: 'empty', nodes: [], warnings: ['内容为空'] };

  // 1) Clash / mihomo YAML
  if (/^\s*(proxies|proxy-providers|proxy-groups):/m.test(src) || /^\s*\{\s*\n?\s*"proxies"/m.test(src)) {
    const r = parseClashYaml(src);
    return { format: 'clash', nodes: r.nodes, warnings: r.warnings, remotes: r.clash };
  }

  // 2) QX conf
  if (/\[(server_local|server_remote|filter_local|filter_remote|rewrite_local|general|policy)\]/i.test(src)) {
    const r = parseQxConf(src);
    return { format: 'qx', nodes: r.nodes, warnings: r.warnings, remotes: r.remotes };
  }

  // 3) Surge conf
  if (/\[Proxy\]/i.test(src) || /\[Proxy Group\]/i.test(src)) {
    const r = parseSurgeConf(src);
    return { format: 'surge', nodes: r.nodes, warnings: r.warnings };
  }

  // 4) 纯 URI 列表
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const uriLines = lines.filter((l) => /^(ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|socks5?|https?):\/\//i.test(l));
  if (uriLines.length >= Math.max(1, Math.floor(lines.length * 0.5)) && uriLines.length) {
    const nodes = [];
    const warnings = [];
    for (const l of uriLines) {
      const n = parseUri(l);
      if (n) nodes.push(n); else warnings.push(`无法解析: ${l.slice(0, 60)}…`);
    }
    return { format: 'uri-list', nodes, warnings };
  }

  // 5) Base64 包裹的 URI 列表
  const dec = tryB64(src);
  if (dec && dec !== src) {
    const r = parseSubscriptionText(dec, name);
    if (r.nodes.length) return { ...r, format: r.format === 'uri-list' ? 'base64' : r.format };
  }

  // 6) 纯 base64 的单条 URI（少见）
  const single = parseUri(src);
  if (single) return { format: 'uri', nodes: [single], warnings: [] };

  return { format: 'unknown', nodes: [], warnings: ['无法识别的订阅格式（支持 Clash YAML / QX conf / Surge conf / 分享链接）'] };
}

/** 本地节点粘贴框：QX 行 + 分享链接 + YAML 混合解析 */
function parseLocalText(text) {
  const parsed = parseSubscriptionText(text, '本地节点');
  return { nodes: parsed.nodes, warnings: parsed.warnings, format: parsed.format, remotes: parsed.remotes || null };
}

/** 名称去重（mihomo 不允许重名） */
function dedupeNames(nodes, prefix = '') {
  const used = new Set();
  return nodes.map((n) => {
    let base = prefix ? `${prefix} ${n.name}` : n.name;
    let name = base;
    let i = 2;
    while (used.has(name.toLowerCase())) { name = `${base} #${i++}`; }
    used.add(name.toLowerCase());
    return { ...n, name };
  });
}

module.exports = { parseUri, parseClashYaml, parseQxConf, parseSurgeConf, parseSubscriptionText, parseLocalText, dedupeNames, sanitizeProxy, tryB64 };
