export function createTrafficSampler() {
  let previous = null;
  let previousAt = 0;
  return (connections = []) => {
    const active = { direct: false, proxy: false };
    const current = new Map();
    const now = Date.now();
    const dt = previous ? Math.max(0.2, (now - previousAt) / 1000) : 1;
    let proxyRate = 0;
    let directRate = 0;
    let upRate = 0;
    let downRate = 0;
    for (const { id, chains, upload, download } of connections) {
      if (!id) continue;
      const target = chains?.[0]; // mihomo reports the outbound leaf first.
      const counters = { up: Number(upload) || 0, down: Number(download) || 0 };
      current.set(id, counters);
      if (!previous || !target || /^(?:REJECT(?:-DROP)?|PASS)$/i.test(target)) continue;
      const before = previous.get(id);
      if (counters.up < (before?.up || 0) || counters.down < (before?.down || 0)) continue;
      const dUp = counters.up - (before?.up || 0);
      const dDown = counters.down - (before?.down || 0);
      if (dUp <= 0 && dDown <= 0) continue;
      const rate = (dUp + dDown) / dt;
      upRate += dUp / dt;
      downRate += dDown / dt;
      if (target.toUpperCase() === 'DIRECT') {
        active.direct = true;
        directRate += rate;
      } else {
        active.proxy = true;
        proxyRate += rate;
      }
    }
    previous = current;
    previousAt = now;
    return { ...active, proxyRate, directRate, upRate, downRate, totalRate: proxyRate + directRate, conns: connections.length };
  };
}

export function isRejectedRoute(message) {
  return /\bmatch\s+.+\s+using\s+(?:REJECT(?:-DROP)?|.+\[REJECT(?:-DROP)?\])\s*$/i.test(message);
}
