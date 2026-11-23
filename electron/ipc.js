'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, dialog, shell, app, nativeTheme } = require('electron');
const paths = require('./paths');
const { buildConfig, collectNodes } = require('./config/generate');
const { parseSubscriptionText, parseLocalText, dedupeNames, parseUri } = require('./subs/parse');
const { download } = require('./subs/download');
const { parseRewriteText } = require('./rewrite/remote');
const { SpeedTestRunner } = require('./core/speedtest');
const { detectRegion, allPresets, regionFlag } = require('./regions');
const { setSystemProxy, readProxyState, isElevated, openProxySettings } = require('./net/system-proxy');
const { pickProxyPort } = require('./net/proxy-port');
const { uid, mergeDeep, sanitizeProxyName, clone } = require('./util');
const autostart = require('./autostart');
const i18n = require('./i18n');
const { notify } = require('./notify');
const { ControllerApi } = require('./core/api');

function publicState(state) {
  const { nodes, ...rest } = state;
  // 订阅体量大：只把统计信息发给渲染层
  const subs = (state.subscriptions || []).map((s) => {
    const { nodes: n, ...sub } = s;
    return { ...sub, nodeCount: (n || []).length };
  });
  // 线上重写规则集只同步元信息，规则本身体量可能很大，留在主进程
  const rewriteRemoteSets = (state.rewriteRemoteSets || []).map(({ rules, ...set }) => ({
    ...set, rulesCount: (rules || []).length
  }));
  return { ...rest, subscriptions: subs, rewriteRemoteSets };
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
  // 端口选择与托盘共用（electron/net/proxy-port.js），重写在跑时要指向重写端口。
  const effectiveProxyPort = () => pickProxyPort({ store, core, rewrite });

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
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'language')) {
      i18n.setLanguage(store.get().settings.language || 'zh-CN');
      try { if (trayMgr) trayMgr.refresh(true); } catch (_) {}
    }
    broadcastState();
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'launchAtLogin')) {
      const r = autostart.apply(patch.launchAtLogin === true);
      if (!r.ok) return { ok: false, error: '开机自启动设置失败：' + (r.error || '未知错误') };
    }
    // 重写引擎只收得到「系统代理指向它」的流量。顺序很关键：
    //   开：先拉引擎（8890 开始监听）再把系统代理指过来；
    //   关：先把系统代理从 8890 挪回 mihomo 的混合端口，再停引擎。
    // 反过来的话会有「8890 已关闭、注册表还指着它」的窗口，浏览器正好此时发请求就会报代理错误——
    // 系统代理关闭也要走这一步（ProxyEnable=0 也是"先挪后停"）。
    let proxyChange = null, tunAutoEnabled = false, tunNeedsAdminFlag = false;
    const mixedPortNow = () => {
      try { return Number(core.controllerCoords().mixedPort) || Number(store.get().settings.mixedPort) || 7890; }
      catch (_) { return Number(store.get().settings.mixedPort) || 7890; }
    };
    if (rewrite && patch && ['rewriteEnabled', 'rewritePort'].some((k) => Object.prototype.hasOwnProperty.call(patch, k))) {
      if (store.get().settings.rewriteEnabled) {
        const r = await rewrite.start();
        if (!r.ok) {
          // 引擎没起来（端口被占/权限等）：系统代理若还指着重写端口，立刻挪回混合端口，
          // 否则整台机器的系统代理都指向一个没有监听者的端口，所有走系统代理的程序都会报代理错误。
          if (store.get().settings.systemProxy) {
            try { await setSystemProxy(true, { port: mixedPortNow() }); } catch (_) {}
          }
          return { ok: false, error: '重写引擎：' + (r.error || '启动失败') };
        }
        const port = effectiveProxyPort();
        if (!store.get().settings.systemProxy) {
          const sp = await setSystemProxy(true, { port });
          if (sp.ok) { store.update((d) => { d.settings.systemProxy = true; }); proxyChange = 'on'; }
        } else {
          await setSystemProxy(true, { port });
        }
      } else {
        // 关重写 → 关闭系统代理，交回 TUN。顺序：
        //   1) 先关系统代理（此刻 8890 还在监听，不会出现指向死端口的窗口）
        //   2) 停重写引擎
        //   3) TUN 未启用就自动开启 —— 放在最后，因为改 TUN 要重启内核，
        //      此时系统代理已经关掉，重启期间的请求走直连，不会弹出"代理错误"。
        let proxyOff = false;
        if (store.get().settings.systemProxy) {
          const sp = await setSystemProxy(false, { port: mixedPortNow() });
          if (sp.ok) { store.update((d) => { d.settings.systemProxy = false; }); proxyOff = true; }
        }
        const r = await rewrite.stop();
        if (!r.ok) return { ok: false, error: '重写引擎：' + (r.error || '停止失败') };
        if (proxyOff) proxyChange = 'off';

        let tunAuto = false, tunNeedsAdmin = false;
        if (!store.get().settings.tunEnabled) {
          const elevated = await isElevated();
          if (elevated) {
            store.update((d) => { d.settings.tunEnabled = true; });
            prev.tunEnabled = true;                       // 避免末尾 needRestart 再重复 apply 一次
            if (core.snapshot().running) {
              const applied = await core.apply();
              if (applied && applied.reloaded === false) { await core.restart(); refreshApi(); }
            }
            tunAuto = true;
          } else {
            tunNeedsAdmin = true;
          }
        }
        if (tunAuto) tunAutoEnabled = true;
        if (tunNeedsAdmin) tunNeedsAdminFlag = true;
      }
      await broadcastRewrite();
      broadcastState();
    }
    const needRestart = ['mixedPort', 'controllerPort', 'secret', 'mode', 'logLevel', 'allowLan', 'ipv6', 'tunEnabled', 'tunStack', 'strictRoute', 'dns', 'unifiedDelay', 'findProcessMode']
      .some((k) => JSON.stringify(prev[k]) !== JSON.stringify(store.get().settings[k]));
    if (needRestart && core.snapshot().running) {
      const r = await core.apply();
      return { ok: true, applied: r, proxyChange, tunAutoEnabled, tunNeedsAdmin: tunNeedsAdminFlag };
    }
    return { ok: true, proxyChange, tunAutoEnabled, tunNeedsAdmin: tunNeedsAdminFlag };
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
    const t = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    nativeTheme.themeSource = t;
    store.update((d) => { d.ui = { ...(d.ui || {}), theme: t }; });
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

  ipcMain.handle('sub:save', async (_e, { id, name, url, interval, insecure, enabled } = {}) => {
    const current = (store.get().subscriptions || []).find((s) => s.id === id);
    if (!current) return { ok: false, error: '订阅不存在，可能已被删除' };
    const nextName = String(name == null ? current.name : name).trim();
    if (!nextName) return { ok: false, error: '请填写订阅名称' };
    const inline = String(current.url || '').startsWith('inline:');
    const nextUrl = inline && url == null ? current.url : String(url == null ? current.url : url).trim();
    if (!inline || url != null) {
      if (!/^https?:\/\//i.test(nextUrl) && !fs.existsSync(nextUrl)) {
        return { ok: false, error: '订阅地址需要是 http(s) 链接或本地文件路径' };
      }
    }
    const mins = Number(interval == null ? (current.interval || 0) : interval);
    if (!Number.isFinite(mins) || mins < 0 || mins > 10080) return { ok: false, error: '更新间隔需要是 0-10080 分钟' };
    const urlChanged = String(current.url || '') !== nextUrl;
    const insecureChanged = (current.insecure === true) !== (insecure === true);
    store.update((d) => {
      const s = d.subscriptions.find((x) => x.id === id);
      if (!s) return;
      s.name = sanitizeProxyName(nextName, '订阅');
      s.url = nextUrl;
      s.interval = mins;
      s.insecure = insecure == null ? s.insecure === true : insecure === true;
      if (enabled != null) s.enabled = !!enabled;
      if (urlChanged) { s.nodes = []; s.nodeCount = 0; s.updatedAt = null; s.lastError = null; s.format = null; }
    });
    broadcastState();
    // 地址或证书策略变化后需要重新拉取；只改名字/间隔则直接重建配置
    if (urlChanged || insecureChanged) {
      const r = await applySub(id);
      return { ok: !!(r && r.ok), urlChanged, nodeCount: r && r.nodeCount, format: r && r.format, warnings: (r && r.warnings) || [], error: r && r.ok ? undefined : (r && r.error) };
    }
    await core.apply();
    return { ok: true, urlChanged: false };
  });

  ipcMain.handle('sub:preview', async (_e, { url, insecure }) => {
    try {
      const res = await download(url, { timeout: 20000, insecure: insecure === true });
      const parsed = parseSubscriptionText(res.text, '预览');
      return { ok: true, format: parsed.format, nodeCount: parsed.nodes.length, warnings: parsed.warnings, sample: parsed.nodes.slice(0, 5).map((n) => n.name), remotes: parsed.remotes || null };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  /* ---------------- 订阅节点编辑 ---------------- */
  const stripDedupeSuffix = (name) => String(name || '').replace(/ #\d+$/, '');

  /** 在订阅里定位原始节点；渲染层看到的名字可能带全局去重后缀「 #2」 */
  /** 节点改名后同步地区组的 selected/best 引用，避免策略仍指向旧名 */
  const remapRegionNode = (d, oldName, newName) => {
    if (!oldName || oldName === newName) return;
    for (const r of d.regions || []) {
      if (r.selected === oldName) r.selected = newName;
      if (r.best === oldName) r.best = newName;
    }
  };

  const resolveSubNode = (sub, name) => {
    if (!sub || !Array.isArray(sub.nodes)) return null;
    const exact = sub.nodes.filter((n) => n.name === name);
    if (exact.length > 1) return { ambiguous: true };
    if (exact.length === 1) return { index: sub.nodes.indexOf(exact[0]), node: exact[0] };
    const base = stripDedupeSuffix(name);
    const cands = sub.nodes.filter((n) => n.name === base);
    if (cands.length > 1) return { ambiguous: true };
    if (cands.length === 1) return { index: sub.nodes.indexOf(cands[0]), node: cands[0] };
    return null;
  };

  const nameTakenElsewhere = (state, subId, index, name) => {
    const lower = String(name || '').toLowerCase();
    for (const sub of state.subscriptions || []) {
      if ((sub.nodes || []).some((n, i) => !(sub.id === subId && i === index) && String(n.name || '').toLowerCase() === lower)) return true;
    }
    for (const n of state.localNodes || []) {
      if (String(n.name || '').toLowerCase() === lower) return true;
    }
    return false;
  };

  ipcMain.handle('sub:node:get', async (_e, { subId, name } = {}) => {
    const sub = store.get().subscriptions.find((s) => s.id === subId);
    if (!sub) return { ok: false, error: '订阅不存在' };
    const found = resolveSubNode(sub, name);
    if (!found || found.ambiguous) return { ok: false, error: found && found.ambiguous ? '该订阅内存在重名节点，暂不支持编辑' : '节点不存在，可能已被订阅更新覆盖' };
    return { ok: true, subName: sub.name, subEnabled: sub.enabled !== false, node: { ...found.node } };
  });

  ipcMain.handle('sub:node:save', async (_e, { subId, name, node } = {}) => {
    const sub = store.get().subscriptions.find((s) => s.id === subId);
    if (!sub) return { ok: false, error: '订阅不存在' };
    const found = resolveSubNode(sub, name);
    if (!found || found.ambiguous) return { ok: false, error: found && found.ambiguous ? '该订阅内存在重名节点，暂不支持编辑' : '节点不存在，可能已被订阅更新覆盖' };
    const rec = node && typeof node === 'object' ? node : {};
    const old = found.node;
    const newName = sanitizeProxyName(rec.name || old.name, old.name);
    const server = String(rec.server || '').trim();
    const port = Number(rec.port);
    const type = String(rec.type || old.type || '').trim().toLowerCase();
    if (!server) return { ok: false, error: '服务器不能为空' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '端口需要是 1-65535 的整数' };
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(type)) return { ok: false, error: '协议类型无效' };
    if (newName.toLowerCase() !== old.name.toLowerCase()) {
      const st = store.get();
      if (nameTakenElsewhere(st, sub.id, found.index, newName)) return { ok: false, error: `已有节点使用名称「${newName}」，mihomo 不允许重名` };
    }
    const merged = { ...old, name: newName, type, server, port, udp: rec.udp !== false, enabled: rec.enabled !== false };
    for (const key of ['password', 'uuid', 'username', 'cipher', 'sni', 'servername', 'alterId']) {
      if (Object.prototype.hasOwnProperty.call(rec, key) && rec[key] !== undefined) merged[key] = rec[key];
    }
    delete merged.raw;
    store.update((d) => {
      const s = d.subscriptions.find((x) => x.id === subId);
      if (!s || !Array.isArray(s.nodes)) return;
      if (s.nodes[found.index]) s.nodes[found.index] = merged;
      else {
        const i = s.nodes.findIndex((n) => n.name === old.name);
        if (i >= 0) s.nodes[i] = merged;
      }
      remapRegionNode(d, old.name, merged.name);
    });
    broadcastState();
    const applied = await core.apply();
    return { ok: true, name: merged.name, applied };
  });

  /* ---------------- 本地节点 server_local ---------------- */
  ipcMain.handle('local:importText', async (_e, { text }) => {
    const r = parseLocalText(text);
    const nodes = (r.nodes || []).map((n) => ({ ...n, id: uid('ln'), enabled: true }));
    return { ok: nodes.length > 0, nodes: nodes.map((n) => ({ name: n.name, type: n.type, server: n.server, port: n.port, id: n.id, raw: n })), warnings: r.warnings, format: r.format, remotes: r.remotes || null };
  });

  ipcMain.handle('local:save', async (_e, { node }) => {
    if (!node || typeof node !== 'object') return { ok: false, error: '节点数据无效' };
    const server = String(node.server || '').trim();
    const port = Number(node.port);
    if (!server) return { ok: false, error: '服务器不能为空' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '端口需要是 1-65535 的整数' };
    const existing = (store.get().localNodes || []).find((x) => x.id === node.id);
    const name = sanitizeProxyName(node.name || `${server}:${port}`, `${server}:${port}`);
    if (existing && name.toLowerCase() !== String(existing.name || '').toLowerCase()) {
      const taken = (store.get().localNodes || []).some((x) => x.id !== existing.id && String(x.name || '').toLowerCase() === name.toLowerCase())
        || (store.get().subscriptions || []).some((s) => (s.nodes || []).some((n) => String(n.name || '').toLowerCase() === name.toLowerCase()));
      if (taken) return { ok: false, error: `已有节点使用名称「${name}」，mihomo 不允许重名` };
    }
    store.update((d) => {
      const clean = { ...node, name, server, port };
      delete clean.raw;
      const current = (d.localNodes || []).find((x) => x.id === node.id);
      if (current) Object.assign(current, clean);
      else d.localNodes.push({ ...clean, id: clean.id || uid('ln'), enabled: clean.enabled !== false });
      remapRegionNode(d, existing && existing.name, name);
    });
    broadcastState();
    await core.apply();
    return { ok: true, name };
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
    let proxyChange = null;
    if (!r.ok && store.get().settings.systemProxy) {
      // 引擎没起来：把系统代理挪回混合端口，避免指着没有监听者的重写端口
      let port;
      try { port = Number(core.controllerCoords().mixedPort) || Number(store.get().settings.mixedPort) || 7890; }
      catch (_) { port = Number(store.get().settings.mixedPort) || 7890; }
      try { await setSystemProxy(true, { port }); } catch (_) {}
    }
    if (r.ok) {
      if (!store.get().settings.systemProxy) {
        const sp = await setSystemProxy(true, { port: effectiveProxyPort() });
        if (sp.ok) { store.update((d) => { d.settings.systemProxy = true; }); proxyChange = 'on'; }
      } else {
        await setSystemProxy(true, { port: effectiveProxyPort() });
      }
    }
    await broadcastRewrite();
    broadcastState();
    return { ...r, proxyChange };
  });
  ipcMain.handle('rewrite:stop', async () => {
    let proxyChange = null;
    // 先关系统代理（此时引擎仍在监听，不会出现死端口窗口），再停引擎。
    if (store.get().settings.systemProxy) {
      let port;
      try { port = Number(core.controllerCoords().mixedPort) || Number(store.get().settings.mixedPort) || 7890; }
      catch (_) { port = Number(store.get().settings.mixedPort) || 7890; }
      const sp = await setSystemProxy(false, { port });
      if (sp.ok) { store.update((d) => { d.settings.systemProxy = false; }); proxyChange = 'off'; }
    }
    const r = await rewrite.stop();
    await broadcastRewrite();
    broadcastState();
    return { ...r, proxyChange };
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

  /* ---------------- 线上重写规则集 ---------------- */
  const remoteSetMeta = (set) => {
    if (!set) return null;
    const { rules, ...rest } = set;
    return { ...rest, rulesCount: (rules || []).length };
  };

  const failRemoteSet = (id, message) => {
    store.update((d) => {
      const s = (d.rewriteRemoteSets || []).find((x) => x.id === id);
      if (s) { s.lastError = String(message || '更新失败').slice(0, 500); s.lastAttemptAt = Date.now(); }
    });
    broadcastState();
  };

  const updateRewriteRemoteSet = async (id) => {
    const rec = (store.get().rewriteRemoteSets || []).find((s) => s.id === id);
    if (!rec) return { ok: false, error: '线上规则集不存在' };
    if (!/^https?:\/\//i.test(String(rec.url || ''))) {
      const msg = '只支持 http(s) 链接';
      failRemoteSet(id, msg);
      return { ok: false, error: msg };
    }
    let res;
    try {
      res = await download(rec.url, { timeout: 20000, maxBytes: 4 * 1024 * 1024 });
    } catch (err) {
      const msg = '下载失败：' + (err.message || '未知错误');
      failRemoteSet(id, msg);
      return { ok: false, error: msg };
    }
    const parsed = parseRewriteText(res.text, { setName: rec.name });
    if (!parsed.rules.length) {
      const msg = parsed.warnings.join('；').slice(0, 500) || '未解析到任何规则';
      failRemoteSet(id, msg);
      return { ok: false, error: msg, warnings: parsed.warnings };
    }
    store.update((d) => {
      const s = (d.rewriteRemoteSets || []).find((x) => x.id === id);
      if (!s) return;
      s.rules = parsed.rules;
      s.rulesCount = parsed.rules.length;
      s.updatedAt = Date.now();
      s.lastAttemptAt = Date.now();
      s.lastError = null;
      s.lastWarnings = parsed.warnings.slice(0, 10);
    });
    broadcastState();
    try { await broadcastRewrite(); } catch (_) {}
    return { ok: true, rulesCount: parsed.rules.length, warnings: parsed.warnings };
  };

  ipcMain.handle('rewrite:remote:save', async (_e, { set: payload } = {}) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const name = String(input.name || '').trim();
    const url = String(input.url || '').trim();
    if (!name) return { ok: false, error: '请填写规则集名称' };
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '规则集地址需要是 http(s) 链接' };
    const interval = Number(input.interval);
    if (!Number.isFinite(interval) || interval < 0 || interval > 10080) return { ok: false, error: '更新间隔需要是 0-10080 分钟' };
    const id = String(input.id || '') || uid('rws');
    let urlChanged = false;
    store.update((d) => {
      if (!Array.isArray(d.rewriteRemoteSets)) d.rewriteRemoteSets = [];
      const idx = d.rewriteRemoteSets.findIndex((x) => x.id === id);
      if (idx >= 0) {
        urlChanged = String(d.rewriteRemoteSets[idx].url || '') !== url;
        d.rewriteRemoteSets[idx] = {
          ...d.rewriteRemoteSets[idx],
          name: sanitizeProxyName(name, '线上规则集'),
          url, interval,
          enabled: input.enabled !== false,
          ...(urlChanged ? { rules: [], rulesCount: 0, updatedAt: null, lastError: null } : {})
        };
      } else {
        d.rewriteRemoteSets.push({
          id, name: sanitizeProxyName(name, '线上规则集'), url, interval,
          enabled: input.enabled !== false, updatedAt: null, rulesCount: 0, lastError: null, rules: []
        });
      }
    });
    broadcastState();
    const rec = (store.get().rewriteRemoteSets || []).find((s) => s.id === id);
    return { ok: true, set: remoteSetMeta(rec), urlChanged };
  });

  ipcMain.handle('rewrite:remote:remove', async (_e, { id } = {}) => {
    store.update((d) => { d.rewriteRemoteSets = (d.rewriteRemoteSets || []).filter((s) => s.id !== id); });
    broadcastState();
    try { await broadcastRewrite(); } catch (_) {}
    return { ok: true };
  });

  ipcMain.handle('rewrite:remote:update', async (_e, { id } = {}) => updateRewriteRemoteSet(id));

  ipcMain.handle('rewrite:remote:updateAll', async () => {
    const sets = (store.get().rewriteRemoteSets || []).filter((s) => s.enabled !== false && /^https?:\/\//i.test(String(s.url || '')));
    const results = [];
    for (const s of sets) {
      try { results.push({ id: s.id, name: s.name, ...(await updateRewriteRemoteSet(s.id)) }); }
      catch (err) { results.push({ id: s.id, name: s.name, ok: false, error: err.message }); }
    }
    return { ok: true, results };
  });

  /* 定时更新：每 10 分钟检查一次，按各规则集的 interval（分钟）判断是否到期 */
  const dueRewriteRemotes = async () => {
    const now = Date.now();
    const due = (store.get().rewriteRemoteSets || []).filter((s) => {
      if (s.enabled === false || !/^https?:\/\//i.test(String(s.url || ''))) return false;
      const interval = Number(s.interval);
      if (!Number.isFinite(interval) || interval <= 0) return false;
      return !s.updatedAt || now - Number(s.updatedAt) > interval * 60 * 1000;
    });
    for (const s of due) {
      try { await updateRewriteRemoteSet(s.id); } catch (_) {}
    }
  };
  const remoteTimer = setInterval(() => { dueRewriteRemotes().catch(() => {}); }, 10 * 60 * 1000);
  if (remoteTimer && typeof remoteTimer.unref === 'function') remoteTimer.unref();
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
  ipcMain.handle('core:stop', async () => {
    const r = await core.stop();
    // 内核停了重写引擎就没有上游：系统代理若还指着重写端口，走系统代理的程序会全部连不上。
    if (r && r.ok && store.get().settings.systemProxy && rewrite && rewrite.snapshot().running) {
      try { await setSystemProxy(false, { port: store.get().settings.mixedPort }); } catch (_) {}
      store.update((d) => { d.settings.systemProxy = false; });
      broadcastState();
      send('toast', { kind: 'warn', message: '内核已停止，系统代理已自动关闭（重写引擎没有上游）' });
    }
    return r;
  });
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
    // 写注册表失败就不要把 settings 也改成"已接管"，否则界面会和真实状态打架。
    if (r.ok) {
      store.update((d) => { d.settings.systemProxy = !!enable; });
      broadcastState();
    }
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
