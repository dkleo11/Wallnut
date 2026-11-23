'use strict';

const http = require('http');
const tls = require('tls');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { CertificateAuthority } = require('./ca');

const RULE_TYPES = new Set([
  'reject', 'redirect', 'rewrite', 'request-header', 'response-header', 'response-body'
]);

class RewriteEngine extends EventEmitter {
  constructor({ store, core, ca } = {}) {
    super();
    if (!store || typeof store.get !== 'function') throw new TypeError('RewriteEngine requires a store');
    this.store = store;
    this.core = core;
    this.ca = ca || null;
    this.server = null;
    this.desiredRunning = false;
    this.rules = [];
    this.mitmHosts = [];
    this.port = null;
    this.stats = { hits: 0, bytes: 0, errors: 0 };
    this.sockets = new Set();
    this._transition = Promise.resolve();
    this._reload();
    this._unsubscribe = typeof store.onChange === 'function'
      ? store.onChange(() => this._onStoreChange())
      : null;
  }

  _reload() {
    const state = this.store.get() || {};
    const localRules = (Array.isArray(state.rewrites) ? state.rewrites : [])
      .filter((rule) => rule && rule.enabled !== false && RULE_TYPES.has(rule.type));
    // 线上规则集：只会读取启用且 rules 有效的集合；与本地规则合并，本地优先命中
    const remoteRules = [];
    for (const set of Array.isArray(state.rewriteRemoteSets) ? state.rewriteRemoteSets : []) {
      if (!set || set.enabled === false || !Array.isArray(set.rules)) continue;
      set.rules.forEach((rule, idx) => {
        if (!rule || rule.enabled === false || !RULE_TYPES.has(rule.type)) return;
        remoteRules.push({
          ...rule,
          id: 'rrs:' + String(set.id || '') + ':' + idx,
          remoteSetId: set.id || null,
          remoteSetName: set.name || '',
          note: rule.note || ('线上规则集：' + String(set.name || ''))
        });
      });
    }
    this.rules = localRules.concat(remoteRules)
      .map((rule) => {
        try {
          return { ...rule, regex: new RegExp(String(rule.pattern || '')) };
        } catch (err) {
          this.stats.errors += 1;
          return { ...rule, regex: null, compileError: err.message };
        }
      });
    this.mitmHosts = Array.isArray(state.mitmHosts) ? state.mitmHosts.slice() : [];
  }

  _onStoreChange() {
    this._reload();
    if (!this.desiredRunning) return;
    const settings = this._settings();
    if (!settings.enabled && this.server) {
      this._queue(() => this._close());
    } else if (settings.enabled && !this.server) {
      this._queue(() => this._open());
    } else if (this.server && settings.port !== this.port) {
      this._queue(async () => { await this._close(); return this._open(); });
    }
  }

  _settings() {
    const state = this.store.get() || {};
    const settings = state.settings || {};
    return {
      enabled: settings.rewriteEnabled === true,
      port: Number(settings.rewritePort) || 8890
    };
  }

  _queue(fn) {
    const run = this._transition.then(fn, fn);
    this._transition = run.catch(() => {});
    return run;
  }

  start() {
    this.desiredRunning = true;
    this._reload();
    return this._queue(() => this._open());
  }

  async _open() {
    if (this.server) return { ok: true, already: true, ...this.snapshot() };
    if (!this._settings().enabled) return { ok: true, disabled: true, ...this.snapshot() };
    const server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => this._requestError(err, req, res));
    });
    server.on('connect', (req, client, head) => {
      this._handleConnect(req, client, head).catch((err) => {
        this.stats.errors += 1;
        if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        else client.destroy();
      });
    });
    server.on('clientError', (err, socket) => {
      this.stats.errors += 1;
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const port = this._settings().port;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (err) {
      this.stats.errors += 1;
      try { server.close(); } catch (_) {}
      return { ok: false, error: err.message, ...this.snapshot() };
    }
    server.on('error', () => { this.stats.errors += 1; });
    this.server = server;
    this.port = server.address().port;
    return { ok: true, ...this.snapshot() };
  }

  stop() {
    this.desiredRunning = false;
    return this._queue(() => this._close());
  }

  async _close() {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return { ok: true, ...this.snapshot() };
    const closed = new Promise((resolve) => server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
    return { ok: true, ...this.snapshot() };
  }

  async restart() {
    this.desiredRunning = true;
    return this._queue(async () => {
      await this._close();
      this._reload();
      return this._open();
    });
  }

  snapshot() {
    return {
      running: !!this.server,
      port: this.port,
      hits: this.stats.hits,
      bytes: this.stats.bytes,
      errors: this.stats.errors
    };
  }

  _upstreamPort() {
    let port;
    if (this.core && typeof this.core.snapshot === 'function') {
      const snap = this.core.snapshot() || {};
      port = snap.ports && snap.ports.mixedPort;
    }
    if (!port && this.core && typeof this.core.controllerCoords === 'function') {
      port = this.core.controllerCoords().mixedPort;
    }
    if (!port) port = (this.store.get().settings || {}).mixedPort;
    return Number(port) || 7890;
  }

  _matched(rule, url) {
    if (!rule.regex || rule.compileError) return false;
    rule.regex.lastIndex = 0;
    const matched = rule.regex.test(url);
    rule.regex.lastIndex = 0;
    if (matched) {
      this.stats.hits += 1;
      this.emit('hit', { id: rule.id || null, type: rule.type, url, time: Date.now() });
    }
    return matched;
  }

  _isMitmHost(hostname) {
    const settings = (this.store.get() || {}).settings || {};
    if (settings.mitmEnabled !== true) return false;
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return this.mitmHosts.some((entry) => {
      const pattern = String(entry || '').trim().toLowerCase();
      if (!pattern) return false;
      if (pattern.startsWith('.')) return host.endsWith(pattern);
      if (pattern.includes('*')) {
        const source = '^' + pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
        try { return new RegExp(source).test(host); } catch (_) { return false; }
      }
      return host === pattern;
    });
  }

  async _handleConnect(req, client, head) {
    const target = new URL('http://' + req.url);
    if (!target.hostname || !target.port) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    client.on('error', () => {});
    if (!this._isMitmHost(target.hostname)) {
      this._tunnel(req, client, head);
      return;
    }
    if (!this.ca) this.ca = new CertificateAuthority();
    const certificate = await this.ca.getCertificate(target.hostname);
    if (client.destroyed) return;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) client.unshift(head);

    const inner = http.createServer((innerReq, innerRes) => {
      try {
        innerReq.url = new URL(innerReq.url, 'https://' + target.host).href;
      } catch (_) {
        innerRes.writeHead(400); innerRes.end('Invalid HTTPS request URL'); return;
      }
      this._handle(innerReq, innerRes).catch((err) => this._requestError(err, innerReq, innerRes));
    });
    inner.on('clientError', (err, socket) => {
      this.stats.errors += 1;
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    const tlsServer = tls.createServer({ key: certificate.key, cert: certificate.cert });
    tlsServer.on('secureConnection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      inner.emit('connection', socket);
    });
    tlsServer.on('error', (err) => {
      this.stats.errors += 1;
      client.destroy(err);
    });
    tlsServer.emit('connection', client);
  }

  _tunnel(req, client, head) {
    let target;
    try {
      target = new URL('http://' + req.url);
      if (!target.hostname || !target.port) throw new Error('CONNECT host:port required');
    } catch (_) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const out = http.request({
      host: '127.0.0.1',
      port: this._upstreamPort(),
      method: 'CONNECT',
      path: req.url,
      headers: { host: req.url },
      agent: false
    });
    out.on('connect', (upRes, upstream, upstreamHead) => {
      if (upRes.statusCode !== 200) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        upstream.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      if (upstreamHead.length) client.write(upstreamHead);
      client.on('data', (chunk) => { this.stats.bytes += chunk.length; });
      upstream.on('data', (chunk) => { this.stats.bytes += chunk.length; });
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    out.on('error', () => {
      this.stats.errors += 1;
      if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    client.on('error', () => out.destroy());
    out.end();
  }

  async _handle(req, res) {
    let url;
    try {
      url = new URL(req.url);
    } catch (_) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Absolute URI required');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      res.writeHead(400); res.end('Unsupported protocol'); return;
    }

    const headers = { ...req.headers };
    let hostRuleApplied = false;
    for (const rule of this.rules) {
      if (rule.type !== 'rewrite' && rule.type !== 'request-header' && rule.type !== 'reject' && rule.type !== 'redirect') continue;
      if (!this._matched(rule, url.href)) continue;
      if (rule.type === 'rewrite') {
        rule.regex.lastIndex = 0;
        url = new URL(url.href.replace(rule.regex, String(rule.action || '')));
      } else if (rule.type === 'redirect') {
        res.writeHead(302, { location: String(rule.action || ''), 'content-length': '0' });
        res.end();
        return;
      } else if (rule.type === 'reject') {
        const status = String(rule.action) === '204' ? 204 : 403;
        res.writeHead(status, { 'content-length': '0' });
        res.end();
        return;
      } else if (rule.type === 'request-header' && rule.header) {
        const name = String(rule.header).toLowerCase();
        if (name === 'host') hostRuleApplied = true;
        if (rule.action === 'remove') delete headers[name];
        else headers[name] = String(rule.value == null ? '' : rule.value);
      }
    }
    if (!hostRuleApplied) headers.host = url.host;
    await this._forward(req, res, url, headers);
  }

  async _forward(req, res, url, requestHeaders) {
    const headers = { ...requestHeaders };
    delete headers['proxy-connection'];
    const out = http.request({
      host: '127.0.0.1',
      port: this._upstreamPort(),
      method: req.method,
      path: url.href,
      headers,
      agent: false,
      setHost: false
    }, (up) => {
      up.on('data', (chunk) => { this.stats.bytes += chunk.length; });
      const headers = { ...up.headers };
      const bodyRules = [];
      for (const rule of this.rules) {
        if (rule.type !== 'response-header' && rule.type !== 'response-body') continue;
        if (!this._matched(rule, url.href)) continue;
        if (rule.type === 'response-body') bodyRules.push(rule);
        else if (rule.header) {
          const name = String(rule.header).toLowerCase();
          if (rule.action === 'remove') delete headers[name];
          else headers[name] = String(rule.value == null ? '' : rule.value);
        }
      }
      const contentType = String(headers['content-type'] || '');
      const canRewrite = bodyRules.length > 0 && /(?:^text\/|json|javascript|ecmascript|html|xml)/i.test(contentType);
      if (!canRewrite) {
        res.writeHead(up.statusCode, up.statusMessage, headers);
        up.pipe(res);
        return;
      }
      const MAX_BODY = 8 * 1024 * 1024; // response-body 重写最多缓冲 8MB，超出改为直通，避免内存放大/阻塞
      const chunks = [];
      let bodySize = 0;
      let passthrough = false;
      up.on('data', (chunk) => {
        if (passthrough) { res.write(chunk); return; }
        bodySize += chunk.length;
        if (bodySize > MAX_BODY) {
          // 太大：放弃重写，先把已缓冲内容原样发出，再直通剩余数据
          passthrough = true;
          res.writeHead(up.statusCode, up.statusMessage, headers);
          for (const c of chunks) res.write(c);
          res.write(chunk);
          return;
        }
        chunks.push(chunk);
      });
      up.on('end', () => {
        if (passthrough) { res.end(); return; }
        try {
          const encoded = Buffer.concat(chunks);
          const encoding = String(headers['content-encoding'] || '').toLowerCase();
          let body = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.gunzipSync(encoded)
            : encoding === 'deflate' ? zlib.inflateSync(encoded)
              : encoding === 'br' ? zlib.brotliDecompressSync(encoded)
                : (!encoding || encoding === 'identity') ? encoded : null;
          if (!body) throw new Error('Unsupported Content-Encoding: ' + encoding);
          let text = body.toString('utf8');
          for (const rule of bodyRules) {
            const search = new RegExp(String(rule.action || ''), 'g');
            text = text.replace(search, String(rule.replacement == null ? '' : rule.replacement));
          }
          body = Buffer.from(text, 'utf8');
          const output = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.gzipSync(body)
            : encoding === 'deflate' ? zlib.deflateSync(body)
              : encoding === 'br' ? zlib.brotliCompressSync(body) : body;
          headers['content-length'] = String(output.length);
          delete headers['transfer-encoding'];
          res.writeHead(up.statusCode, up.statusMessage, headers);
          res.end(output);
        } catch (err) {
          this._requestError(err, req, res);
        }
      });
      up.on('error', (err) => this._requestError(err, req, res));
    });
    out.on('error', (err) => this._requestError(err, req, res));
    req.on('aborted', () => out.destroy());
    req.pipe(out);
  }

  _requestError(err, req, res) {
    this.stats.errors += 1;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Rewrite upstream error: ' + err.message);
    } else if (!res.destroyed) {
      res.destroy(err);
    }
    // 不把上游错误细节回显给客户端，避免泄漏内部信息；详情只进重写日志。
    try { this.emit && this.emit('log', { t: Date.now(), line: 'rewrite upstream error: ' + err.message }); } catch (_) {}
  }
}

module.exports = { RewriteEngine };
