'use strict';

/**
 * 节点批量测速：并发池 + 逐条结果推送 + 可取消。
 * 全部通过 mihomo 的 GET /proxies/{name}/delay，走的是真实代理链路。
 */
class SpeedTestRunner {
  constructor(api) {
    this.api = api;
    this.running = false;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * @param {object} opts
   * @param {string[]} opts.names 节点名
   * @param {string} opts.url 测速 URL
   * @param {number} opts.timeout ms
   * @param {number} opts.concurrency
   * @param {(ev:object)=>void} opts.onProgress
   */
  async run({ names, url, timeout = 5000, concurrency = 16, onProgress = () => {} }) {
    if (this.running) throw new Error('已有测速任务进行中');
    this.running = true;
    this.cancelled = false;
    const results = [];
    const total = names.length;
    let index = 0;
    let done = 0;

    onProgress({ type: 'start', total, url, timeout, concurrency });

    const worker = async () => {
      while (index < total) {
        if (this.cancelled) return;
        const i = index++;
        const name = names[i];
        let res;
        try {
          const delay = await this.api.delay(name, { url, timeout });
          res = { name, delay, ok: true };
        } catch (err) {
          res = { name, delay: null, ok: false, error: [400, 504].includes(err.status) ? '超时' : (err.message || '失败') };
        }
        if (this.cancelled) return;
        results.push(res);
        done += 1;
        try { onProgress({ type: 'result', ...res, done, total }); } catch (_) { /* 进度回调失败不应中断测速 */ }
      }
    };

    const pool = Array.from({ length: Math.max(1, Math.min(concurrency, total || 1)) }, worker);
    try {
      await Promise.all(pool);
    } finally {
      // 必须复位：onProgress 回调里一旦抛错（它要走 IPC 广播），
      // 原来会让 running 永久保持 true，之后所有测速都报「已有任务进行中」。
      this.running = false;
    }

    const ok = results.filter((r) => r.ok && r.delay > 0).sort((a, b) => a.delay - b.delay);
    const failed = results.filter((r) => !r.ok || !r.delay);
    const summary = {
      type: 'done',
      total,
      okCount: ok.length,
      failCount: failed.length,
      cancelled: this.cancelled,
      fastest: ok[0] || null,
      slowest: ok[ok.length - 1] || null,
      avg: ok.length ? Math.round(ok.reduce((a, b) => a + b.delay, 0) / ok.length) : null,
      results: [...ok, ...failed]
    };
    onProgress(summary);
    return summary;
  }
}

module.exports = { SpeedTestRunner };
