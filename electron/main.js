'use strict';

// 某些环境会注入 ELECTRON_RUN_AS_NODE=1，它会让 Electron 退化成纯 Node，必须清掉
if (process.env.ELECTRON_RUN_AS_NODE) delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, Menu, shell, nativeTheme, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./store').Store;
const { CoreManager } = require('./core/manager');
const { registerIpc, publicState, nodeList, regionSummary, updateDueSubscriptions } = require('./ipc');
const { setSystemProxy } = require('./net/system-proxy');
const { pickProxyPort } = require('./net/proxy-port');
const { createCrashGuard } = require('./core/crash-guard');
const { sleep } = require('./util');
const { TrayManager } = require('./tray');
const autostart = require('./autostart');
const i18n = require('./i18n');
const { notify, configure: configureNotify } = require('./notify');

const isDev = process.env.WALLNUT_DEV === '1';
const isSmoke = process.env.WALLNUT_SMOKE === '1';
const smokeOut = process.env.WALLNUT_SMOKE_OUT || path.join(process.cwd(), 'shot.png');
app.setName('Wallnut');

// 绿色便携模式：所有应用数据、Chromium 缓存、日志和临时文件均留在程序目录。
const portableRoot = process.resourcesPath ? path.dirname(process.resourcesPath) : '';
const isPortable = process.env.WALLNUT_PORTABLE === '1' || !!(portableRoot && fs.existsSync(path.join(portableRoot, 'portable.flag')));
if (isPortable) {
  const data = path.join(portableRoot, 'data');
  const temp = path.join(portableRoot, 'temp');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  process.env.WALLNUT_PORTABLE = '1';
  process.env.WALLNUT_DATA = data;
  process.env.TEMP = temp;
  process.env.TMP = temp;
  app.setPath('userData', data);
  app.setPath('sessionData', data);
  app.setPath('temp', temp);
  app.setPath('logs', path.join(data, 'logs'));
  app.setPath('crashDumps', path.join(data, 'crash-dumps'));
}

// 便携版使用独立 AUMID，避免沿用 Electron/旧快捷方式的任务栏图标缓存。
app.setAppUserModelId(isPortable ? 'Wallnut' : 'com.wallnut.app');


const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main();
}

let win = null;
let store = null;
let core = null;
let rewrite = null;
let ca = null;
let ipcBridge = null;
let subTimer = null;
let quitting = false;
let trayMgr = null;
let notifiedHidden = false;
const hiddenLaunch = process.argv.includes('--hidden');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.setSkipTaskbar(false);
  win.show();
  win.focus();
}

function createWindow() {
  const boundsFile = path.join(require('./paths').dataDir(), 'window.json');
  let bounds = { width: 1240, height: 820 };
  try {
    if (fs.existsSync(boundsFile)) bounds = { ...bounds, ...JSON.parse(fs.readFileSync(boundsFile, 'utf8')) };
  } catch (_) {}

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    skipTaskbar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1C1C1E' : '#F2F2F7',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'resources', 'icon.ico'),
    title: 'Wallnut',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      offscreen: isSmoke
    }
  });

  Menu.setApplicationMenu(null);

  // 渲染层日志回显到主进程 stdout（离屏冒烟 / 开发时排查 import 与运行期错误）
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[renderer] did-fail-load', code, desc, url);
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    console.log('[preload] error', p, err && err.message);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  let firstFrameReady = false;
  let domReady = false;
  const revealWindow = () => {
    if (!firstFrameReady || !domReady || isSmoke || hiddenLaunch) return;
    win.setSkipTaskbar(false);
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  };
  win.webContents.once('did-finish-load', () => { domReady = true; revealWindow(); });

  win.once('ready-to-show', () => {
    firstFrameReady = true;
    if (isSmoke) {
      // 离屏冒烟：等首页数据就位后截图并退出，便于无人值守验证 UI
      setTimeout(async () => {
        try {
          const evalJs = (code, ms = 4000) => Promise.race([
            win.webContents.executeJavaScript(code).catch((e) => 'EVALFAIL ' + e.message),
            new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))
          ]);
          const pages = (process.env.WALLNUT_SMOKE_PAGES || '').split(',').filter(Boolean);
          for (const pg of pages) {
            await win.webContents.executeJavaScript(`window.__wallnutDebug && window.__wallnutDebug.setPage('${pg}')`).catch(() => {});
            await sleep(900);
            const info = await win.webContents.executeJavaScript('JSON.stringify({errs: (window.__errs||[]).slice(-5), len: (document.getElementById("root")||{innerHTML:""}).innerHTML.length, txt: ((document.querySelector(".content")||{}).innerText||"").slice(0,600)})').catch((e) => 'evalfail ' + e.message);
            console.log('[page]', pg, info);
            const shotDir = process.env.WALLNUT_SMOKE_SHOTS;
            if (shotDir) {
              try {
                const img = await win.webContents.capturePage();
                fs.writeFileSync(path.join(shotDir, pg + '.png'), img.toPNG());
              } catch (_) {}
            }
          }
          if (process.env.WALLNUT_SMOKE_TEST) {
            console.log('[test-start]', await evalJs(`window.wallnut.invoke('test:start',{scope:'region',regionId:'hk',names:['香港 01 · HKT','香港 02 · HKT','香港 03 · IPLC'],url:'http://127.0.0.1:1/204',timeout:1500,concurrency:3}).then(r=>JSON.stringify({ok:r.ok,error:r.error})).catch(e=>'ERR '+e.message)`, 3000));
            await sleep(7000);
            console.log('[test-state]', await evalJs(`JSON.stringify({running:window.__wallnutDebug.S.test&&window.__wallnutDebug.S.test.running,done:window.__wallnutDebug.S.test&&window.__wallnutDebug.S.test.done,results:((window.__wallnutDebug.S.test&&window.__wallnutDebug.S.test.results)||[]).map(r=>r.name+':'+(r.ok?r.delay:r.error))})`, 4000));
            console.log('[region-best]', await evalJs(`JSON.stringify(window.__wallnutDebug.S.regions.filter(r=>r.id==='hk').map(r=>({best:r.best,count:r.count})))`, 3000));
          }
          if (process.env.WALLNUT_SMOKE_TABS) {
            const clickTab = async (pageId, label) => {
              await evalJs(`window.__wallnutDebug.setPage('${pageId}')`, 2000);
              await sleep(700);
              const clicked = await evalJs(`(function(){const b=[...document.querySelectorAll('.seg button')].find(x=>x.textContent.indexOf('${label}')>=0); if(!b) return 'NO_SEG'; b.click(); return 'CLICKED';})()`, 2500);
              await sleep(900);
              const text = await evalJs(`((document.querySelector('.content')||{}).innerText||'').split(String.fromCharCode(10)).join(' | ').slice(0,260)`, 2500);
              console.log(`[tab ${pageId}->${label}]`, clicked, text);
              const img = await win.webContents.capturePage();
              fs.writeFileSync(path.join(process.env.WALLNUT_SMOKE_SHOTS || '.', `${pageId}-tab.png`), img.toPNG());
            };
            await clickTab('nodes', '订阅与本地节点');
            await clickTab('groups', '地区测速');
          }
          if (process.env.WALLNUT_SMOKE_CONN) {
            const mock = JSON.stringify([
              { id: 'c1', metadata: { host: 'example.com', destinationPort: 443, type: 'HTTPS', network: 'tcp' }, chains: ['主策略', '香港', '香港 01'], upload: 1024, download: 8192, start: new Date().toISOString(), rule: 'GEOIP', rulePayload: 'CN' },
              { id: 'c2', metadata: { host: '192.168.31.1', destinationPort: 80, type: 'HTTP', network: 'tcp' }, chains: ['DIRECT'], upload: 12, download: 64, start: new Date().toISOString(), rule: 'IP-CIDR', rulePayload: '192.168.0.0/16' }
            ]);
            await evalJs(`window.__wallnutDebug.set({ runtime: Object.assign({}, window.__wallnutDebug.S.runtime, { connections: ${mock} }) })`, 3000);
            await evalJs(`window.__wallnutDebug.setPage('activity')`, 2000); await sleep(300);
            console.log('[conn policy]', await evalJs(`JSON.stringify({headers:[...document.querySelectorAll('.conn-head span')].map(x=>x.innerText),policies:[...document.querySelectorAll('.conn-policy')].map(x=>x.innerText),rows:document.querySelectorAll('.conn-row').length})`, 3000));
          }
          if (process.env.WALLNUT_SMOKE_MODES) {
            await evalJs(`window.__wallnutDebug.setPage('home')`, 2000); await sleep(350);
            const readModes = () => evalJs(`JSON.stringify({colors:[...document.querySelectorAll('.mode .mode-lines path')].map(p=>p.getAttribute('stroke')),tiles:[...document.querySelectorAll('.tiles .tile')].map(t=>t.innerText.split(String.fromCharCode(10))[0])})`, 2500);
            console.log('[mode rule]', await readModes());
            await evalJs(`window.wallnut.invoke('app:settings:save',{mode:'global'})`, 5000); await sleep(250);
            console.log('[mode global]', await readModes());
            await evalJs(`window.wallnut.invoke('app:settings:save',{mode:'direct'})`, 5000); await sleep(250);
            console.log('[mode direct]', await readModes());
            await evalJs(`window.wallnut.invoke('app:settings:save',{mode:'rule'})`, 5000);
          }
          if (process.env.WALLNUT_SMOKE_REWRITE) {
            const rule = { id: 'rw-smoke', type: 'reject', pattern: '^http://wallnut\.test/ad', action: '204', enabled: true };
            console.log('[rewrite save]', await evalJs(`window.wallnut.invoke('rewrite:save', { rule: ${JSON.stringify(rule)} })`, 5000));
            console.log('[rewrite enable]', await evalJs(`window.wallnut.invoke('app:settings:save', { rewriteEnabled: true })`, 8000));
            console.log('[rewrite status]', await evalJs(`window.wallnut.invoke('rewrite:status')`, 5000));
            const code = await new Promise((resolve) => {
              const req = require('http').get({ host: '127.0.0.1', port: 8890, path: 'http://wallnut.test/ad', headers: { Host: 'wallnut.test' } }, (res) => { res.resume(); resolve(res.statusCode); });
              req.on('error', () => resolve(0)); req.setTimeout(4000, () => { req.destroy(); resolve(0); });
            });
            console.log('[rewrite real request] status =', code);
            console.log('[rewrite proxy enabled]', JSON.stringify(await require('./net/system-proxy').readProxyState()));
            console.log('[rewrite ca generate]', await evalJs(`window.wallnut.invoke('rewrite:caGenerate')`, 20000));
            console.log('[rewrite cleanup]', await evalJs(`window.wallnut.invoke('rewrite:remove', { id: 'rw-smoke' })`, 5000));
            console.log('[rewrite disable]', await evalJs(`window.wallnut.invoke('app:settings:save', { rewriteEnabled: false })`, 8000));
            console.log('[rewrite proxy disabled]', JSON.stringify(await require('./net/system-proxy').readProxyState()));
          }
          if (process.env.WALLNUT_SMOKE_NAV) {
            await evalJs(`window.__wallnutDebug.setPage('home')`, 2000); await sleep(350);
            const clickMetric = async (i) => evalJs(`(function(){const m=document.querySelectorAll('.metric.clickable')[${i}];if(!m)return 'NO_METRIC';m.click();return 'CLICKED';})()`, 2000);
            console.log('[nav node]', await clickMetric(0));
            await sleep(250);
            console.log('[nav node page]', await evalJs(`window.__wallnutDebug.S.page`, 2000));
            await evalJs(`window.__wallnutDebug.setPage('home')`, 2000); await sleep(250);
            console.log('[nav rules]', await clickMetric(1));
            await sleep(250);
            console.log('[nav rules page]', await evalJs(`window.__wallnutDebug.S.page`, 2000));
            console.log('[icon loaded]', await evalJs(`(function(){const i=document.querySelector('.logo img');return JSON.stringify({found:!!i,complete:i&&i.complete,width:i&&i.naturalWidth});})()`, 2000));
          }
          if (process.env.WALLNUT_SMOKE_TRAY) {
            console.log('[tray status]', await evalJs(`window.wallnut.invoke('app:autostartStatus').then(r=>JSON.stringify(r)).catch(e=>'ERR '+e.message)`, 3000));
            console.log('[notify test]', await evalJs(`window.wallnut.invoke('app:notifyTest').then(r=>JSON.stringify(r)).catch(e=>'ERR '+e.message)`, 3000));
            console.log('[autostart on]', await evalJs(`window.wallnut.invoke('app:autostart',{enable:true}).then(r=>JSON.stringify(r)).catch(e=>'ERR '+e.message)`, 4000));
            await sleep(600);
            console.log('[autostart after on]', await evalJs(`window.wallnut.invoke('app:autostartStatus').then(r=>JSON.stringify(r)).catch(e=>'ERR '+e.message)`, 3000));
            console.log('[autostart off]', await evalJs(`window.wallnut.invoke('app:autostart',{enable:false}).then(r=>JSON.stringify(r)).catch(e=>'ERR '+e.message)`, 4000));
            await sleep(600);
            console.log('[autostart after off]', await evalJs(`window.wallnut.invoke('app:autostartStatus').then(r=>JSON.stringify(r)).catch(e=>'ERR '+e.message)`, 3000));
          }
          if (process.env.WALLNUT_SMOKE_CLOSE) {
            win.close();
            await sleep(400);
            console.log('[close test]', JSON.stringify({ hidden: !win.isVisible(), closeToTray: store.get().settings.closeToTray, alive: true }));
          }
          if (process.env.WALLNUT_SMOKE_DOM) {
            console.log('[dom conn]', await evalJs(`(function(){const c=document.querySelector('.conn');if(!c)return 'NO_CONN';const r=c.querySelector('.ripple');const cs=r?getComputedStyle(r):null;return JSON.stringify({cls:c.className,html:c.outerHTML.slice(0,180),anim:cs?cs.animationName:'none'});})()`, 3000));
          }
          const diag = await win.webContents.executeJavaScript('JSON.stringify({errs: window.__errs||[], rootLen: (document.getElementById("root")||{innerHTML:""}).innerHTML.length, head: (document.getElementById("root")||{innerHTML:""}).innerHTML.slice(0,120)})');
          console.log('[wallnut] renderer diag:', diag);
          const img = await win.webContents.capturePage();
          fs.writeFileSync(smokeOut, img.toPNG());
          console.log('[wallnut] smoke shot ->', smokeOut);
        } catch (err) {
          console.log('[wallnut] smoke capture failed:', err.message);
        }
        try { await core.stop(); } catch (_) {}
        app.exit(0);
      }, Number(process.env.WALLNUT_SMOKE_WAIT || 9000));
      return;
    }
    revealWindow();
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    try { fs.writeFileSync(boundsFile, JSON.stringify(b)); } catch (_) {}
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  win.on('close', (e) => {
    try {
    if (quitting) return;
    const st = store ? store.get().settings : {};
    const action = st.closeAction || (st.closeToTray === false ? 'quit' : 'tray');
    if (action === 'tray' && trayMgr) {
      e.preventDefault();
      win.hide();
      if (!notifiedHidden) {
        notifiedHidden = true;
        notify({ title: 'Wallnut 仍在后台运行', body: '窗口已隐藏；右键托盘图标可切换节点、模式或退出。' });
      }
      return;
    }
    if (action === 'taskbar') {
      e.preventDefault();
      win.minimize();
      return;
    }
    } catch (err) {
      console.error('[wallnut] close handler failed:', err && (err.stack || err.message));
      try { e.preventDefault(); win.hide(); } catch (_) {}
    }
  });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

async function autoUpdateSubscriptions() {
  if (!ipcBridge) return;
  try {
    const results = await updateDueSubscriptions(store, ipcBridge.applySub, (t) => send('toast', t));
    if (results.length) {
      const failed = results.filter((r) => !r.ok);
      send('toast', { kind: failed.length ? 'error' : 'info', message: `已更新 ${results.length - failed.length}/${results.length} 个订阅` });
      if (failed.length) notify({ title: '订阅更新失败', body: failed.map((f) => `${f.name}：${f.error || '未知错误'}`).slice(0, 3).join(' · ') });
    }
  } catch (err) {
    send('toast', { kind: 'error', message: '自动更新订阅失败：' + err.message });
  }
}

function main() {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    store = new Store();
    store.load();
    i18n.setLanguage(store.get().settings.language || 'zh-CN');
    // 主题
    const ui = store.get().ui || {};
    if (['light', 'dark', 'system'].includes(ui.theme)) nativeTheme.themeSource = ui.theme;

    core = new CoreManager(store);
    core.on('status', (st) => {
      send('core', st);
      if (trayMgr) trayMgr.refresh(true);
      if (st.status === 'error' && st.error) {
        notify({ title: 'Wallnut 内核异常', body: st.error });
      } else if (st.running && !global.__wallnutLoggedRunning) {
        global.__wallnutLoggedRunning = true;
      }
    });
    // 内核意外退出（非主动停止）时，若系统代理指向重写端口而内核又没自动重启回来，就自动关闭系统代理。
    const onCoreCrash = createCrashGuard({
      store, core,
      getRewrite: () => rewrite,
      setSystemProxy,
      onFix: () => {
        try { if (ipcBridge) ipcBridge.broadcastState(); } catch (_) {}
        notify({ title: 'Wallnut 内核异常退出', body: '系统代理已自动关闭（重写引擎没有上游），请打开主界面查看内核日志。' });
        try { send('toast', { kind: 'warn', message: '内核异常退出，系统代理已自动关闭（重写没有上游）' }); } catch (_) {}
      }
    });
    core.on('crash', () => onCoreCrash());
    core.on('log', (l) => {
      send('log', l);
      if (l && l.line && l.line.includes('连续崩溃')) {
        notify({ title: 'Wallnut 内核已停止自动重启', body: '连续崩溃超过上限，请打开主界面查看日志。' });
      }
    });
    core.on('meta', (m) => send('toast', { kind: 'meta', message: `配置已重建：${m.nodeCount} 个节点 / ${m.groupCount} 个策略组` }));

    const { RewriteEngine } = require('./rewrite/engine');
    const { CertificateAuthority } = require('./rewrite/ca');
    ca = new CertificateAuthority();
    rewrite = new RewriteEngine({ store, core, ca });
    rewrite.on('hit', () => send('rewrite', { engine: rewrite.snapshot() }));

    // Windows 通知归属：开始菜单快捷方式携带 AppUserModelID，否则通知会显示 Electron。
    if (process.platform === 'win32') {
      try {
        const root = path.join(__dirname, '..');
        const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Wallnut.lnk');
        const ok = shell.writeShortcutLink(link, 'replace', {
          target: process.execPath,
          cwd: root,
          args: app.isPackaged ? '' : `"${root}"`,
          description: 'Wallnut 代理客户端',
          icon: path.join(root, 'resources', 'icon.ico'),
          iconIndex: 0,
          appUserModelId: 'com.wallnut.app'
        });
        console.log('[wallnut] notification shortcut =', ok, link);
      } catch (err) { console.error('[wallnut] notification shortcut failed:', err && err.message); }
    }

    console.log('[wallnut] core =', require('./paths').coreBinary(), 'exists =', fs.existsSync(require('./paths').coreBinary()));
    createWindow();
    ipcBridge = registerIpc({ store, core, rewrite, ca, getWindow: () => win, showWindow, quitApp: () => app.quit(), trayMgr });

    // 系统通知 + 托盘
    configureNotify({
      enabled: () => store.get().settings.notifications !== false,
      icon: path.join(__dirname, '..', 'resources', 'icon.png'),
      tray: () => trayMgr && trayMgr.tray
    });
    trayMgr = new TrayManager({
      store, core, rewrite, getWindow: () => win, showWindow,
      quit: () => { quitting = true; app.quit(); },
      onSystemProxyChange: () => { try { if (ipcBridge) ipcBridge.broadcastState(); } catch (_) {} }
    });
    trayMgr.init();

    // 托盘图标可能被系统折叠，注册快捷键兜底：Ctrl+Alt+Q 随时唤出窗口
    try {
      const ok = globalShortcut.register('Control+Alt+Q', () => showWindow());
      console.log('[wallnut] hotkey Control+Alt+Q =', ok);
    } catch (err) {
      console.error('[wallnut] hotkey failed:', err && err.message);
    }

    if (process.env.WALLNUT_TEST_CLOSE) {
      setTimeout(() => {
        try { win.close(); } catch (err) { console.error('[test] close threw', err && err.message); }
      }, 1200);
      setTimeout(() => {
        console.log('[test] after close: alive=' + (!!win) + ' visible=' + (win && win.isVisible()));
      }, 4200);
      setTimeout(() => app.exit(0), 6000);
    }
    console.log('[wallnut] tray ready, autostart =', JSON.stringify(autostart.status()));

    // Windows 会把新图标折叠进 ^：4 秒后仍无 bounds 就强制重建一次（Explorer 偶发缓存）
    setTimeout(() => {
      try {
        const b = trayMgr.tray && trayMgr.tray.getBounds();
        if (!b || b.width === 0) {
          console.log('[wallnut] tray not pinned by shell, reinit');
          trayMgr.reinit();
        }
      } catch (_) {}
    }, 4000);

    // 开机自启动：启动时校准注册表（离屏冒烟不写系统项）
    if (!isSmoke) {
      try { autostart.sync(store.get().settings.launchAtLogin === true); } catch (_) {}
    }

    store.onChange((state) => {
      try { send('state', { state: publicState(state), nodes: nodeList(state), regions: regionSummary(state, nodeList(state)) }); } catch (_) {}
      if (trayMgr) trayMgr.refresh(true);
    });

    // 自动启动内核和重写代理，系统代理始终指向最终生效的入口
    if (store.get().settings.autoStartCore !== false) {
      const r = await core.start();
      if (!r.ok) {
        send('toast', { kind: 'error', message: '内核启动失败：' + (r.error || '未知错误') });
        notify({ title: 'Wallnut 内核启动失败', body: r.error || '请打开主界面查看日志' });
      }
    }
    if (store.get().settings.rewriteEnabled) {
      const r = await rewrite.start();
      if (!r.ok) send('toast', { kind: 'error', message: '重写引擎启动失败：' + (r.error || '未知错误') });
      // 重写只收得到系统代理过来的流量：启动时补开系统代理（TUN 保持不动）。
      // 但内核没起来时重写没有上游，开了系统代理等于让所有程序连不上，所以这种情况只提示、不动注册表。
      else if (!store.get().settings.systemProxy) {
        if (core.snapshot().running) store.update((d) => { d.settings.systemProxy = true; });
        else send('toast', { kind: 'warn', message: '重写已启用，但内核未运行：未自动开启系统代理（重写没有上游）' });
      }
    }
    if (store.get().settings.systemProxy) {
      // 与 ipc / 托盘共用同一套端口判断：重写在跑就指向重写端口。
      await setSystemProxy(true, { port: pickProxyPort({ store, core, rewrite }) });
    }

    // 订阅自动更新巡检
    subTimer = setInterval(() => { autoUpdateSubscriptions(); }, 10 * 60 * 1000);
  });

  app.on('window-all-closed', () => {
    // 关闭窗口即退出（closeToTray 为 true 时窗口只是隐藏）
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    try { if (subTimer) { clearInterval(subTimer); subTimer = null; } } catch (_) {}
    try { await setSystemProxy(false, { port: store.get().settings.mixedPort }); } catch (_) {}
    try { if (rewrite) await rewrite.stop(); } catch (_) {}
    try { await core.stop(); } catch (_) {}
    try { trayMgr && trayMgr.destroy(); } catch (_) {}
    store.saveNow();
    app.exit(0);
  });

  app.on('activate', () => showWindow());
}
