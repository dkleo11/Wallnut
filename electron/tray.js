'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const paths = require('./paths');
const autostart = require('./autostart');
const { notify } = require('./notify');
const { tr } = require('./i18n');
const { setSystemProxy } = require('./net/system-proxy');
const { ControllerApi } = require('./core/api');

const MODE_LABEL = { rule: '规则分流', global: '全部代理', direct: '全部直连' };

/** 运行模式二级菜单左侧的三横线图标：颜色与首页 Windmill 保持一致
 *  规则分流 = 红/蓝/橙，全部代理 = 全蓝，全部直连 = 全橙。16px + @2x 表示。 */
const MODE_ICON_DATA = {
  rule: { s1: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAYUlEQVR4nGNgGPKAEV3ghI7qf0KaLK7chutjIlUzujomXCYT6wKKASO6QOz2kwS9sdjTHHsYxBKhGV0dEy6TiXUBxYARXeDOAmuC3lBJOIo9DO4QoRldHYoByCYT64KBBwBoDCQQWYUd+AAAAABJRU5ErkJggg==', s2: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjklEQVR4nGNgGAWjYKQDRkIKTuio/qfUEosrt3Haw0RrywmZw8QwwIBpUDvAAk/ckQKoZc4ooAlgJKQgdvtJirPiYk9z8sqBWCpYTsgcJoYBBkyD2gGL8cQdKYBa5owCmgBGQgruLLCmOCuqJBwlrxy4QwXLCZnDxDDAgGlQO0AFT9yRAqhlzigYBQy0AABLGSQcGUya/AAAAABJRU5ErkJggg==' },
  global: { s1: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANUlEQVR4nGNgGPKAEV0gdvvJ/4Q0LfY0h+tjIlUzujomXCYT6wKKASO6wGgYMIzEMGCgFAAA/8gkELWixvUAAAAASUVORK5CYII=', s2: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAX0lEQVR4nGNgGAWjYKQDRkIKYref/E+pJYs9zXHaw0RrywmZw8QwwIBpUDtgMZ64IwVQy5xRQBPASEjBaDlAa8A0qB2weLQcGAmAkZCC0XKA1oBpUDtg8Wg5MApGAgAATOokHIYSgToAAAAASUVORK5CYII=' },
  direct: { s1: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANUlEQVR4nGNgGPKAEV3gzgLr/4Q0qSQchetjIlUzujomXCYT6wKKASO6wGgYMIzEMGCgFAAAtdwkEFlOAD8AAAAASUVORK5CYII=', s2: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXklEQVR4nGNgGAWjYKQDRkIK7iyw/k+pJSoJR3Haw0RrywmZw8QwwIBpUDtABU/ckQKoZc4ooAlgJKRgtBygNWAa1A5QGS0HRgJgJKRgtBygNWAa1A5QGS0HRsFIAADV2CQct7T5nQAAAABJRU5ErkJggg==' }
};

const modeIconCache = Object.create(null);
function modeIcon(mode) {
  const key = MODE_ICON_DATA[mode] ? mode : 'rule';
  if (modeIconCache[key]) return modeIconCache[key];
  const d = MODE_ICON_DATA[key];
  const img = nativeImage.createFromDataURL('data:image/png;base64,' + d.s1);
  img.addRepresentation({ scaleFactor: 2, dataURL: 'data:image/png;base64,' + d.s2 });
  modeIconCache[key] = img;
  return img;
}

class TrayManager {
  constructor({ store, core, rewrite, getWindow, showWindow, quit }) {
    this.store = store;
    this.core = core;
    this.rewrite = rewrite;
    this.getWindow = getWindow;
    this.showWindow = showWindow;
    this.quit = quit;
    this.tray = null;
    this.now = null;
    this.timer = null;
    this.refreshing = false;
  }

  destroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { if (this.tray) this.tray.destroy(); } catch (_) {}
    this.tray = null;
  }

  /** 重新创建图标：Explorer 偶发丢失托盘项时可强制重建 */
  reinit() {
    this.destroy();
    this.init();
    let bounds = null;
    try { bounds = this.tray ? this.tray.getBounds() : null; } catch (_) {}
    return { ok: !!this.tray, visible: !!(bounds && bounds.width > 0), bounds };
  }

  init() {
    if (this.tray) return;
    const base = paths.resourcesDir();
    const candidates = process.platform === 'win32' ? ['tray.png', 'tray.ico'] : ['tray.png'];
    let icon;
    for (const name of candidates) {
      try {
        const img = nativeImage.createFromPath(path.join(base, name));
        if (!img.isEmpty()) { icon = img; break; }
      } catch (_) {}
    }
    this.tray = new Tray(icon || nativeImage.createEmpty());
    this.tray.setToolTip('Wallnut · 未连接');
    this.tray.on('click', () => this.showWindow());
    this.tray.on('double-click', () => this.showWindow());
    this.refresh(true);
    this.timer = setInterval(() => this.refresh(), 4000);
  }

  async currentProxy() {
    if (!this.core.snapshot().running) { this.now = null; return; }
    try {
      const c = this.core.controllerCoords();
      const api = new ControllerApi(c.port, c.secret);
      const data = await api.get('/proxies', 4000);
      const main = (this.store.get().settings.defaultTarget || '主策略');
      const g = data && data.proxies && data.proxies[main];
      this.now = (g && g.now) || (data && data.proxies && data.proxies.GLOBAL && data.proxies.GLOBAL.now) || null;
    } catch (_) { this.now = this.now || null; }
  }

  async refresh(fast = false) {
    if (!this.tray || this.refreshing) return;
    this.refreshing = true;
    try {
      await this.currentProxy();
      this.build();
    } finally {
      this.refreshing = false;
    }
  }

  build() {
    const st = this.store.get().settings;
    const running = this.core.snapshot().running;
    const mode = st.mode || 'rule';
    const status = running ? tr('已连接') : tr('未连接');
    this.tray.setToolTip(`Wallnut · ${status}${this.now ? ' · ' + this.now : ''}`);
    if (process.platform !== 'darwin') {
      this.tray.setTitle && this.tray.setTitle('');
    }

    const template = [
      { label: `Wallnut · ${status}${this.now ? ' · ' + this.now : ''}`, enabled: false },
      { type: 'separator' },
      { label: tr('显示主界面'), click: () => this.showWindow() },
      { label: tr(running ? '断开连接（停止内核）' : '连接（启动内核）'), click: () => this.toggleCore() },
      {
        label: tr('运行模式'),
        submenu: ['rule', 'global', 'direct'].map((m) => ({
          label: tr(MODE_LABEL[m]),
          type: 'normal',
          icon: modeIcon(m),
          click: () => this.setMode(m)
        }))
      },
      { type: 'separator' },
      { label: `${tr('当前节点')}：${this.now || tr('未运行')}`, enabled: false },
      { label: tr('打开节点选择'), click: () => this.openPage('nodes') },
      { label: tr('地区测速'), click: () => this.openPage('groups') },
      { type: 'separator' },
      {
        label: tr('开机自启动'),
        type: 'checkbox',
        checked: !!st.launchAtLogin,
        click: (item) => this.toggleAutostart(item.checked)
      },
      { label: tr('退出') + ' Wallnut', click: () => this.quit() }
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  openPage(page) {
    this.showWindow();
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('navigate', page);
  }

  async toggleCore() {
    if (this.core.snapshot().running) {
      await this.core.stop();
      // 内核停了重写就没有上游：系统代理还指着重写端口的话，走系统代理的程序会全部连不上。
      if (this.store.get().settings.systemProxy && this.rewrite && this.rewrite.snapshot().running) {
        try { await setSystemProxy(false, { port: this.store.get().settings.mixedPort }); } catch (_) {}
        this.store.update((d) => { d.settings.systemProxy = false; });
        notify({ title: 'Wallnut', body: '内核已停止，系统代理已自动关闭（重写没有上游）' });
      } else {
        notify({ title: 'Wallnut', body: '内核已停止' });
      }
    } else {
      const r = await this.core.start();
      notify({
        title: r.ok ? 'Wallnut 已连接' : 'Wallnut 内核启动失败',
        body: r.ok ? 'mihomo 内核已启动，可以正常上网了' : (r.error || '请打开主界面查看日志')
      });
    }
    this.refresh(true);
  }

  async setMode(mode) {
    const st = this.store.get().settings;
    if (st.mode === mode) return;
    this.store.update((d) => { d.settings.mode = mode; });
    try {
      const c = this.core.controllerCoords();
      await new ControllerApi(c.port, c.secret).patch('/configs', { mode }, 4000);
    } catch (_) {
      try { await this.core.apply(); } catch (_) {}
    }
    notify({ title: 'Wallnut', body: '运行模式：' + MODE_LABEL[mode] });
    this.refresh(true);
  }

  async toggleAutostart(enable) {
    const r = autostart.apply(enable);
    this.store.update((d) => { d.settings.launchAtLogin = !!enable; });
    notify({
      title: 'Wallnut',
      body: enable ? '已开启开机自启动（登录后最小化到托盘）' : '已关闭开机自启动',
      silent: true
    });
    if (!r.ok) notify({ title: 'Wallnut', body: '自启动设置失败：' + (r.error || '未知错误') });
    this.refresh(true);
  }
}

module.exports = { TrayManager };
