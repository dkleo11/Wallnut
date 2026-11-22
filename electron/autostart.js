'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE = 'Wallnut';

/**
 * 开机自启动（用户级，无需管理员）。
 * 策略：先尝试 HKCU Run 注册表；被拦截时退回「启动文件夹 + VBS」。
 *  实测：本机 Electron 子进程写注册表会被拒（Access denied），
 *  但写启动文件夹正常，所以 VBS 是可靠兜底，且不会弹控制台窗口。
 * 两者只保留一个，避免登录时启动两次。
 */

function startupDir() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function vbsPath() {
  return path.join(startupDir(), 'Wallnut.vbs');
}

function target() {
  const root = path.join(__dirname, '..');
  return { exe: process.execPath, app: root, cwd: root, args: app.isPackaged ? '--hidden' : `"${root}" --hidden` };
}

function quotedCommand() {
  const t = target();
  return `"${t.exe}" ${t.args}`;
}

function regQuery() {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', VALUE], { encoding: 'utf8', windowsHide: true, timeout: 6000 });
    const m = out.match(new RegExp(VALUE + '\\s+REG_SZ\\s+(.+)', 'i'));
    return { present: true, command: m ? m[1].trim() : '' };
  } catch (_) {
    return { present: false, command: '' };
  }
}

function hasVbs() {
  try { return fs.existsSync(vbsPath()); } catch (_) { return false; }
}

function writeVbs() {
  const t = target();
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const nl = String.fromCharCode(13, 10);
  // VBS: 0 = 隐藏窗口，False = 不等待
  const line = 'Set sh = CreateObject("WScript.Shell")' + nl + 'sh.Run ' + q(t.exe) + ' & " " & ' + q(t.args) + ', 0, False' + nl;
  // WSH 对含中文路径的脚本使用 UTF-16LE，避免 UTF-8 被按 ANSI 误读
  fs.writeFileSync(vbsPath(), '﻿' + line, 'utf16le');
}

function removeVbs() {
  try { fs.unlinkSync(vbsPath()); } catch (_) {}
}

function status() {
  const reg = regQuery();
  const vbs = hasVbs();
  return {
    openAtLogin: reg.present || vbs,
    method: reg.present ? 'registry' : vbs ? 'startup-folder' : 'none',
    command: reg.command || (vbs ? '启动文件夹 Wallnut.vbs' : ''),
    target: quotedCommand(),
    wasOpenedAtLogin: (() => { try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch (_) { return false; } })()
  };
}

function apply(enabled) {
  try {
    if (!enabled) {
      try { execFileSync('reg', ['delete', RUN_KEY, '/v', VALUE, '/f'], { windowsHide: true, timeout: 6000 }); } catch (_) {}
      removeVbs();
      try { app.setLoginItemSettings({ openAtLogin: false }); } catch (_) {}
      const st = status();
      return { ok: !st.openAtLogin, ...st };
    }
    let regOk = false;
    if (process.platform === 'win32') {
      try {
        execFileSync('reg', ['add', RUN_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', quotedCommand(), '/f'], { windowsHide: true, timeout: 6000 });
        regOk = true;
      } catch (_) { regOk = false; }
      try { app.setLoginItemSettings({ openAtLogin: true, path: target().exe, args: app.isPackaged ? ['--hidden'] : [path.join(__dirname, '..'), '--hidden'] }); } catch (_) {}
    }
    if (regOk) removeVbs();
    else if (process.env.WALLNUT_PORTABLE === '1') return { ok: false, error: '系统策略禁止写入用户启动注册表；便携版不会改为在启动文件夹生成 VBS。', ...status() };
    else writeVbs();
    const st = status();
    return { ok: st.openAtLogin, ...st };
  } catch (err) {
    return { ok: false, error: err.message, ...status() };
  }
}

/** 启动时校准：设置与系统状态不一致时修正 */
function sync(enabled) {
  const st = status();
  if (!!enabled === st.openAtLogin) {
    if (!enabled) apply(false); // 顺手清残留
    return st;
  }
  return apply(!!enabled);
}

function wasLaunchedByLogin() {
  try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch (_) { return false; }
}

module.exports = { apply, status, sync, wasLaunchedByLogin, vbsPath, target };
