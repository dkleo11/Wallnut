'use strict';

/**
 * 节点健康巡检（应用层「过慢自动切换」）。
 *
 * 为什么需要它：mihomo 自带的 url-test 组默认 300 秒才复测一次，且 lazy 模式下
 * 只要组不被使用就不测，节点变慢/挂掉后最多要等 5 分钟才换，期间用户一直在用坏节点。
 *
 * 这里每 intervalSec 秒测一次「当前实际生效的节点」（沿代理组链一路解析到叶子节点），
 * 连续 2 次超过 slowMs 或直接不通，就在「能手动选择的那一层」挑一个明显更快的成员：
 *   - 有多层 Selector 组时，优先在最贴近节点的组内换（例如仍留在「日本」组里换节点）；
 *   - 该层没有合格候选，再退回主策略组换地区；
 *   - 全程只发 PUT /proxies/{group} 热切换，不重载配置，已有连接不会被打断。
 */
class AutoSwitcher {
  constructor(manager, store) {
    this.manager = manager;
    this.store = store;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.fails = 0;
    this.lastSwitchAt = 0;
    this.lastResult = null;
    this.switchTimes = [];
    this.probeCache = new Map();
  }

  static defaults() {
    return { enabled: true, intervalSec: 30, slowMs: 1200, cooldownSec: 120, maxPer10Min: 6 };
  }

  cfg() {
    const s = (this.store.get().settings || {}).autoSwitch || {};
    return { ...AutoSwitcher.defaults(), ...s };
  }

  api() { return this.manager.api; }

  testUrl(c) {
    return (this.store.get().settings || {}).testUrl || 'https://www.gstatic.com/generate_204';
  }

  summary() {
    return {
      enabled: this.cfg().enabled !== false,
      node: (this.lastResult && this.lastResult.node) || null,
      delay: this.lastResult && Number.isFinite(this.lastResult.delay) ? this.lastResult.delay : null,
      at: (this.lastResult && this.lastResult.at) || null,
      fails: this.fails,
      lastSwitchAt: this.lastSwitchAt || null
    };
  }

  start() {
    this.running = true;
    this.schedule(2000);
    const c = this.cfg();
    this.manager.pushLog(
      c.enabled === false
        ? '[wallnut] 节点巡检：已关闭（设置 → 节点自动切换）'
        : `[wallnut] 节点巡检已启动：每 ${c.intervalSec} 秒检查一次，超过 ${c.slowMs}ms 或不通即自动切换`,
      'system'
    );
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.cfg();
    const iv = Math.min(600, Math.max(10, Number(c.intervalSec) || 30));
    const wait = delayMs == null ? iv * 1000 : Math.max(0, delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch(() => {}).then(() => this.schedule());
    }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  /** 设置改动后立即按新参数重排 */
  reconfigure() {
    if (this.manager.status === 'running') {
      if (!this.running) this.start();
      else this.schedule(0);
    }
  }

  /** 沿 now 链解析到最底层的实体节点：[主策略, 地区组, 节点] */
  chainOf(map, name) {
    const chain = [name];
    let cur = map && map[name];
    for (let i = 0; i < 4 && cur && cur.now && !chain.includes(cur.now); i += 1) {
      chain.push(cur.now);
      cur = map[cur.now];
    }
    return chain;
  }

  /** 把组名解析到最底层的实体节点（对组测延迟等价于对它的当前节点测，但直接测叶子更准） */
  resolveLeaf(map, name) {
    let cur = name;
    for (let i = 0; i < 4; i += 1) {
      const p = map && map[cur];
      if (!p || !p.now || p.now === cur) break;
      cur = p.now;
    }
    return cur;
  }

  /** 取节点延迟：优先用内核刚测过的 history（免费），过期才实际测一次 */
  async probe(map, name, c) {
    const hit = this.probeCache.get(name);
    if (hit && Date.now() - hit.at < 60000) return hit.delay;
    const leaf = this.resolveLeaf(map, name);
    if (leaf !== name) return this.probe(map, leaf, c);
    const p = map && map[name];
    const last = p && Array.isArray(p.history) && p.history.length ? p.history[p.history.length - 1] : null;
    const freshAt = last && last.time ? Date.parse(last.time) : NaN;
    if (last && typeof last.delay === 'number' && last.delay > 0 && Number.isFinite(freshAt) && Date.now() - freshAt < 180000) {
      this.probeCache.set(name, { at: Date.now(), delay: last.delay });
      return last.delay;
    }
    let delay = Infinity;
    try {
      // 超时就用阈值：比阈值还慢的节点等价于「不通」，不必等它真的超时
      delay = await this.api().delay(name, { url: this.testUrl(c), timeout: Math.max(900, Math.min(4000, Number(c.slowMs) || 1200)) });
    } catch (_) {
      delay = Infinity;
    }
    this.probeCache.set(name, { at: Date.now(), delay });
    return delay;
  }

  /** 批量评分，够快就提前结束，避免一次性把几十个节点全测一遍 */
  async scoreMembers(map, names, c) {
    const list = [];
    const target = Math.max(500, Math.round((Number(c.slowMs) || 1200) * 0.7));
    for (let i = 0; i < names.length; i += 6) {
      const part = names.slice(i, i + 6);
      const delays = await Promise.all(part.map((n) => this.probe(map, n, c)));
      part.forEach((n, idx) => list.push({ name: n, delay: delays[idx] }));
      if (list.some((x) => x.delay <= target)) break;
    }
    return list.sort((a, b) => a.delay - b.delay);
  }

  /** 从最贴近节点的 Selector 组开始往上层找候选 */
  async pickBest(map, chain, c, curDelay) {
    const isSel = (n) => map[n] && String(map[n].type || '') === 'Selector';
    const levels = chain.filter((n) => isSel(n)).reverse();
    const target = Math.max(500, Math.round((Number(c.slowMs) || 1200) * 0.7));
    for (const gname of levels) {
      const g = map[gname];
      const members = (g.all || []).filter(
        (n) => n && n !== 'DIRECT' && n !== 'REJECT' && n !== 'REJECT-DROP' && n !== 'PASS' && n !== g.now
      );
      if (!members.length) continue;
      const scored = await this.scoreMembers(map, members.slice(0, 8), c);
      const best = scored[0];
      if (!best || !(best.delay < Infinity)) continue;
      // 必须「绝对够快」且「比当前明显更快」，否则容易在两条慢线之间来回跳
      const goodEnough = best.delay <= target;
      const betterEnough = !(curDelay < Infinity) || best.delay < curDelay * 0.75;
      if (goodEnough && betterEnough) return { group: gname, name: best.name, delay: best.delay };
    }
    return null;
  }

  /**
   * 自动模式组（url-test / fallback / load-balance）不能手动 PUT 选择，
   * 但可以让内核立刻把组内所有节点重测一遍：重测后内核会自己把当前节点换成更快的那个，
   * 用户仍然留在原来的地区组里，比强行切到别的地区更符合预期。
   */
  async retestGroup(map, gname, c) {
    const g = map && map[gname];
    if (!g || !/^(URLTest|Fallback|LoadBalance)$/i.test(String(g.type || ''))) return null;
    const before = g.now;
    try {
      const url = encodeURIComponent(this.testUrl(c));
      const timeout = Math.max(1000, Number(c.slowMs) || 1200);
      await this.api().get(`/group/${encodeURIComponent(gname)}/delay?url=${url}&timeout=${timeout}`, 15000);
    } catch (_) {
      return null;
    }
    try {
      const fresh = await this.api().get('/proxies', 6000);
      const nm = (fresh && fresh.proxies) || {};
      const now = nm[gname] && nm[gname].now;
      if (now && now !== before) return { name: now, map: nm };
    } catch (_) {}
    return null;
  }

  async tick() {
    const c = this.cfg();
    if (c.enabled === false) return;
    if (this.busy) return;
    if (this.manager.status !== 'running' || !this.manager.api) return;
    // 用户刚手动切过：让位，别和用户抢
    if (Date.now() - (this.manager._userSelectAt || 0) < 45000) return;

    this.busy = true;
    try {
      const st = this.store.get();
      const mainName = (st.settings && st.settings.defaultTarget) || '主策略';
      const data = await this.api().get('/proxies', 6000);
      const map = (data && data.proxies) || {};
      const main = map[mainName];
      if (!main || !main.now) return;

      const chain = this.chainOf(map, mainName);
      const leaf = chain[chain.length - 1];
      if (!leaf || leaf === 'DIRECT' || leaf === 'REJECT' || leaf === 'REJECT-DROP') return;

      const delay = await this.probe(map, leaf, c);
      this.lastResult = { at: Date.now(), node: leaf, delay };
      this.manager.emit('autoswitch-state', this.summary());

      if (delay <= c.slowMs) { this.fails = 0; return; }
      this.fails += 1;
      if (this.fails < 2) return;   // 抖动过滤：连续两次采样都不过关才动手
      if (Date.now() - this.lastSwitchAt < (Number(c.cooldownSec) || 120) * 1000) return;

      const now = Date.now();
      this.switchTimes = this.switchTimes.filter((t) => now - t < 600000);
      if (this.switchTimes.length >= (Number(c.maxPer10Min) || 6)) {
        this.manager.pushLog(
          `[wallnut] 自动切换已达上限（10 分钟内 ${this.switchTimes.length} 次），暂停自动切换。建议检查订阅或网络环境。`,
          'system'
        );
        this.fails = 0;
        return;
      }

      // 先让内核自愈：自动模式的组（url-test）重测一遍后常常自己就换到更快的节点，
      // 这样用户不必被迫换地区。
      const deepest = chain.length >= 2 ? chain[chain.length - 2] : null;
      if (deepest) {
        const healed = await this.retestGroup(map, deepest, c);
        if (healed) {
          this.fails = 0;
          this.probeCache.clear();
          this.manager.pushLog(
            `[wallnut] 「${deepest}」重测后内核已自动换到「${healed.name}」，地区未变，无需跨地区切换`,
            'system'
          );
          this.manager.emit('autoswitch', { group: deepest, from: leaf, to: healed.name, healed: true });
          return;
        }
      }

      const pick = await this.pickBest(map, chain, c, delay);
      if (!pick) {
        this.manager.pushLog(
          `[wallnut] 当前节点「${leaf}」${delay === Infinity ? '不通' : delay + 'ms 过慢'}，但可选范围内没有更快且健康的节点`,
          'system'
        );
        this.fails = 0;
        return;
      }

      const r = await this.manager.select(pick.group, pick.name, { auto: true, timeout: 9000 });
      if (r && r.ok) {
        this.lastSwitchAt = Date.now();
        this.switchTimes.push(this.lastSwitchAt);
        this.fails = 0;
        this.probeCache.clear();
        const fromText = delay === Infinity ? '不通' : `${delay}ms`;
        const toText = pick.delay === Infinity ? '' : `（${pick.delay}ms）`;
        this.manager.pushLog(
          `[wallnut] 自动切换：「${leaf}」${fromText} →「${pick.name}」${toText}，热切换未重载配置`,
          'system'
        );
        this.manager.emit('autoswitch', {
          group: pick.group,
          from: leaf,
          to: pick.name,
          fromDelay: delay === Infinity ? null : delay,
          toDelay: pick.delay === Infinity ? null : pick.delay
        });
      } else if (r && r.error) {
        this.manager.pushLog(`[wallnut] 自动切换失败：${r.error}`, 'system');
      }
    } catch (err) {
      this.manager.pushLog('[wallnut] 节点巡检异常：' + ((err && err.message) || err), 'system');
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { AutoSwitcher };