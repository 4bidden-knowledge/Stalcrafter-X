// compute_stats.js
// ESM, Node 18+
// Compute per-unit average, mean, median, min/max with outlier filtering.

function median(arr) {
  if (!arr || !arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function mean(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

function mad(arr, med) {
  if (!arr || !arr.length) return null;
  const diffs = arr.map(x => Math.abs(x - med));
  return median(diffs);
}

function detectOutliers(unitPrices, threshold = 2.5, minSamples = 5) {
  if (!unitPrices || unitPrices.length < minSamples) {
    return unitPrices.map(() => false);
  }
  const med = median(unitPrices);
  const madValue = mad(unitPrices, med);
  if (madValue === 0) return unitPrices.map(() => false);
  return unitPrices.map(price => {
    const z = 0.6745 * (price - med) / madValue;
    return Math.abs(z) > threshold;
  });
}

function parseTimestampToMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
  return NaN;
}

export function computeWindowStats(trades, windowDays, { key = "item" } = {}) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const normalized = (Array.isArray(trades) ? trades : []).map(p => ({
    ts: parseTimestampToMs(p.time),
    price: Number(p.price),
    amount: Number(p.amount || 1)
  })).filter(p =>
    !Number.isNaN(p.ts) &&
    p.ts >= cutoff &&
    p.price > 0 &&
    p.amount > 0
  );

  if (normalized.length === 0) return {
    avg: null, mean: null, median: null, count: 0,
    min: null, max: null, totalUnits: 0,
    outliers: [], cleanCount: 0
  };

  const unitPrices = normalized.map(p => p.price / p.amount);
  const outlierFlags = detectOutliers(unitPrices);

  const cleanData = [];
  const outliers = [];
  normalized.forEach((p, i) => {
    const unitPrice = unitPrices[i];
    if (outlierFlags[i]) {
      outliers.push({
        key, windowDays,
        ts: new Date(p.ts).toISOString(),
        price: p.price, amount: p.amount, unitPrice
      });
    } else {
      cleanData.push({ unitPrice, amount: p.amount });
    }
  });

  if (!cleanData.length) return {
    avg: null, mean: null, median: null,
    count: normalized.length,
    min: null, max: null,
    totalUnits: 0, outliers, cleanCount: 0
  };

  const totalUnits = cleanData.reduce((s, t) => s + t.amount, 0);
  const weightedSum = cleanData.reduce((s, t) => s + t.unitPrice * t.amount, 0);
  const avg = Math.round(weightedSum / totalUnits);
  const vals = cleanData.map(u => u.unitPrice);

  return {
    avg,
    mean: Math.round(mean(vals)),
    median: Math.round(median(vals)),
    count: normalized.length,
    min: Math.round(Math.min(...vals)),
    max: Math.round(Math.max(...vals)),
    totalUnits,
    outliers,
    cleanCount: cleanData.length
  };
}
