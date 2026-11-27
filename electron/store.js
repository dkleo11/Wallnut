'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { uid, clone, mergeDeep } = require('./util');
const { defaultRegions } = require('./regions');
const { parseInfoNodes, mergeUsage } = require('./subs/usage');

function defaultRules() {
  return [
    { id: uid('r'), type: 'DOMAIN-SUFFIX', payload: 'local', target: 'DIRECT', disabled: false, note: '局域网域名直连' },
    { id: uid('r'), type: 'IP-CIDR', payload: '127.0.0.0/8', target: 'DIRECT', disabled: false, note: '本机回环' },
    { id: uid('r'), type: 'IP-CIDR', payload: '192.168.0.0/16', target: 'DIRECT', disabled: false, note: '内网' },
    { id: uid('r'), type: 'IP-CIDR', payload: '10.0.0.0/8', target: 'DIRECT', disabled: false, note: '内网' },
    { id: uid('r'), type: 'IP-CIDR', payload: '172.16.0.0/12', target: 'DIRECT', disabled: false, note: '内网' },
    { id: uid('r'), type: 'GEOIP', payload: 'CN', target: 'DIRECT', disabled: false, note: '国内 IP 直连' }
  ];
}

function defaultState() {
  return {
    version: 3,
    settings: {
      mode: 'rule',
      mixedPort: 7890,
      controllerPort: 9090,
      secret: 'wallnut-' + crypto.randomBytes(6).toString('hex'),
      logLevel: 'info',
      allowLan: false,
      ipv6: false,
      geoMirror: true,
      testUrl: 'https://www.gstatic.com/generate_204',
      testTimeout: 5000,
      testConcurrency: 16,
      /* 节点过慢自动切换：每 30s 检查当前节点，连续两次超过 1200ms 或不通就换到更快的节点 */
      autoSwitch: { enabled: true, intervalSec: 30, slowMs: 1200, cooldownSec: 120, maxPer10Min: 6 },
      routingOptimize: false,
      systemProxy: false,
      tunEnabled: true,
      tunStack: 'gvisor',
      strictRoute: true,
      unifiedDelay: true,
      findProcessMode: 'off',
      subscriptionInterval: 1440,
      autoUpdateSubs: true,
      autoStartCore: true,
      closeToTray: true,
      closeAction: 'tray',
      launchAtLogin: false,
      notifications: true,
      language: 'zh-CN',
      rewriteEnabled: false,
      rewritePort: 8890,
      mitmEnabled: false,
      defaultTarget: '主策略',
      dns: {
        enabled: true,
        fakeIp: true,
        fakeIpRange: '198.18.0.1/16',
        nameservers: ['223.5.5.5', '119.29.29.29'],
        fallback: ['https://dns.alidns.com/dns-query'],
        hosts: []
      }
    },
    subscriptions: [],
    localNodes: [],
    regions: defaultRegions(),
    rules: defaultRules(),
    ruleProviders: [],
    rewrites: [],
    rewriteRemoteSets: [],
    mitmHosts: [],
    groups: [],
    ui: { theme: 'system', navOrder: null }
  };
}

class Store {
  constructor() {
    this.file = paths.statePath();
    this.state = defaultState();
    this.listeners = new Set();
    this._saveTimer = null;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.state = this.migrate(mergeDeep(defaultState(), raw));
      } else {
        this.saveNow();
      }
    } catch (err) {
      // 损坏的 state 备份后重建，避免 App 起不来
      try {
        fs.copyFileSync(this.file, this.file + '.broken-' + Date.now());
      } catch (_) {}
      this.state = defaultState();
      this.saveNow();
    }
    return this.state;
  }

  migrate(state) {
    const previousVersion = Number(state.version) || 0;
    if (previousVersion < 2) state.version = 2;
    if (previousVersion < 3) {
      const settings = state.settings || {};
      const dns = settings.dns || {};
      const oldNameservers = ['223.5.5.5', '119.29.29.29', 'https://doh.pub/dns-query'];
      const oldFallback = ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'];
      if (JSON.stringify(dns.nameservers) === JSON.stringify(oldNameservers)) {
        dns.nameservers = ['223.5.5.5', '119.29.29.29'];
      }
      if (JSON.stringify(dns.fallback) === JSON.stringify(oldFallback)) {
        dns.fallback = ['https://dns.alidns.com/dns-query'];
      }
      if (settings.testConcurrency === 8) settings.testConcurrency = 16;
      if (settings.testTimeout === 5000) settings.testTimeout = 8000;
      settings.dns = dns;
      state.settings = settings;
      state.version = 3;
    }
    if (!Array.isArray(state.regions) || !state.regions.length) state.regions = defaultRegions();
    if (!Array.isArray(state.rules)) state.rules = defaultRules();
    if (!Array.isArray(state.ruleProviders)) state.ruleProviders = [];
    if (!Array.isArray(state.subscriptions)) state.subscriptions = [];
    // 机场会把账户信息伪装成节点（「剩余流量：162.84 GB」「套餐到期：…」「永久网址…」）。
    // 旧版本把它们当成了真节点写进 state，这里在加载时清理一遍：伪节点剔除、用量并入 traffic。
    // 幂等：已清理过的订阅再跑一次不会有任何变化。
    state.subscriptions = state.subscriptions.map((s) => {
      const list = Array.isArray(s.nodes) ? s.nodes : [];
      if (!list.length) return s;
      const info = parseInfoNodes(list);
      if (!info.junk.length) return s;
      const traffic = mergeUsage(s.traffic || null, info.traffic) || s.traffic || null;
      return { ...s, nodes: info.nodes, nodeCount: info.nodes.length, traffic, infoNodes: info.junk };
    });
    if (!Array.isArray(state.localNodes)) state.localNodes = [];
    if (!Array.isArray(state.rewrites)) state.rewrites = [];
    if (!Array.isArray(state.rewriteRemoteSets)) state.rewriteRemoteSets = [];
    state.rewriteRemoteSets = state.rewriteRemoteSets.map((s, i) => ({
      id: s.id || uid('rws'),
      name: s.name || `线上规则集 ${i + 1}`,
      url: String(s.url || ''),
      enabled: s.enabled !== false,
      interval: Number.isFinite(Number(s.interval)) ? Number(s.interval) : 1440,
      updatedAt: s.updatedAt || null,
      rulesCount: Array.isArray(s.rules) ? s.rules.length : (Number(s.rulesCount) || 0),
      lastError: s.lastError || null,
      rules: Array.isArray(s.rules) ? s.rules : []
    }));
    if (!Array.isArray(state.mitmHosts)) state.mitmHosts = [];
    // 保证每个地区有稳定字段
    state.regions = state.regions.map((r, i) => ({
      id: r.id || uid('rg'),
      name: r.name || `地区 ${i + 1}`,
      flag: r.flag || '',
      keywords: Array.isArray(r.keywords) ? r.keywords : [],
      enabled: r.enabled !== false,
      order: typeof r.order === 'number' ? r.order : i,
      mode: r.mode === 'auto' ? 'auto' : 'select',
      selected: r.selected || null,
      best: r.best || null
    }));
    return state;
  }

  get() {
    return this.state;
  }

  set(next) {
    this.state = next;
    this.scheduleSave();
    this.emit();
    return this.state;
  }

  /** 局部更新：mutator 直接改 state（已 clone 防止外部引用） */
  update(mutator) {
    const draft = clone(this.state);
    const ret = mutator(draft);
    this.state = ret && typeof ret === 'object' && ret.version ? ret : draft;
    this.scheduleSave();
    this.emit();
    return this.state;
  }

  emit() {
    for (const fn of this.listeners) {
      try { fn(this.state); } catch (err) {
        // 监听器里跑的是广播/重载规则等关键逻辑，静默吞掉会让界面「看起来正常」但不再更新，
        // 排查时毫无线索，至少留下栈信息。
        console.error('[store] 状态监听器异常：', (err && err.stack) || err);
      }
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      const tmp = this.file + '.tmp';
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }
}

module.exports = { Store, defaultState, defaultRules };
