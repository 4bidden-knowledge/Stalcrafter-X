// fetch_and_compute.js
// ESM, Node 18+ (no npm deps)
// Polls stalcraftdb auction-history, computes weighted 24h & 7d per-unit averages,
// writes prices.json and prices.csv next to each other.
// Now with proper unit price calculation and outlier detection

import fs from "fs/promises";

const ITEMS = {
  "adv_spare": "y3nmw",
  "std_spare": "l0og1",
  "cheap_spare": "j0w96",
  "adv_tool": "4q7pl",
  "std_tool": "qjqw9",
  "cheap_tool": "wjlrd",
  "str_boar": "5lo3o",
  "polymer":  "jl26",
  "water_carrier": "m22k",
  "plastic_bottle": "pry2",
  "ammonia": "40vn"
};

const REGION = process.env.REGION || "na";
const OUTPUT_JSON = process.env.OUTPUT_JSON || "prices.json";
const OUTPUT_CSV = OUTPUT_JSON.replace(/\.json$/i, "") + ".csv";
const OUTLIERS_JSON = process.env.OUTLIERS_JSON || "outliers.json";

const MAX_PAGES = Number(process.env.MAX_PAGES || 10); // increase if needed for heavy items
const PER_PAGE_DELAY_MS = Number(process.env.PER_PAGE_DELAY_MS || (500 + Math.floor(Math.random() * 300)));
const BETWEEN_ITEMS_MS = Number(process.env.BETWEEN_ITEMS_MS || (5500 + Math.floor(Math.random() * 1500)));

// Outlier detection parameters  
const OUTLIER_MAD_THRESHOLD = Number(process.env.OUTLIER_MAD_THRESHOLD || 2.5);
const MIN_SAMPLES_FOR_OUTLIER_DETECTION = Number(process.env.MIN_SAMPLES_FOR_OUTLIER_DETECTION || 5);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseTimestampToMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
  return NaN;
}

function median(arr) {
  if (!arr || !arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function mad(arr, med) {
  if (!arr || !arr.length) return null;
  const diffs = arr.map(x => Math.abs(x - med));
  return median(diffs);
}

// Modified Z-score outlier detection using MAD
function detectOutliers(unitPrices, threshold = OUTLIER_MAD_THRESHOLD) {
  if (!unitPrices || unitPrices.length < MIN_SAMPLES_FOR_OUTLIER_DETECTION) {
    return unitPrices.map(() => false);
  }
  
  const med = median(unitPrices);
  const madValue = mad(unitPrices, med);
  
  if (madValue === 0) {
    return unitPrices.map(() => false); // All values identical
  }
  
  return unitPrices.map(price => {
    const modifiedZScore = 0.6745 * (price - med) / madValue;
    return Math.abs(modifiedZScore) > threshold;
  });
}

// fetch up to MAX_PAGES pages for an item. stop early if last entry is older than cutoff7d
async function fetchAllHistory(id) {
  const cutoff7 = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const headersBase = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin"
  };

  let allPrices = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://stalcraftdb.net/api/items/${id}/auction-history?region=${REGION}&page=${page}`;
    const headers = { ...headersBase, "Referer": `https://stalcraftdb.net/${REGION}/${id}` };

    let resp;
    try {
      resp = await fetch(url, { method: "GET", headers });
    } catch (err) {
      throw new Error(`Network error for ${url}: ${err?.message || err}`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      throw new Error(`Invalid JSON from ${url}: ${err?.message || err}`);
    }

    // canonicalize possible shapes: prefer data.prices array, otherwise try data (if array)
    const prices = Array.isArray(data.prices) ? data.prices : (Array.isArray(data) ? data : []);
    if (!prices.length) break;

    allPrices.push(...prices);

    // stop early if last entry of page is older than 7-day cutoff
    const last = prices[prices.length - 1];
    const lastTs = parseTimestampToMs(last?.time);
    if (!Number.isNaN(lastTs) && lastTs < cutoff7) break;

    if (page < MAX_PAGES - 1) await sleep(PER_PAGE_DELAY_MS);
  }
  return allPrices;
}

// compute weighted per-unit average for a given window in days (1 or 7) with outlier detection
function computeWindowStats(trades, windowDays, itemKey) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  // Always normalize to get unit prices
  const normalized = (Array.isArray(trades) ? trades : []).map(p => ({
    ts: parseTimestampToMs(p.time),
    price: Number(p.price),
    amount: Number(p.amount || 1),
    original: p
  })).filter(p =>
    !Number.isNaN(p.ts) &&
    p.ts >= cutoff &&
    Number.isFinite(p.price) &&
    p.price > 0 &&
    p.amount > 0
  );

  if (normalized.length === 0) return { 
    avg: null, 
    count: 0, 
    min: null, 
    max: null, 
    totalUnits: 0, 
    outliers: [],
    cleanCount: 0
  };

  // ALWAYS calculate unit prices (price per single item)
  const unitPrices = normalized.map(p => p.price / p.amount);
  
  // Filter out any invalid unit prices
  const validEntries = [];
  normalized.forEach((p, i) => {
    const unitPrice = unitPrices[i];
    if (Number.isFinite(unitPrice) && unitPrice > 0) {
      validEntries.push({
        ...p,
        unitPrice
      });
    }
  });

  if (validEntries.length === 0) return {
    avg: null, 
    count: normalized.length, 
    min: null, 
    max: null, 
    totalUnits: 0, 
    outliers: [],
    cleanCount: 0
  };

  // Extract just the unit prices for outlier detection
  const validUnitPrices = validEntries.map(e => e.unitPrice);
  
  // Detect outliers based on unit prices
  const outlierFlags = detectOutliers(validUnitPrices);
  
  const outliers = [];
  const cleanData = [];
  
  validEntries.forEach((entry, i) => {
    if (outlierFlags[i]) {
      outliers.push({
        itemKey,
        windowDays,
        timestamp: new Date(entry.ts).toISOString(),
        price: entry.price,
        amount: entry.amount,
        unitPrice: Math.round(entry.unitPrice),
        reason: "MAD_outlier"
      });
    } else {
      cleanData.push({
        unitPrice: entry.unitPrice,
        amount: entry.amount
      });
    }
  });

  if (cleanData.length === 0) return { 
    avg: null, 
    count: validEntries.length, 
    min: null, 
    max: null, 
    totalUnits: 0, 
    outliers,
    cleanCount: 0
  };

  // Calculate weighted average using clean data
  const totalUnits = cleanData.reduce((s, t) => s + t.amount, 0);
  const weightedSum = cleanData.reduce((s, t) => s + t.unitPrice * t.amount, 0);
  const avg = totalUnits > 0 ? Math.round(weightedSum / totalUnits) : null;
  const unitVals = cleanData.map(u => u.unitPrice);
  const min = Math.round(Math.min(...unitVals));
  const max = Math.round(Math.max(...unitVals));

  return { 
    avg, 
    count: validEntries.length, 
    min, 
    max, 
    totalUnits, 
    outliers,
    cleanCount: cleanData.length,
    outliersRemoved: outliers.length
  };
}

function csvEscapeCell(cell){
  if (cell === null || cell === undefined) return "";
  const s = String(cell);
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  const out = { updated: new Date().toISOString(), region: REGION, prices: {} };
  const allOutliers = {
    updated: new Date().toISOString(),
    region: REGION,
    outlierDetectionSettings: {
      madThreshold: OUTLIER_MAD_THRESHOLD,
      minSamplesForDetection: MIN_SAMPLES_FOR_OUTLIER_DETECTION
    },
    outliers: []
  };

  for (const [key, id] of Object.entries(ITEMS)) {
    try {
      console.log(`Processing ${key} (${id})...`);
      const rawTrades = await fetchAllHistory(id);

      const w24 = computeWindowStats(rawTrades, 1, key);
      const w7 = computeWindowStats(rawTrades, 7, key);

      // Log some debug info for water_carrier
      if (key === 'water_carrier') {
        console.log(`Water carrier debug - 24h: ${w24.count} samples, ${w24.cleanCount} clean, avg: ${w24.avg}`);
        console.log(`Water carrier debug - 7d: ${w7.count} samples, ${w7.cleanCount} clean, avg: ${w7.avg}`);
      }

      // Collect outliers
      allOutliers.outliers.push(...w24.outliers, ...w7.outliers);

      out.prices[key] = {
        id,
        avg24h: w24.avg,
        sampleCountLast24h: w24.count,
        cleanSampleCount24h: w24.cleanCount,
        outliersRemoved24h: w24.outliersRemoved,
        min24h: w24.min,
        max24h: w24.max,
        avg7d: w7.avg,
        sampleCountLast7d: w7.count,
        cleanSampleCount7d: w7.cleanCount,
        outliersRemoved7d: w7.outliersRemoved,
        min7d: w7.min,
        max7d: w7.max,
        totalUnits7d: w7.totalUnits
      };

      await sleep(BETWEEN_ITEMS_MS);
    } catch (err) {
      out.prices[key] = { id, error: String(err) };
      // continue, but keep polite delay
      await sleep(2000);
    }
  }

  // write JSON
  try {
    await fs.writeFile(OUTPUT_JSON, JSON.stringify(out, null, 2), "utf8");
    console.log("Wrote", OUTPUT_JSON);
  } catch (err) {
    console.error("Failed to write JSON:", err);
  }

  // write outliers JSON
  try {
    await fs.writeFile(OUTLIERS_JSON, JSON.stringify(allOutliers, null, 2), "utf8");
    console.log(`Wrote ${OUTLIERS_JSON} with ${allOutliers.outliers.length} outliers detected`);
  } catch (err) {
    console.error("Failed to write outliers JSON:", err);
  }

  // write CSV (header + rows)
  try {
    const header = [
      "key",
      "id",
      "avg24h",
      "sampleCountLast24h",
      "cleanSampleCount24h",
      "outliersRemoved24h",
      "min24h",
      "max24h",
      "avg7d",
      "sampleCountLast7d",
      "cleanSampleCount7d",
      "outliersRemoved7d",
      "min7d",
      "max7d",
      "totalUnits7d"
    ];
    const rows = [header];
    for (const [k, v] of Object.entries(out.prices || {})) {
      rows.push([
        k,
        v.id ?? "",
        v.avg24h ?? "",
        v.sampleCountLast24h ?? "",
        v.cleanSampleCount24h ?? "",
        v.outliersRemoved24h ?? "",
        v.min24h ?? "",
        v.max24h ?? "",
        v.avg7d ?? "",
        v.sampleCountLast7d ?? "",
        v.cleanSampleCount7d ?? "",
        v.outliersRemoved7d ?? "",
        v.min7d ?? "",
        v.max7d ?? "",
        v.totalUnits7d ?? ""
      ].map(csvEscapeCell));
    }
    const csvText = rows.map(r => r.join(",")).join("\n");
    await fs.writeFile(OUTPUT_CSV, csvText, "utf8");
    console.log("Wrote", OUTPUT_CSV);
  } catch (err) {
    console.error("Failed to write CSV:", err);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
