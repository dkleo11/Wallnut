'use strict';

/**
 * 内核意外退出（崩溃）后的系统代理保护。
 * 场景：重写引擎在跑 → 系统代理指向重写端口(8890) → 内核退出后 7890 没有上游 → 走系统代理的程序全部连不上。
 * 策略：先给 CoreManager 的自动重启留 graceMs 窗口（首次退避 1s，重启成功上游自动恢复，此时什么都不做）；
 *      到期仍未 running 才关掉系统代理，并通过 onFix 通知外层（广播状态 + 通知用户）。
 *
 * getRewrite 必须传 getter：main.js 里的 rewrite 实例是后创建的，传值会拿到 null。
 */
function createCrashGuard({ store, core, getRewrite, setSystemProxy, onFix, graceMs = 4000 }) {
  let timer = null;
  const handle = () => {
    if (!store.get().settings.systemProxy) return;
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(async () => {
      timer = null;
      if (!store.get().settings.systemProxy) return;    // 期间已被主动停止 / 手动关闭
      if (core.snapshot().running) return;               // 自动重启成功，上游已恢复
      const rw = getRewrite && getRewrite();
      if (!rw || !rw.snapshot().running) return;         // 重写已关，系统代理指的就是内核端口
      try { await setSystemProxy(false, { port: store.get().settings.mixedPort }); } catch (_) {}
      store.update((d) => { d.settings.systemProxy = false; });
      if (onFix) { try { onFix(); } catch (_) {} }
    }, graceMs);
  };
  handle.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return handle;
}

module.exports = { createCrashGuard };
