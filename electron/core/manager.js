'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const paths = require('../paths');
const { ControllerApi } = require('./api');
const { AutoSwitcher } = require('./auto-switch');
const { sleep } = require('../util');

function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function findFreePort(start, max = 40) {
  for (let p = start; p < start + max; p++) {
    if (await portFree(p)) return p;
  }
  return null;
}

/**
 * mihomo sidecar 托管：起停 / 健康检查 / 崩溃重启 / 日志环形缓冲。
 */
class CoreManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.proc = null;
    this.pid = null;
    this.status = 'idle'; // idle | starting | running | stopping | error
    this.startedAt = null;
    this.version = null;
    this.lastError = null;
    this.logs = [];
    this.logFile = path.join(paths.subDir('logs'), 'core.log');
    this.restarts = 0;
    this.shouldRun = false;
    this.api = null;
    this.meta = null;
    this.currentPorts = { mixed: null, controller: null };
    this._selectChain = null;
    this._selectWant = null;
    this._userSelectAt = 0;   // 用户最近一次手动切换的时间，巡检器据此避让
    this.autoSwitcher = new AutoSwitcher(this, store);
    this._logBuf = '';
    this._logFlushTimer = null;
    this._logPendingLines = 0;
  }

  /** 磁盘日志按大小滚动，避免 core.log 无限增长撑大便携目录 */
  rotateLogIfNeeded() {
    try {
      const st = fs.statSync(this.logFile);
      if (st.size > 5 * 1024 * 1024) {
        const old = this.logFile + '.1';
        try { fs.rmSync(old, { force: true }); } catch (_) {}
        fs.renameSync(this.logFile, old);
      }
    } catch (_) { /* 文件不存在或无法 stat：忽略 */ }
  }

  pushLog(line, stream = 'stdout') {
    const entry = { t: Date.now(), stream, line: String(line).replace(/\r/g, '') };
    this.logs.push(entry);
    if (this.logs.length > 1200) this.logs.splice(0, this.logs.length - 1200);
    this.emit('log', entry);
    /* 每行都 appendFileSync 等于每行一次 open+write+close 同步系统调用，
       代理繁忙时（mihomo 每建立/关闭连接都打日志）会阻塞整个主进程事件循环。
       改为内存缓冲：攒 250ms 或 64KB 后合并成一次异步写入。 */
    this._logBuf += `[${new Date(entry.t).toISOString()}] ${stream}: ${entry.line}\n`;
    if (this._logBuf.length >= 65536) this.flushLogFile();
    else if (!this._logFlushTimer) this._logFlushTimer = setTimeout(() => this.flushLogFile(), 250);
  }

  /** 落盘缓冲日志；sync=true 用于退出/停止前的最后刷写 */
  flushLogFile(sync = false) {
    if (this._logFlushTimer) { clearTimeout(this._logFlushTimer); this._logFlushTimer = null; }
    const buf = this._logBuf;
    if (!buf) return;
    this._logBuf = '';
    this._logPendingLines += buf.split('\n').length - 1;
    // 每累计 200 行检查一次体积，避免每行都 stat 带来的开销
    if (this._logPendingLines >= 200) { this._logPendingLines = 0; this.rotateLogIfNeeded(); }
    try {
      if (sync) fs.appendFileSync(this.logFile, buf);
      else fs.appendFile(this.logFile, buf, () => {});
    } catch (_) {}
  }

  ensureGeoFiles() {
    const dir = paths.dataDir();
    const targets = [
      ['geoip.metadb', 'geoip.metadb'],
      ['country.mmdb', 'country.mmdb'],
      ['geosite.dat', 'geosite.dat'],
      ['GeoLite2-ASN.mmdb', 'GeoLite2-ASN.mmdb']
    ];
    for (const [src, dst] of targets) {
      const from = paths.geoFile(src);
      const to = path.join(dir, dst);
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.copyFileSync(from, to);
          this.pushLog(`[wallnut] 已内置 ${dst}`, 'system');
        }
      } catch (err) { this.pushLog(`[wallnut] 复制 ${dst} 失败: ${err.message}`, 'system'); }
    }
  }

  /** 写入生成的 YAML 并返回路径 */
  writeConfig(yaml) {
    const file = paths.configPath();
    const tmp = file + '.tmp';
    // 备份上一份可用配置
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch (_) {}
    fs.writeFileSync(tmp, yaml);
    fs.renameSync(tmp, file);
    return file;
  }

  /** mihomo -t 离线校验 */
  validate(file = paths.configPath()) {
    this.ensureGeoFiles();
    return new Promise((resolve) => {
      const bin = paths.coreBinary();
      if (!fs.existsSync(bin)) return resolve({ ok: false, output: '内核不存在: ' + bin });
      const p = spawn(bin, ['-t', '-d', paths.dataDir(), '-f', file], { windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { try { p.kill(); } catch (_) {} }, 30000);
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { out += d.toString(); });
      p.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, output: out.trim(), code });
      });
      p.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, output: err.message }); });
    });
  }

  async start({ configYaml } = {}) {
    if (this.status === 'running' || this.status === 'starting') {
      return { ok: true, already: true, status: this.status };
    }
    this.shouldRun = true;
    const bin = paths.coreBinary();
    if (!fs.existsSync(bin)) {
      this.status = 'error';
      this.lastError = '找不到内核二进制：' + bin;
      this.emit('status', this.snapshot());
      return { ok: false, error: this.lastError };
    }

    this.ensureGeoFiles();

    const s = this.store.get().settings;
    // 端口占用时自动顺延，避免启动失败
    let mixed = Number(s.mixedPort) || 7890;
    let ctrl = Number(s.controllerPort) || 9090;
    if (!(await portFree(mixed))) {
      const next = await findFreePort(mixed + 1);
      if (next) { this.pushLog(`[wallnut] 混合端口 ${mixed} 被占用，改用 ${next}`, 'system'); mixed = next; }
    }
    if (!(await portFree(ctrl))) {
      const next = await findFreePort(ctrl + 1);
      if (next) { this.pushLog(`[wallnut] 控制端口 ${ctrl} 被占用，改用 ${next}`, 'system'); ctrl = next; }
    }
    this.currentPorts = { mixed, controller: ctrl };
    this.api = new ControllerApi(ctrl, s.secret);

    let yaml = configYaml;
    if (!yaml) {
      const { buildConfig } = require('../config/generate');
      yaml = buildConfig(this.store.get(), this.currentPorts).yaml;
    }
    const file = this.writeConfig(yaml);

    this.status = 'starting';
    this.lastError = null;
    this.emit('status', this.snapshot());

    const proc = spawn(bin, ['-d', paths.dataDir(), '-f', file], {
      cwd: paths.dataDir(),
      windowsHide: true,
      env: { ...process.env }
    });
    this.proc = proc;
    this.pid = proc.pid;

    proc.stdout.on('data', (d) => this.pushLog(d.toString(), 'stdout'));
    proc.stderr.on('data', (d) => this.pushLog(d.toString(), 'stderr'));
    proc.on('error', (err) => {
      this.lastError = err.message;
      this.pushLog('[wallnut] 进程错误: ' + err.message, 'system');
    });
    proc.on('exit', (code, signal) => {
      // wasRunning 为真 = 没人让它停，它是自己退出的（崩溃/OOM/被外部杀掉）；主动 stop() 时 status 已是 stopping。
      const wasRunning = this.status === 'running';
      this.proc = null;
      this.pid = null;
      this.status = 'idle';
      this.autoSwitcher.stop();
      this.pushLog(`[wallnut] 内核退出 code=${code} signal=${signal || ''}`, 'system');
      this.flushLogFile(true); // 退出原因必须落盘，不能留在缓冲里
      this.emit('status', this.snapshot());
      if (this.shouldRun && wasRunning) this.scheduleRestart();
      if (wasRunning) this.emit('crash', { code, signal: signal || null });
    });

    // 等待控制器就绪
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (!this.proc) break;
      try {
        const v = await this.api.version();
        if (v) {
          this.version = v.version + (v.meta ? ' meta' : '');
          this.status = 'running';
          this.startedAt = Date.now();
          this.restarts = 0;
          this.emit('status', this.snapshot());
          this.autoSwitcher.start();
          return { ok: true, status: 'running', version: this.version, ports: this.currentPorts };
        }
      } catch (_) {}
      await sleep(400);
    }
    if (this.status !== 'running') {
      this.lastError = '内核启动超时（控制器未响应）';
      this.status = 'error';
      this.emit('status', this.snapshot());
      try { proc.kill(); } catch (_) {}
      return { ok: false, error: this.lastError, log: this.logs.slice(-30).map((l) => l.line).join('\n') };
    }
    return { ok: true, status: 'running', ports: this.currentPorts };
  }

  scheduleRestart() {
    this.restarts += 1;
    const delay = Math.min(1000 * Math.pow(2, this.restarts - 1), 15000);
    if (this.restarts > 6) {
      this.pushLog('[wallnut] 连续崩溃，停止自动重启', 'system');
      this.shouldRun = false;
      return;
    }
    this.pushLog(`[wallnut] ${delay}ms 后尝试重启（第 ${this.restarts} 次）`, 'system');
    setTimeout(() => { if (this.shouldRun) this.start(); }, delay);
  }

  async stop() {
    this.shouldRun = false;
    this.autoSwitcher.stop();
    if (!this.proc) { this.status = 'idle'; this.emit('status', this.snapshot()); return { ok: true }; }
    this.status = 'stopping';
    this.emit('status', this.snapshot());
    const proc = this.proc;
    try { proc.kill(); } catch (_) {}
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && this.proc) await sleep(150);
    if (this.proc) { try { this.proc.kill('SIGKILL'); } catch (_) {} }
    this.flushLogFile(true);
    this.status = 'idle';
    this.emit('status', this.snapshot());
    return { ok: true };
  }

  async restart() {
    await this.stop();
    await sleep(300);
    return this.start();
  }

  /** 重新生成配置并热加载（失败则重启） */
  async apply(meta) {
    const { buildConfig } = require('../config/generate');
    const built = buildConfig(this.store.get());
    this.meta = built.meta;
    const file = this.writeConfig(built.yaml);
    this.emit('meta', built.meta);
    if (this.status !== 'running') {
      return { ok: true, reloaded: false, restarted: false, meta: built.meta };
    }
    try {
      await this.api.reloadConfig(file, { force: true });
      this.pushLog('[wallnut] 配置已热加载', 'system');
      return { ok: true, reloaded: true, meta: built.meta };
    } catch (err) {
      this.pushLog('[wallnut] 热加载失败（' + err.message + '），转为重启内核', 'system');
      const r = await this.restart();
      return { ok: !!r.ok, reloaded: false, restarted: true, meta: built.meta, error: r.error };
    }
  }

  /**
   * 热切换某个策略组（selector）的当前节点。
   * 只发 PUT /proxies/{group}，**不重载配置** —— reloadConfig 会重建全部代理并断开
   * 现存连接，正在下载/视频/SSH 会立刻断流。连点多个节点时按 latest-wins 排队，
   * 只有最后点的那次真正执行，避免请求乱序导致「切了 A 结果停在 B」。
   */
  async select(group, name, { retries = 1, timeout = 8000, auto = false } = {}) {
    if (this.status !== 'running') return { ok: false, error: 'mihomo 未运行' };
    // 手动切换后 45 秒内巡检器不插手，避免和用户抢方向盘
    if (!auto) this._userSelectAt = Date.now();
    const want = { group, name };
    this._selectWant = want;
    const prev = this._selectChain || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      if (this._selectWant !== want) return { ok: true, skipped: true };
      let lastErr = null;
      for (let i = 0; i <= retries; i += 1) {
        try {
          await this.api.select(group, name, timeout);
          this.pushLog(`[wallnut] 切换「${group}」→ ${name}`, 'system');
          return { ok: true, group, name };
        } catch (err) {
          lastErr = err;
          // 控制器在批量测速/高并发下偶发超时，重试一次即可，不要升级成重载配置
          if (i < retries) await sleep(150);
        }
      }
      return { ok: false, error: (lastErr && lastErr.message) || '切换失败' };
    });
    this._selectChain = run;
    return run;
  }

  controllerCoords() {
    return { host: '127.0.0.1', port: this.currentPorts.controller || (this.store.get().settings.controllerPort), mixedPort: this.currentPorts.mixed, secret: this.store.get().settings.secret };
  }

  snapshot() {
    return {
      status: this.status,
      running: this.status === 'running',
      pid: this.pid,
      version: this.version,
      startedAt: this.startedAt,
      error: this.lastError,
      ports: this.controllerCoords(),
      restarts: this.restarts,
      autoSwitch: this.autoSwitcher ? this.autoSwitcher.summary() : null
    };
  }
}

module.exports = { CoreManager, portFree, findFreePort };
