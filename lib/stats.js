// lib/stats.js
// Per-unit price statistics with MAD-based outlier removal.
//
// The outlier method is the original one from fetch_and_compute.js: a modified
// z-score built on the median absolute deviation. It is kept because it adapts —
// it removes nothing when the data is clean and a lot when it is not, unlike a
// fixed percentile trim which always discards the same fraction.

export const OUTLIER_MAD_THRESHOLD = Number(process.env.OUTLIER_MAD_THRESHOLD || 2.5);
export const MIN_SAMPLES_FOR_OUTLIER_DETECTION = Number(process.env.MIN_SAMPLES_FOR_OUTLIER_DETECTION || 5);

export function median(arr) {
  if (!arr || !arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function mean(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

export function mad(arr, med) {
  if (!arr || !arr.length) return null;
  return median(arr.map((x) => Math.abs(x - med)));
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

export function detectOutliers(unitPrices, threshold = OUTLIER_MAD_THRESHOLD) {
  if (!unitPrices || unitPrices.length < MIN_SAMPLES_FOR_OUTLIER_DETECTION) {
    return unitPrices.map(() => false);
  }
  const med = median(unitPrices);
  const madValue = mad(unitPrices, med);
  if (madValue === 0) return unitPrices.map(() => false);
  return unitPrices.map((price) => Math.abs((0.6745 * (price - med)) / madValue) > threshold);
}

export function parseTimestampToMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
  return NaN;
}

/**
 * Normalise raw API entries to per-unit trades.
 * `price` is the total for the lot, so unit price divides by `amount`.
 * `additional.qlt` is the in-game quality tier and is preserved: on gear and
 * artefacts it moves price by orders of magnitude.
 */
export function normalise(trades) {
  return (Array.isArray(trades) ? trades : [])
    .map((p) => {
      const ts = parseTimestampToMs(p.time);
      const price = Number(p.price);
      const amount = Number(p.amount || 1);
      const qlt = Number.isFinite(Number(p.additional?.qlt)) ? Number(p.additional.qlt) : null;
      return { ts, price, amount, unitPrice: price / amount, qlt };
    })
    .filter((p) => !Number.isNaN(p.ts) && Number.isFinite(p.unitPrice) && p.unitPrice > 0 && p.amount > 0);
}

/** Weighted per-unit stats over a trailing window, with outliers removed. */
export function computeWindowStats(trades, windowDays, { key = "item", preNormalised = false } = {}) {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const normalized = (preNormalised ? trades : normalise(trades)).filter((p) => p.ts >= cutoff);

  const empty = {
    avg: null, mean: null, median: null, p25: null, p75: null,
    count: 0, min: null, max: null, totalUnits: 0,
    outliers: [], cleanCount: 0, outliersRemoved: 0
  };
  if (!normalized.length) return empty;

  const unitPrices = normalized.map((p) => p.unitPrice);
  const flags = detectOutliers(unitPrices);

  const outliers = [];
  const clean = [];
  normalized.forEach((p, i) => {
    if (flags[i]) {
      outliers.push({
        itemKey: key,
        windowDays,
        timestamp: new Date(p.ts).toISOString(),
        price: p.price,
        amount: p.amount,
        unitPrice: Math.round(p.unitPrice),
        reason: "MAD_outlier"
      });
    } else {
      clean.push(p);
    }
  });

  if (!clean.length) return { ...empty, count: normalized.length, outliers, outliersRemoved: outliers.length };

  const totalUnits = clean.reduce((s, t) => s + t.amount, 0);
  const weightedSum = clean.reduce((s, t) => s + t.unitPrice * t.amount, 0);
  const vals = clean.map((t) => t.unitPrice);
  const sorted = [...vals].sort((a, b) => a - b);

  return {
    avg: totalUnits > 0 ? Math.round(weightedSum / totalUnits) : null,
    mean: Math.round(mean(vals)),
    median: Math.round(median(vals)),
    p25: Math.round(quantile(sorted, 0.25)),
    p75: Math.round(quantile(sorted, 0.75)),
    count: normalized.length,
    min: Math.round(Math.min(...vals)),
    max: Math.round(Math.max(...vals)),
    totalUnits,
    outliers,
    cleanCount: clean.length,
    outliersRemoved: outliers.length
  };
}

/**
 * Split trades by quality tier and report how far apart the tiers sit.
 * A large spread means any pooled average is describing a mixture rather than a
 * price, which matters for gear and artefacts and not at all for commodity
 * crafting materials (which all sit at tier 0).
 */
export function qualityTiers(trades, { windowDays = 7, preNormalised = false } = {}) {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const normalized = (preNormalised ? trades : normalise(trades)).filter((p) => p.ts >= cutoff);

  const groups = new Map();
  for (const trade of normalized) {
    const key = trade.qlt ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }

  const tiers = [...groups.entries()]
    .map(([quality, group]) => {
      const vals = group.map((t) => t.unitPrice);
      const units = group.reduce((s, t) => s + t.amount, 0);
      const weighted = group.reduce((s, t) => s + t.unitPrice * t.amount, 0);
      return {
        quality,
        count: group.length,
        share: normalized.length ? group.length / normalized.length : 0,
        avg: units > 0 ? Math.round(weighted / units) : null,
        median: Math.round(median(vals)),
        min: Math.round(Math.min(...vals)),
        max: Math.round(Math.max(...vals))
      };
    })
    .sort((a, b) => {
      if (a.quality === "unknown") return 1;
      if (b.quality === "unknown") return -1;
      return a.quality - b.quality;
    });

  const solid = tiers.filter((t) => t.count >= 3 && t.median > 0);
  const spread = solid.length > 1
    ? Math.max(...solid.map((t) => t.median)) / Math.min(...solid.map((t) => t.median))
    : null;

  return { tiers, spread };
}
