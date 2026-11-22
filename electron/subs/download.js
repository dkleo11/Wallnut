'use strict';

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const { URL } = require('url');

const UA_POOL = [
  'clash.meta/v1.19.34',
  'mihomo/v1.19.34',
  'ClashMetaForAndroid/2.11.6.Meta',
  'Surge/5.0 (iPhone; iOS 17.0)'
];

/**
 * 下载订阅文本：跟随重定向、解压、超时、UA 可配。
 * @param {string} url
 * @param {{timeout?:number, ua?:string, maxBytes?:number}} opts
 */
let _uaCursor = 0;

function download(url, opts = {}) {
  const timeout = opts.timeout || 20000;
  const maxBytes = opts.maxBytes || 20 * 1024 * 1024;
  // 默认轮换 UA：部分机场按 UA 返回不同订阅格式，固定单一 UA 会拿不到期望格式。
  const ua = opts.ua || UA_POOL[_uaCursor++ % UA_POOL.length];
  // 默认校验 TLS 证书，防止中间人替换订阅内容（订阅会直接变成代理配置）。
  // 仅当该订阅被用户显式标记 insecure 时才放开。
  const insecure = opts.insecure === true;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => { if (settled) return; settled = true; err ? reject(err) : resolve(val); };

    const go = (target, redirects = 0) => {
      if (redirects > 6) return done(new Error('重定向次数过多'));
      let u;
      try { u = new URL(target); } catch (e) { return done(new Error('URL 无效: ' + target)); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return done(new Error('只支持 http/https: ' + u.protocol));
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': ua,
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache'
        },
        timeout,
        rejectUnauthorized: !insecure
      }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          return go(next, redirects + 1);
        }
        if (status !== 200) {
          res.resume();
          return done(new Error(`HTTP ${status} ${res.statusMessage || ''} ${target}`));
        }
        let stream = res;
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
        else if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); done(new Error('订阅体积超过限制')); return; }
          chunks.push(c);
        });
        stream.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8').replace(/^\uFEFF/, '');
          done(null, { text, size, url: target, contentType: res.headers['content-type'] || '' });
        });
        stream.on('error', (e) => done(e));
      });
      req.on('timeout', () => { req.destroy(new Error('下载超时')); });
      req.on('error', (e) => done(e));
      req.end();
    };

    if (/^file:\/\//i.test(url) || (!/^http/i.test(url) && fs.existsSync(url))) {
      try {
        const p = url.replace(/^file:\/\//i, '');
        const text = fs.readFileSync(p, 'utf8');
        return done(null, { text, size: text.length, url: p, contentType: 'file' });
      } catch (e) { return done(e); }
    }
    go(url);
  });
}

module.exports = { download, UA_POOL };
