'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, dialog, shell, app, nativeTheme } = require('electron');
const paths = require('./paths');
const { buildConfig, collectNodes } = require('./config/generate');
const { parseSubscriptionText, parseLocalText, dedupeNames, parseUri } = require('./subs/parse');
const { download } = require('./subs/download');
const { SpeedTestRunner } = require('./core/speedtest');
const { detectRegion, allPresets, regionFlag } = require('./regions');
const { setSystemProxy, readProxyState, isElevated, openProxySettings } = require('./net/system-proxy');
const { uid, mergeDeep, sanitizeProxyName, clone } = require('./util');
const autostart = require('./autostart');
const { notify } = require('./notify');
const { ControllerApi } = require('./core/api');

function publicState(state) {
  const { nodes, ...rest } = state;
  // 订阅体量大：只把统计信息发给渲染层
  const subs = (state.subscriptions || []).map((s) => {
    const { nodes: n, ...sub } = s;
    return { ...sub, nodeCount: (n || []).length };
  });
  return { ...rest, subscriptions: subs };
}

function nodeList(state) {
  const collected = collectNodes(state);
  const out = [];
  for (const n of collected.nodes) {
    out.push({
      name: n.name,
      type: n.type,
      server: n.server,
      port: n.port,
      udp: n.udp !== false,
      source: n._src || '',
      sourceId: n._srcId || '',
      region: collected.regionOf.get(n.name) || null
    });
  }
  return out;
}

function regionSummary(state, nodes) {
  const regions = (state.regions || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  return regions.map((r) => {
    const list = nodes.filter((n) => n.region === r.id);
    return {
      id: r.id,
      name: r.name,
      flag: r.flag,
      keywords: r.keywords,
      enabled: r.enabled !== false,
      mode: r.mode || 'select',
      selected: r.selected || null,
      best: r.best || null,
      count: list.length,
      sources: [...new Set(list.map((n) => n.source))],
      nodes: list.map((n) => n.name)
    };
  });
}

function registerIpc({ store, core, rewrite, ca, getWindow, showWindow, quitApp, trayMgr }) {
  const runner = new SpeedTestRunner(new ControllerApi(store.get().settings.controllerPort, store.get().settings.secret));
  let lastTest = null;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const refreshApi = () => {
    const c = core.controllerCoords();
    runner.api = new ControllerApi(c.port, c.secret);
  };

  const caSnapshot = async () => {
    if (!ca) return { exists: false, installed: false };
    const status = await ca.status();
    let sha256 = null;
    let validUntil = null;
    try {
      if (fs.existsSync(ca.rootCertPath)) {
        const cert = new crypto.X509Certificate(fs.readFileSync(ca.rootCertPath));
        sha256 = cert.fingerprint256;
        validUntil = cert.validTo;
      }
    } catch (_) {}
    return { exists: fs.existsSync(ca.rootCertPath), installed: status.installed === true, sha256, validUntil };
  };
  const rewriteStatus = async () => ({ ok: true, engine: rewrite ? rewrite.snapshot() : { running: false }, ca: await caSnapshot() });
  const broadcastRewrite = async () => send('rewrite', { engine: rewrite ? rewrite.snapshot() : null, ca: await caSnapshot() });
  const effectiveProxyPort = () => {
    const st = store.get().settings;
    return st.rewriteEnabled && rewrite && rewrite.snapshot().running ? rewrite.snapshot().port : (core.controllerCoords().mixedPort || st.mixedPort);
  };

  const bootstrap = async () => {
    const state = store.get();
    const nodes = nodeList(state);
    refreshApi();
    const [sp, elevated] = await Promise.all([readProxyState(), isElevated()]);
    return {
      state: publicState(state),
      nodes,
      regions: regionSummary(state, nodes),
      presets: allPresets(),
      core: core.snapshot(),
      rewrite: rewrite ? rewrite.snapshot() : { running: false },
      ca: await caSnapshot(),
      systemProxy: sp,
      elevated,
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      paths: {
        dataDir: paths.dataDir(),
        config: paths.configPath(),
        core: paths.coreBinary(),
        exists: fs.existsSync(paths.coreBinary())
      },
      lastTest,
      version: app.getVersion(),
      portable: process.env.WALLNUT_PORTABLE === '1'
    };
  };

  const broadcastState = () => {
    const state = store.get();
    const nodes = nodeList(state);
    send('state', { state: publicState(state), nodes, regions: regionSummary(state, nodes) });
  };

  /* ---------------- 应用级 ---------------- */
  ipcMain.handle('app:bootstrap', bootstrap);

  ipcMain.handle('app:settings:save', async (_e, patch) => {
    const prev = clone(store.get().settings);
    store.update((d) => { d.settings = mergeDeep(d.settings, patch || {}); });
    broadcastState();
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'launchAtLogin')) {
      const r = autostart.apply(patch.launchAtLogin === true);
      if (!r.ok) return { ok: false, error: '开机自启动设置失败：' + (r.error || '未知错误') };
    }
    if (rewrite && patch && ['rewriteEnabled', 'rewritePort'].some((k) => Object.prototype.hasOwnProperty.call(patch, k))) {
      const r = store.get().settings.rewriteEnabled ? await rewrite.start() : await rewrite.stop();
      if (!r.ok) return { ok: false, error: '重写引擎：' + (r.error || '启动失败') };
      if (store.get().settings.systemProxy) await setSystemProxy(true, { port: effectiveProxyPort() });
      await broadcastRewrite();
    }
    const needRestart = ['mixedPort', 'controllerPort', 'secret', 'mode', 'logLevel', 'allowLan', 'ipv6', 'tunEnabled', 'tunStack', 'strictRoute', 'dns', 'unifiedDelay', 'findProcessMode']
      .some((k) => JSON.stringify(prev[k]) !== JSON.stringify(store.get().settings[k]));
    if (needRestart && core.snapshot().running) {
      const r = await core.apply();
      return { ok: true, applied: r };
    }
    return { ok: true };
  });

  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '仅允许 http/https 链接' };
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:openDataDir', async () => { await shell.openPath(paths.dataDir()); return { ok: true }; });
  ipcMain.handle('app:trayReinit', async () => {
    const r = trayMgr ? trayMgr.reinit() : { ok: false };
    const visible = !!r.visible;
    return { ...r, hint: visible ? '托盘图标已显示' : '图标已重建，但 Windows 把它放在 ^ 溢出区，点 ^ 可查看' };
  });

  ipcMain.handle('app:openTaskbarSettings', async () => {
    await shell.openExternal('ms-settings:taskbar');
    return { ok: true };
  });
  ipcMain.handle('app:showWindow', async () => { showWindow && showWindow(); return { ok: true }; });
  ipcMain.handle('app:quit', async () => { quitApp ? quitApp() : app.quit(); return { ok: true }; });

  ipcMain.handle('app:autostart', async (_e, { enable } = {}) => {
    const r = autostart.apply(!!enable);
    if (r.ok) store.update((d) => { d.settings.launchAtLogin = !!enable; });
    if (!r.ok) notify({ title: 'Wallnut', body: '开机自启动设置失败：' + (r.error || '未知错误') });
    return r;
  });

  ipcMain.handle('app:autostartStatus', async () => autostart.status());

  ipcMain.handle('app:notifyTest', async () => {
    const r = notify({ title: 'Wallnut 通知测试', body: '看到这条说明系统通知与托盘链路正常。' });
    return { ok: r.ok, via: r.via, supported: require('electron').Notification.isSupported() };
  });
  ipcMain.handle('app:openProxySettings', async () => { await openProxySettings(); return { ok: true }; });

  ipcMain.handle('app:pickFile', async (_e, kind = 'sub') => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'sub' ? '选择订阅配置文件' : '选择文件',
      properties: ['openFile'],
      filters: [{ name: '配置文件', extensions: ['yaml', 'yml', 'conf', 'txt', 'json'] }, { name: '全部文件', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
  });

  ipcMain.handle('app:theme', async (_e, theme) => {
    nativeTheme.themeSource = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    store.update((d) => { d.ui = { ...(d.ui || {}), theme }; });
    return { ok: true, dark: nativeTheme.shouldUseDarkColors };
  });

  ipcMain.handle('app:copyText', async (_e, text) => {
    require('electron').clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  /* ---------------- 订阅 ---------------- */
  const applySub = async (id, { force = false } = {}) => {
    const sub = store.get().subscriptions.find((s) => s.id === id);
    if (!sub) throw new Error('订阅不存在');
    const started = Date.now();
    const res = await download(sub.url, { timeout: 25000, insecure: sub.insecure === true });
    const parsed = parseSubscriptionText(res.text, sub.name);
    if (!parsed.nodes.length) {
      store.update((d) => {
        const s = d.subscriptions.find((x) => x.id === id);
        if (s) { s.lastError = parsed.warnings.join('；') || '未解析到节点'; s.lastAttemptAt = Date.now(); }
      });
      broadcastState();
      return { ok: false, error: parsed.warnings.join('；') || '未解析到节点', format: parsed.format };
    }
    store.update((d) => {
      const s = d.subscriptions.find((x) => x.id === id);
      if (!s) return;
      s.nodes = parsed.nodes;
      s.format = parsed.format;
      s.updatedAt = Date.now();
      s.lastAttemptAt = Date.now();
      s.lastError = null;
      s.nodeCount = parsed.nodes.length;
      s.remoteInfo = parsed.remotes || null;
    });
    broadcastState();
    const applied = await core.apply();
    return { ok: true, format: parsed.format, nodeCount: parsed.nodes.length, warnings: parsed.warnings, applied, ms: Date.now() - started };
  };

  ipcMain.handle('sub:add', async (_e, { name, url, insecure }) => {
    if (!/^(https?|file):\/\//i.test(String(url || '')) && !fs.existsSync(String(url || ''))) {
      return { ok: false, error: '订阅地址需要是 http(s) 链接或本地文件路径' };
    }
    const id = uid('sub');
    store.update((d) => {
      d.subscriptions.push({
        id, name: sanitizeProxyName(name || '订阅', '订阅'), url: String(url),
        enabled: true, insecure: insecure === true, interval: Number(d.settings.subscriptionInterval) || 1440,
        createdAt: Date.now(), nodes: [], nodeCount: 0
      });
    });
    const r = await applySub(id);
    if (!r.ok) return { ...r, id };
    return { ...r, id };
  });

  ipcMain.handle('sub:importText', async (_e, { name, text, url }) => {
    const id = uid('sub');
    const parsed = parseSubscriptionText(text, name);
    if (!parsed.nodes.length) return { ok: false, error: parsed.warnings.join('；') || '未解析到节点', format: parsed.format };
    store.update((d) => {
      d.subscriptions.push({
        id, name: sanitizeProxyName(name || '导入配置', '导入配置'), url: url || ('inline:' + id),
        enabled: true, interval: 0, createdAt: Date.now(),
        nodes: parsed.nodes, nodeCount: parsed.nodes.length, format: parsed.format, updatedAt: Date.now(), remoteInfo: parsed.remotes || null
      });
    });
    broadcastState();
    const applied = await core.apply();
    return { ok: true, id, nodeCount: parsed.nodes.length, format: parsed.format, warnings: parsed.warnings, applied };
  });

  ipcMain.handle('sub:update', async (_e, { id }) => {
    try { return await applySub(id); } catch (err) {
      store.update((d) => {
        const s = d.subscriptions.find((x) => x.id === id);
        if (s) { s.lastError = err.message; s.lastAttemptAt = Date.now(); }
      });
      broadcastState();
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('sub:updateAll', async () => {
    const results = [];
    for (const s of store.get().subscriptions.filter((x) => x.url && /^http/i.test(x.url))) {
      try { results.push({ id: s.id, name: s.name, ...(await applySub(s.id)) }); }
      catch (err) { results.push({ id: s.id, name: s.name, ok: false, error: err.message }); }
    }
    return { ok: true, results };
  });

  ipcMain.handle('sub:remove', async (_e, { id }) => {
    store.update((d) => { d.subscriptions = d.subscriptions.filter((s) => s.id !== id); });
    broadcastState();
    await core.apply();
    return { ok: true };
  });

  ipcMain.handle('sub:toggle', async (_e, { id, enabled }) => {
    store.update((d) => {
      const s = d.subscriptions.find((x) => x.id === id);
      if (s) s.enabled = !!enabled;
    });
    broadcastState();
    await core.apply();
    return { ok: true };
  });

  ipcMain.handle('sub:preview', async (_e, { url, insecure }) => {
    try {
      const res = await download(url, { timeout: 20000, insecure: insecure === true });
      const parsed = parseSubscriptionText(res.text, '预览');
      return { ok: true, format: parsed.format, nodeCount: parsed.nodes.length, warnings: parsed.warnings, sample: parsed.nodes.slice(0, 5).map((n) => n.name), remotes: parsed.remotes || null };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  /* ---------------- 本地节点 server_local ---------------- */
  ipcMain.handle('local:importText', async (_e, { text }) => {
    const r = parseLocalText(text);
    const nodes = (r.nodes || []).map((n) => ({ ...n, id: uid('ln'), enabled: true }));
    return { ok: nodes.length > 0, nodes: nodes.map((n) => ({ name: n.name, type: n.type, server: n.server, port: n.port, id: n.id, raw: n })), warnings: r.warnings, format: r.format, remotes: r.remotes || null };
  });

  ipcMain.handle('local:save', async (_e, { node }) => {
    store.update((d) => {
      const existing = (d.localNodes || []).find((x) => x.id === node.id);
      const clean = { ...node };
      delete clean.raw;
      if (existing) Object.assign(existing, clean);
      else d.localNodes.push({ ...clean, id: clean.id || uid('ln'), enabled: clean.enabled !== false });
    });
    broadcastState();
    await core.apply();
    return { ok: true };
  });

  ipcMain.handle('local:remove', async (_e, { id }) => {
    store.update((d) => { d.localNodes = (d.localNodes || []).filter((x) => x.id !== id); });
    broadcastState();
    await core.apply();
    return { ok: true };
  });

  ipcMain.handle('local:testText', async (_e, { text }) => {
    const parsed = parseLocalText(text);
    return { ok: parsed.nodes.length > 0, count: parsed.nodes.length, warnings: parsed.warnings, nodes: parsed.nodes.map((n) => `[${n.type}] ${n.name} → ${n.server}:${n.port}`) };
  });

  /* ---------------- 地区 ---------------- */
  ipcMain.handle('region:save', async (_e, { region }) => {
    store.update((d) => {
      const idx = (d.regions || []).findIndex((r) => r.id === region.id);
      if (idx >= 0) d.regions[idx] = { ...d.regions[idx], ...region };
      else d.regions.push({ ...region, id: region.id || uid('rg'), order: d.regions.length, enabled: true });
    });
    broadcastState();
    await core.apply();
    return { ok: true };
  });

  ipcMain.handle('region:remove', async (_e, { id }) => {
    store.update((d) => { d.regions = d.regions.filter((r) => r.id !== id); });
    broadcastState();
    await core.apply();
    return { ok: true };
  });

  ipcMain.handle('region:presetAdd', async (_e, { presetId }) => {
    const preset = allPresets().find((p) => p.id === presetId);
    if (!preset) return { ok: false, error: '未知地区' };
    if (store.get().regions.some((r) => r.id === preset.id)) return { ok: false, error: '该地区已存在' };
    store.update((d) => {
      d.regions.push({ ...preset, enabled: true, order: d.regions.length, mode: 'select', selected: null, best: null });
    });
    broadcastState();
    await core.apply();
    return { ok: true };
  });

  /** 应用某地区的最快节点；auto 组会先转为手动组 */
  ipcMain.handle('region:applyFastest', async (_e, { id, name, forceManual = true }) => {
    if (!core.snapshot().running) return { ok: false, error: 'mihomo 未运行，无法切换策略。请先在首页点击连接。' };
    const state = store.get();
    const region = state.regions.find((r) => r.id === id);
    if (!region) return { ok: false, error: '地区不存在' };
    const collected = collectNodes(state);
    const groupName = region.name;
    if (region.mode === 'auto' && forceManual) {
      store.update((d) => {
        const r = d.regions.find((x) => x.id === id);
        if (r) { r.mode = 'select'; r.selected = name; r.best = name; }
      });
      broadcastState();
      const applied = await core.apply();
      refreshApi();
      return { ok: true, switched: 'manual', applied };
    }
    store.update((d) => {
      const r = d.regions.find((x) => x.id === id);
      if (r) { r.selected = name; r.best = name; }
    });
    broadcastState();
    refreshApi();
    try {
      await runner.api.select(groupName, name);
      return { ok: true, group: groupName, name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ---------------- 规则 ---------------- */
  ipcMain.handle('rule:save', async (_e, { rules }) => {
    store.update((d) => { d.rules = Array.isArray(rules) ? rules : []; });
    broadcastState();
    const applied = await core.apply();
    return { ok: true, applied };
  });

  ipcMain.handle('ruleprovider:save', async (_e, { provider }) => {
    store.update((d) => {
      const idx = d.ruleProviders.findIndex((p) => p.id === provider.id);
      const rec = {
        id: provider.id || uid('rp'),
        name: provider.name || '远程规则集',
        url: provider.url || '',
        behavior: provider.behavior || 'domain',
        format: provider.format === 'text' ? 'text' : 'yaml',
        interval: Number(provider.interval) || 86400,
        target: provider.target || d.settings.defaultTarget,
        enabled: provider.enabled !== false,
        updatedAt: provider.updatedAt || null
      };
      if (idx >= 0) d.ruleProviders[idx] = { ...d.ruleProviders[idx], ...rec };
      else d.ruleProviders.push(rec);
      return d;
    });
    broadcastState();
    const applied = await core.apply();
    return { ok: true, applied };
  });

  ipcMain.handle('ruleprovider:remove', async (_e, { id }) => {
    store.update((d) => { d.ruleProviders = d.ruleProviders.filter((p) => p.id !== id); });
    broadcastState();
    await core.apply();
    return { ok: true };
  });

  ipcMain.handle('ruleprovider:update', async (_e, { id }) => {
    const rp = store.get().ruleProviders.find((p) => p.id === id);
    if (!rp) return { ok: false, error: '规则集不存在' };
    try {
      refreshApi();
      const rname = 'rp_' + String(rp.id).replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
      await runner.api.put(`/providers/rules/${encodeURIComponent(rname)}`, '', 20000);
      store.update((d) => {
        const p = d.ruleProviders.find((x) => x.id === id);
        if (p) { p.updatedAt = Date.now(); p.lastError = null; }
      });
      broadcastState();
      return { ok: true };
    } catch (err) {
      store.update((d) => {
        const p = d.ruleProviders.find((x) => x.id === id);
        if (p) { p.lastError = err.message; }
      });
      broadcastState();
      return { ok: false, error: err.message };
    }
  });

  /* ---------------- 策略组 ---------------- */
  ipcMain.handle('group:save', async (_e, { groups }) => {
    store.update((d) => { d.groups = Array.isArray(groups) ? groups : []; });
    broadcastState();
    const applied = await core.apply();
    return { ok: true, applied };
  });

  /* ---------------- 重写 / MITM ---------------- */
  ipcMain.handle('rewrite:status', rewriteStatus);
  ipcMain.handle('rewrite:start', async () => {
    if (!store.get().settings.rewriteEnabled) store.update((d) => { d.settings.rewriteEnabled = true; });
    const r = await rewrite.start();
    if (r.ok && store.get().settings.systemProxy) await setSystemProxy(true, { port: effectiveProxyPort() });
    await broadcastRewrite();
    return r;
  });
  ipcMain.handle('rewrite:stop', async () => {
    const r = await rewrite.stop();
    if (store.get().settings.systemProxy) await setSystemProxy(true, { port: effectiveProxyPort() });
    await broadcastRewrite();
    return r;
  });
  ipcMain.handle('rewrite:save', async (_e, { rule }) => {
    const allowed = new Set(['reject', 'redirect', 'rewrite', 'request-header', 'response-header', 'response-body']);
    if (!rule || !allowed.has(rule.type)) return { ok: false, error: '不支持的重写类型' };
    const pattern = String(rule.pattern || '').trim();
    if (!pattern || pattern.length > 2000) return { ok: false, error: 'URL 正则不能为空或过长' };
    try { new RegExp(pattern); } catch (err) { return { ok: false, error: 'URL 正则无效：' + err.message }; }
    if (['rewrite', 'response-body'].includes(rule.type)) {
      try { new RegExp(String(rule.action || '')); } catch (err) { return { ok: false, error: '替换正则无效：' + err.message }; }
    }
    if (rule.type === 'redirect') {
      try { const u = new URL(String(rule.action || '')); if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol'); }
      catch (_) { return { ok: false, error: '重定向目标必须是 http/https URL' }; }
    }
    if (['request-header', 'response-header'].includes(rule.type) && !/^[A-Za-z0-9-]+$/.test(String(rule.header || ''))) {
      return { ok: false, error: 'Header 名称无效' };
    }
    const clean = {
      id: rule.id || uid('rw'), type: rule.type, pattern,
      action: String(rule.action || (rule.type === 'reject' ? '403' : '')),
      header: String(rule.header || ''), value: String(rule.value || ''),
      replacement: String(rule.replacement || ''), note: String(rule.note || '').slice(0, 200),
      enabled: rule.enabled !== false
    };
    store.update((d) => {
      const i = d.rewrites.findIndex((x) => x.id === clean.id);
      if (i >= 0) d.rewrites[i] = clean; else d.rewrites.unshift(clean);
    });
    broadcastState();
    return { ok: true, rule: clean };
  });
  ipcMain.handle('rewrite:remove', async (_e, { id }) => {
    store.update((d) => { d.rewrites = d.rewrites.filter((r) => r.id !== id); });
    broadcastState();
    return { ok: true };
  });
  ipcMain.handle('mitm:saveHosts', async (_e, { hosts }) => {
    const list = [...new Set((Array.isArray(hosts) ? hosts : []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))];
    if (list.length > 200 || list.some((h) => h.length > 253 || !/^[a-z0-9.*-]+$/.test(h))) return { ok: false, error: '主机名无效，仅支持域名、点和 * 通配符' };
    store.update((d) => { d.mitmHosts = list; });
    broadcastState();
    return { ok: true, hosts: list };
  });
  ipcMain.handle('rewrite:caStatus', async () => ({ ok: true, ca: await caSnapshot() }));
  ipcMain.handle('rewrite:caGenerate', async () => { await ca.ensureRoot(); await broadcastRewrite(); return { ok: true, ca: await caSnapshot() }; });
  ipcMain.handle('rewrite:caInstall', async () => { await ca.install(); await broadcastRewrite(); return { ok: true, ca: await caSnapshot() }; });
  ipcMain.handle('rewrite:caUninstall', async () => {
    await ca.uninstall();
    store.update((d) => { d.settings.mitmEnabled = false; });
    broadcastState(); await broadcastRewrite();
    return { ok: true, ca: await caSnapshot() };
  });
  ipcMain.handle('rewrite:caExport', async () => {
    await ca.ensureRoot();
    const r = await dialog.showSaveDialog(getWindow(), { title: '导出 Wallnut Root CA', defaultPath: path.join(paths.dataDir(), 'Wallnut-Root-CA.crt'), filters: [{ name: '证书', extensions: ['crt'] }] });
    if (r.canceled || !r.filePath) return { ok: true, canceled: true };
    fs.copyFileSync(ca.rootCertPath, r.filePath);
    return { ok: true, path: r.filePath };
  });

  /* ---------------- 内核 ---------------- */
  ipcMain.handle('core:start', async () => { const r = await core.start(); refreshApi(); return r; });
  ipcMain.handle('core:stop', async () => { const r = await core.stop(); return r; });
  ipcMain.handle('core:restart', async () => { const r = await core.restart(); refreshApi(); return r; });
  ipcMain.handle('core:apply', async () => { const r = await core.apply(); refreshApi(); return r; });
  ipcMain.handle('core:validate', async () => {
    const built = buildConfig(store.get());
    const file = path.join(paths.dataDir(), 'config.test.yaml');
    fs.writeFileSync(file, built.yaml);
    const v = await core.validate(file);
    try { fs.unlinkSync(file); } catch (_) {}
    return { ...v, yaml: built.yaml, meta: built.meta };
  });
  ipcMain.handle('core:logs', async (_e, { limit = 200 } = {}) => ({ logs: core.logs.slice(-limit) }));
  ipcMain.handle('core:configPreview', async () => {
    const built = buildConfig(store.get());
    return { yaml: built.yaml, meta: built.meta };
  });
  ipcMain.handle('core:meta', async () => {
    const built = buildConfig(store.get());
    return built.meta;
  });

  /* ---------------- 测速 ---------------- */
  ipcMain.handle('test:start', async (event, opts = {}) => {
    if (!core.snapshot().running) return { ok: false, error: 'mihomo 未运行，无法测速。请先在首页点击连接。' };
    if (runner.running) return { ok: false, error: '已有测速任务在进行' };
    refreshApi();
    const state = store.get();
    const collected = collectNodes(state);
    let names = [];
    if (Array.isArray(opts.names) && opts.names.length) names = opts.names;
    else if (opts.scope === 'region') {
      names = collected.nodes.filter((n) => collected.regionOf.get(n.name) === opts.regionId).map((n) => n.name);
    } else if (opts.scope === 'all') {
      names = collected.nodes.map((n) => n.name);
    } else names = collected.nodes.map((n) => n.name);
    if (!names.length) return { ok: false, error: '没有可测速的节点' };
    const settings = state.settings;
    const url = opts.url || settings.testUrl;
    const timeout = Number(opts.timeout) || Number(settings.testTimeout) || 5000;
    const concurrency = Number(opts.concurrency) || Number(settings.testConcurrency) || 16;
    lastTest = { scope: opts.scope || 'all', regionId: opts.regionId || null, startedAt: Date.now(), total: names.length };
    const onProgress = (ev) => {
      send('test', ev);
      if (ev.type === 'done') {
        lastTest = { ...lastTest, finishedAt: Date.now(), okCount: ev.okCount, failCount: ev.failCount, fastest: ev.fastest, results: ev.results };
        if (opts.scope === 'region' && ev.fastest) {
          store.update((d) => {
            const r = d.regions.find((x) => x.id === opts.regionId);
            if (r) r.best = ev.fastest.name;
          });
          broadcastState();
        }
        if (opts.scope !== 'region') {
          // 全量测速后，把每个国家的最快节点分别记到对应地区组
          const bestByRegion = {};
          for (const r of ev.results || []) {
            if (!r.ok || !r.delay) continue;
            const rid = collected.regionOf.get(r.name);
            if (!rid) continue;
            if (!bestByRegion[rid] || r.delay < bestByRegion[rid].delay) bestByRegion[rid] = { name: r.name, delay: r.delay };
          }
          store.update((d) => {
            for (const [rid, best] of Object.entries(bestByRegion)) {
              const r = d.regions.find((x) => x.id === rid);
              if (r) r.best = best.name;
            }
          });
          broadcastState();
        }
      }
    };
    try {
      const summary = await runner.run({ names, url, timeout, concurrency, onProgress });
      return { ok: true, summary };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('test:cancel', async () => { runner.cancel(); return { ok: true }; });

  /** 渲染层 → 内核 REST 代理（避免 file:// 下的 CORS 问题，密钥不出主进程） */
  ipcMain.handle('ctl:rest', async (_e, { method = 'GET', path: p, body, timeout = 10000 } = {}) => {
    if (!core.snapshot().running) return { ok: false, error: 'mihomo 未运行，控制器 9090 当前不可用。请先在首页点击连接。' };
    const target = String(p || '');
    if (!/^\/[A-Za-z0-9\/_.\-?=&%:]*$/.test(target)) return { ok: false, error: '非法路径' };
    refreshApi();
    try {
      const data = await runner.api.request(String(method).toUpperCase(), target, body, Math.min(Number(timeout) || 10000, 30000));
      return { ok: true, data };
    } catch (err) {
      return { ok: false, status: err.status, error: err.message };
    }
  });
  ipcMain.handle('test:last', async () => lastTest);

  /** 对单个节点测速（详情页 / 节点页按钮） */
  ipcMain.handle('test:one', async (_e, { name }) => {
    if (!core.snapshot().running) return { ok: false, error: '内核未运行' };
    refreshApi();
    const s = store.get().settings;
    try {
      const delay = await runner.api.delay(name, { url: s.testUrl, timeout: s.testTimeout });
      return { ok: true, delay };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  /* ---------------- 网络接管 ---------------- */
  ipcMain.handle('net:systemProxy', async (_e, { enable }) => {
    const port = effectiveProxyPort();
    const r = await setSystemProxy(!!enable, { port });
    store.update((d) => { d.settings.systemProxy = !!enable; });
    broadcastState();
    return { ok: r.ok, state: r };
  });

  ipcMain.handle('net:tun', async (_e, { enable }) => {
    const elevated = await isElevated();
    if (enable && !elevated) {
      return { ok: false, error: 'TUN 模式需要管理员权限。请关闭 Wallnut 后，用「以管理员身份运行」重新启动。', needsAdmin: true };
    }
    store.update((d) => { d.settings.tunEnabled = !!enable; });
    broadcastState();
    const applied = await core.apply();
    if (applied.reloaded === false && core.snapshot().running) {
      await core.restart();
      refreshApi();
    }
    return { ok: true, applied };
  });

  ipcMain.handle('net:status', async () => ({ systemProxy: await readProxyState(), elevated: await isElevated() }));

  /* ---------------- 清理 ---------------- */
  ipcMain.handle('dns:flush', async () => {
    refreshApi();
    try { await runner.api.post('/cache/dns/flush', {}); return { ok: true }; }
    catch (err) {
      try { await runner.api.post('/cache/flush', {}); return { ok: true }; }
      catch (e2) { return { ok: false, error: e2.message }; }
    }
  });

  ipcMain.handle('conn:closeAll', async () => {
    refreshApi();
    try { await runner.api.closeAllConnections(); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });

  return { runner, broadcastState, refreshApi, applySub, updateDueSubscriptions };
}

/** 到期订阅批量更新（自动更新巡检用） */
async function updateDueSubscriptions(store, applySub, notify) {
  const state = store.get();
  if (!state.settings.autoUpdateSubs) return [];
  const due = (state.subscriptions || []).filter((s) => {
    if (!s.enabled || !s.url || !/^http/i.test(s.url)) return false;
    const interval = (Number(s.interval) || Number(state.settings.subscriptionInterval) || 1440) * 60 * 1000;
    return !s.updatedAt || Date.now() - s.updatedAt > interval;
  });
  const results = [];
  // 开始前只提示一次，避免每个订阅各弹一条 toast 打扰用户；结束后由调用方汇总。
  if (notify && due.length) notify({ kind: 'info', message: `正在更新 ${due.length} 个订阅` });
  for (const sub of due) {
    try {
      results.push({ id: sub.id, name: sub.name, ...(await applySub(sub.id)) });
    } catch (err) {
      results.push({ id: sub.id, name: sub.name, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { registerIpc, publicState, nodeList, regionSummary, updateDueSubscriptions };
