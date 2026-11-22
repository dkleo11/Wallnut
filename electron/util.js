'use strict';

let seq = 0;
function uid(prefix = 'id') {
  seq = (seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * mihomo 的节点名不允许空、不允许与保留名冲突；这里只做最小清洗。
 */
function sanitizeProxyName(name, fallback = 'node') {
  let s = String(name == null ? '' : name).replace(/[\r\n\t]/g, ' ').trim();
  s = s.replace(/\s{2,}/g, ' ');
  if (!s) s = fallback;
  return s.slice(0, 120);
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function mergeDeep(base, patch) {
  if (Array.isArray(patch)) return clone(patch);
  if (patch && typeof patch === 'object' && !Array.isArray(base) && base && typeof base === 'object') {
    const out = { ...base };
    for (const k of Object.keys(patch)) out[k] = mergeDeep(base[k], patch[k]);
    return out;
  }
  return patch === undefined ? base : clone(patch);
}

const RESERVED_TARGETS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);

function isReservedName(name) {
  return RESERVED_TARGETS.has(String(name || '').toUpperCase());
}

module.exports = { uid, sleep, escapeRegex, sanitizeProxyName, clone, mergeDeep, isReservedName, RESERVED_TARGETS };
