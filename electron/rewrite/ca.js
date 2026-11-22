'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');

function run(file, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        const err = new Error(`${path.basename(file)} failed${error.code != null ? ` (${error.code})` : ''}: ${detail}`);
        err.cause = error;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

class CertificateAuthority {
  constructor({ dir, opensslPath, certutilPath } = {}) {
    this.dir = dir || require('../paths').subDir('rewrite-ca');
    this.opensslPath = opensslPath || process.env.OPENSSL_PATH || null;
    this.resolvedOpensslPath = this.opensslPath;
    this.certutilPath = certutilPath || process.env.CERTUTIL_PATH || 'certutil';
    this.rootKeyPath = path.join(this.dir, 'root.key');
    this.rootCertPath = path.join(this.dir, 'root.crt');
    this.rootPromise = null;
    this.hostPromises = new Map();
    this.hostCache = new Map();
  }

  async _openssl(args) {
    if (this.resolvedOpensslPath) return run(this.resolvedOpensslPath, args);
    const candidates = [
      'openssl',
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'
    ];
    if (process.platform === 'win32') {
      try {
        const { stdout } = await run('where.exe', ['openssl']);
        candidates.push(...stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
      } catch (_) {}
    }
    const errors = [];
    for (const candidate of [...new Set(candidates)]) {
      if (candidate !== 'openssl' && !fs.existsSync(candidate)) continue;
      try {
        await run(candidate, ['version']);
        this.resolvedOpensslPath = candidate;
        return run(candidate, args);
      } catch (err) {
        errors.push(err.message);
      }
    }
    throw new Error('No executable OpenSSL found: ' + errors.join('; '));
  }

  async _validCert(file, hostname) {
    try {
      if (!fs.existsSync(file)) return false;
      await this._openssl(['x509', '-checkend', '86400', '-noout', '-in', file]);
      if (hostname) {
        const cert = new crypto.X509Certificate(fs.readFileSync(file));
        if (!cert.checkHost(hostname)) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async ensureRoot() {
    if (this.rootPromise) return this.rootPromise;
    this.rootPromise = this._ensureRoot().catch((err) => {
      this.rootPromise = null;
      throw err;
    });
    return this.rootPromise;
  }

  async _ensureRoot() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.rootKeyPath) && await this._validCert(this.rootCertPath)) {
      return {
        key: fs.readFileSync(this.rootKeyPath, 'utf8'),
        cert: fs.readFileSync(this.rootCertPath, 'utf8'),
        keyPath: this.rootKeyPath,
        certPath: this.rootCertPath
      };
    }

    const token = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    const keyTmp = path.join(this.dir, `root.${token}.key`);
    const certTmp = path.join(this.dir, `root.${token}.crt`);
    try {
      await this._openssl([
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
        '-subj', '/CN=Wallnut Root CA/O=Wallnut',
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-keyout', keyTmp, '-out', certTmp
      ]);
      if (!fs.existsSync(keyTmp) || !fs.existsSync(certTmp)) throw new Error('OpenSSL did not create the root CA files');
      fs.renameSync(keyTmp, this.rootKeyPath);
      fs.renameSync(certTmp, this.rootCertPath);
      return {
        key: fs.readFileSync(this.rootKeyPath, 'utf8'),
        cert: fs.readFileSync(this.rootCertPath, 'utf8'),
        keyPath: this.rootKeyPath,
        certPath: this.rootCertPath
      };
    } catch (err) {
      try { fs.rmSync(keyTmp, { force: true }); } catch (_) {}
      try { fs.rmSync(certTmp, { force: true }); } catch (_) {}
      throw new Error('Wallnut Root CA generation failed: ' + err.message, { cause: err });
    }
  }

  _normalizeHost(hostname) {
    let host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (!host || host.length > 253 || /[\\\s/@]/.test(host)) throw new Error('Invalid certificate hostname: ' + hostname);
    if (!net.isIP(host) && !/^(?:[a-z0-9_*-]+\.)*[a-z0-9_*-]+$/.test(host)) {
      throw new Error('Invalid certificate hostname: ' + hostname);
    }
    return host;
  }

  async getCertificate(hostname) {
    const host = this._normalizeHost(hostname);
    if (this.hostCache.has(host)) return this.hostCache.get(host);
    if (this.hostPromises.has(host)) return this.hostPromises.get(host);
    const promise = this._getCertificate(host).catch((err) => {
      this.hostPromises.delete(host);
      throw err;
    });
    this.hostPromises.set(host, promise);
    return promise;
  }

  async _getCertificate(host) {
    const root = await this.ensureRoot();
    const id = crypto.createHash('sha256').update(host).digest('hex').slice(0, 24);
    const keyPath = path.join(this.dir, `host-${id}.key`);
    const certPath = path.join(this.dir, `host-${id}.crt`);
    if (fs.existsSync(keyPath) && await this._validCert(certPath, host)) {
      const cached = {
        key: fs.readFileSync(keyPath, 'utf8'),
        cert: fs.readFileSync(certPath, 'utf8'),
        keyPath,
        certPath,
        host
      };
      this.hostCache.set(host, cached);
      return cached;
    }

    const token = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    const keyTmp = path.join(this.dir, `host-${id}.${token}.key`);
    const csrTmp = path.join(this.dir, `host-${id}.${token}.csr`);
    const certTmp = path.join(this.dir, `host-${id}.${token}.crt`);
    const extTmp = path.join(this.dir, `host-${id}.${token}.ext`);
    const san = net.isIP(host) ? `IP:${host}` : `DNS:${host}`;
    try {
      fs.writeFileSync(extTmp, [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${san}`,
        ''
      ].join('\n'));
      await this._openssl([
        'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
        '-subj', `/CN=${host}`, '-keyout', keyTmp, '-out', csrTmp
      ]);
      await this._openssl([
        'x509', '-req', '-in', csrTmp, '-CA', this.rootCertPath, '-CAkey', this.rootKeyPath,
        '-set_serial', '0x' + crypto.randomBytes(16).toString('hex'), '-days', '825', '-sha256',
        '-extfile', extTmp, '-out', certTmp
      ]);
      if (!fs.existsSync(keyTmp) || !fs.existsSync(certTmp)) throw new Error('OpenSSL did not create the host certificate files');
      fs.renameSync(keyTmp, keyPath);
      fs.renameSync(certTmp, certPath);
      const result = {
        key: fs.readFileSync(keyPath, 'utf8'),
        cert: fs.readFileSync(certPath, 'utf8'),
        keyPath,
        certPath,
        host
      };
      this.hostCache.set(host, result);
      return result;
    } catch (err) {
      throw new Error(`Certificate generation failed for ${host}: ${err.message}`, { cause: err });
    } finally {
      for (const file of [keyTmp, csrTmp, certTmp, extTmp]) {
        try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch (_) {}
      }
    }
  }

  _fingerprint() {
    if (!fs.existsSync(this.rootCertPath)) return null;
    const cert = new crypto.X509Certificate(fs.readFileSync(this.rootCertPath));
    return cert.fingerprint.replace(/:/g, '').toLowerCase();
  }

  async isInstalled() {
    const fingerprint = this._fingerprint();
    if (!fingerprint) return false;
    if (process.platform !== 'win32') return false;
    try {
      const { stdout, stderr } = await run(this.certutilPath, ['-user', '-store', 'Root', 'Wallnut Root CA']);
      const output = `${stdout}\n${stderr}`.replace(/[\s:-]/g, '').toLowerCase();
      return output.includes(fingerprint);
    } catch (_) {
      return false;
    }
  }

  async status() {
    return { installed: await this.isInstalled(), fingerprint: this._fingerprint() };
  }

  async install() {
    if (process.platform !== 'win32') throw new Error('CA installation is only supported on Windows');
    await this.ensureRoot();
    await run(this.certutilPath, ['-user', '-addstore', 'Root', this.rootCertPath]);
    if (!await this.isInstalled()) {
      throw new Error('certutil returned successfully, but the Wallnut Root CA fingerprint was not found in the user Root store');
    }
    return { ok: true, installed: true, fingerprint: this._fingerprint() };
  }

  async uninstall() {
    if (process.platform !== 'win32') throw new Error('CA uninstallation is only supported on Windows');
    const fingerprint = this._fingerprint();
    if (fingerprint) {
      await run(this.certutilPath, ['-user', '-delstore', 'Root', fingerprint]);
      if (await this.isInstalled()) throw new Error('Wallnut Root CA is still present after certutil -delstore');
      return { ok: true, installed: false, removed: true, fingerprint };
    }

    let queryFound = false;
    try {
      await run(this.certutilPath, ['-user', '-store', 'Root', 'Wallnut Root CA']);
      queryFound = true;
    } catch (_) {}
    if (queryFound) await run(this.certutilPath, ['-user', '-delstore', 'Root', 'Wallnut Root CA']);
    try {
      await run(this.certutilPath, ['-user', '-store', 'Root', 'Wallnut Root CA']);
      throw new Error('A certificate named Wallnut Root CA is still present after uninstall');
    } catch (err) {
      if (/still present/.test(err.message)) throw err;
    }
    return { ok: true, installed: false, removed: queryFound, fingerprint: null };
  }
}

module.exports = { CertificateAuthority, run };
