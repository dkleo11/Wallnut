'use strict';

/**
 * 系统代理该指向哪个端口。
 * 重写引擎是独立监听的 HTTP 代理，流量不经它就永远不会命中重写规则；所以重写在跑时必须指向重写端口，
 * 否则指向 mihomo 的混合端口。ipc 与托盘两条路径共用这一个判断，避免端口选择逻辑各算一遍而漂移。
 */
function pickProxyPort({ store, core, rewrite } = {}) {
  const st = (store && store.get() && store.get().settings) || {};
  if (rewrite && st.rewriteEnabled && typeof rewrite.snapshot === 'function' && rewrite.snapshot().running) {
    return Number(rewrite.snapshot().port) || Number(st.rewritePort) || 8890;
  }
  let port;
  try { port = core && typeof core.controllerCoords === 'function' ? core.controllerCoords().mixedPort : 0; } catch (_) {}
  return Number(port) || Number(st.mixedPort) || 7890;
}

module.exports = { pickProxyPort };
