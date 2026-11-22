'use strict';

const http = require('http');

/**
 * mihomo External Controller 的最小 REST 客户端（仅主进程使用）。
 */
class ControllerApi {
  constructor(port, secret) {
    this.port = port;
    this.secret = secret || '';
  }

  setEndpoint(port, secret) {
    this.port = port;
    this.secret = secret || '';
  }

  request(method, path, body, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1',
        port: this.port,
        path,
        method,
        timeout,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (!text) return resolve(null);
            try { resolve(JSON.parse(text)); } catch (_) { resolve(text); }
          } else {
            const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
            err.status = res.statusCode;
            err.body = text;
            reject(err);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('控制器请求超时')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(path, timeout) { return this.request('GET', path, undefined, timeout); }
  put(path, body, timeout) { return this.request('PUT', path, body, timeout); }
  patch(path, body, timeout) { return this.request('PATCH', path, body, timeout); }
  post(path, body, timeout) { return this.request('POST', path, body, timeout); }
  del(path, timeout) { return this.request('DELETE', path, undefined, timeout); }

  version() { return this.get('/version', 3000); }
  configs() { return this.get('/configs', 4000); }

  /** 对单个节点测延迟（返回 ms，失败抛出） */
  async delay(name, { url, timeout = 5000 } = {}) {
    const qs = new URLSearchParams({ timeout: String(timeout) });
    if (url) qs.set('url', url);
    const body = await this.get(`/proxies/${encodeURIComponent(name)}/delay?${qs.toString()}`, timeout + 2000);
    if (body && typeof body.delay === 'number') return body.delay;
    throw new Error('延迟测速返回异常');
  }

  /** 切换某个策略组当前选中项 */
  select(group, name) { return this.put(`/proxies/${encodeURIComponent(group)}`, { name }, 6000); }

  /** 重新加载配置文件（不重启进程） */
  async reloadConfig(filePath, { force = true } = {}) {
    return this.put(`/configs${force ? '?force=true' : ''}`, { path: filePath }, 15000);
  }

  closeAllConnections() { return this.del('/connections', 4000); }
}

module.exports = { ControllerApi };
