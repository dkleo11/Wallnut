'use strict';

const { Notification, nativeImage } = require('electron');
const fs = require('fs');

let prefEnabled = () => true;
let iconPath = null;
let getTray = () => null;

function configure({ enabled, icon, tray } = {}) {
  if (typeof enabled === 'function') prefEnabled = enabled;
  else if (typeof enabled === 'boolean') prefEnabled = () => enabled;
  if (icon) iconPath = icon;
  if (typeof tray === 'function') getTray = tray;
}

/**
 * 系统通知：优先 Windows toast，不支持时退回托盘气泡。
 * @returns {{ok:boolean, via:'toast'|'balloon'|'disabled'|'none'}}
 */
function notify(opts = {}) {
  try {
    if (!prefEnabled()) return { ok: false, via: 'disabled' };
    const icon = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
    const title = opts.title || 'Wallnut';
    const body = opts.body || '';

    const tray = getTray();
    // 便携版没有开始菜单 AUMID 快捷方式，Windows Toast 会把发送者显示为 Electron。
    // 使用托盘系统气泡可保留 Wallnut 图标和标题，且不向文件夹外写任何文件。
    if (process.env.WALLNUT_PORTABLE === '1' && tray && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({ title: 'Wallnut', content: body, icon, respectQuietTime: false });
      return { ok: true, via: 'balloon' };
    }

    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: opts.silent !== false, icon });
      n.on('click', () => { try { opts.onClick && opts.onClick(); } catch (_) {} });
      n.show();
      return { ok: true, via: 'toast' };
    }

    if (tray && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({ title: 'Wallnut', content: body, icon, respectQuietTime: false });
      return { ok: true, via: 'balloon' };
    }
    return { ok: false, via: 'none' };
  } catch (_) {
    return { ok: false, via: 'none' };
  }
}

module.exports = { notify, configure };
