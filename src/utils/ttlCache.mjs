/**
 * Small helpers for in-process TTL maps used as Redis fallbacks.
 */

export function sweepTtlMap(map, now = Date.now()) {
  if (!map || typeof map.entries !== "function") return 0;
  let removed = 0;
  for (const [key, value] of map) {
    if (value == null) {
      map.delete(key);
      removed++;
      continue;
    }
    if (typeof value.expires === "number" && value.expires <= now) {
      map.delete(key);
      removed++;
    }
  }
  return removed;
}

export function sweepExpiryTimestamps(map, now = Date.now()) {
  if (!map || typeof map.entries !== "function") return 0;
  let removed = 0;
  for (const [key, expiresAt] of map) {
    if (typeof expiresAt === "number" && expiresAt <= now) {
      map.delete(key);
      removed++;
    }
  }
  return removed;
}

export function trimMapSize(map, maxSize = 500) {
  if (!map || map.size <= maxSize) return 0;
  let removed = 0;
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
    removed++;
  }
  return removed;
}

export function startMapJanitor({
  maps = [],
  intervalMs = 60_000,
} = {}) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const entry of maps) {
      try {
        if (entry?.type === "expiry") sweepExpiryTimestamps(entry.map, now);
        else sweepTtlMap(entry.map, now);
        if (entry?.maxSize) trimMapSize(entry.map, entry.maxSize);
        if (typeof entry.custom === "function") entry.custom(now);
      } catch {}
    }
  }, Math.max(10_000, Number(intervalMs) || 60_000));

  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

export default {
  sweepTtlMap,
  sweepExpiryTimestamps,
  trimMapSize,
  startMapJanitor,
};
