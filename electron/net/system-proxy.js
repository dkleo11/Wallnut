'use strict';

const { execFile } = require('child_process');
const path = require('path');

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function readProxyState() {
  const r = await run('reg', ['query', REG_PATH]);
  const out = r.stdout;
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
  const server = (out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i) || [])[1] || '';
  return { enabled, server: server.trim() };
}

/** 通知 WinINet 重新读取代理设置（否则部分应用要等下次轮询） */
async function notifyWinInet() {
  const ps = [
    '$sig = @\'',
    '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);',
    '\'@',
    'Add-Type -MemberDefinition $sig -Name W -Namespace Q -UsingNamespace System.Runtime.InteropServices | Out-Null',
    '[Q.W]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
    '[Q.W]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null'
  ].join('\n');
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 20000);
}

const BYPASS = '<local>;localhost;127.0.0.1;*.local';

async function setSystemProxy(enable, { port = 7890, host = '127.0.0.1' } = {}) {
  const server = `${host}:${port}`;
  if (enable) {
    const a = await run('reg', ['add', REG_PATH, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
    const b = await run('reg', ['add', REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
    await run('reg', ['add', REG_PATH, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', BYPASS, '/f']);
    await notifyWinInet();
    const state = await readProxyState();
    return { ok: a.ok && b.ok, enabled: state.enabled, server: state.server };
  }
  const r = await run('reg', ['add', REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
  await notifyWinInet();
  const state = await readProxyState();
  return { ok: r.ok, enabled: state.enabled, server: state.server };
}

/** 是否以管理员身份运行（TUN 需要） */
async function isElevated() {
  const r = await run('net', ['session'], 8000);
  return r.ok;
}

/** 打开 Windows 网络设置页，引导用户手动排查 */
async function openProxySettings() {
  await run('cmd', ['/c', 'start', 'ms-settings:network-proxy'], 5000);
}

module.exports = { readProxyState, setSystemProxy, isElevated, openProxySettings, notifyWinInet };
