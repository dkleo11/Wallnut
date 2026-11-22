export function createTrafficSampler() {
  let previous = null;
  return (connections) => {
    const active = { direct: false, proxy: false };
    const current = new Map();
    for (const { id, chains, upload, download } of connections) {
      if (!id) continue;
      const target = chains?.[0]; // mihomo reports the outbound leaf first.
      const counters = { up: Number(upload) || 0, down: Number(download) || 0 };
      current.set(id, counters);
      if (!previous || !target || /^(?:REJECT(?:-DROP)?|PASS)$/i.test(target)) continue;
      const before = previous.get(id);
      if (counters.up < (before?.up || 0) || counters.down < (before?.down || 0)) continue;
      if (counters.up > (before?.up || 0) || counters.down > (before?.down || 0)) {
        active[target.toUpperCase() === 'DIRECT' ? 'direct' : 'proxy'] = true;
      }
    }
    previous = current;
    return active;
  };
}

export function isRejectedRoute(message) {
  return /\bmatch\s+.+\s+using\s+(?:REJECT(?:-DROP)?|.+\[REJECT(?:-DROP)?\])\s*$/i.test(message);
}
