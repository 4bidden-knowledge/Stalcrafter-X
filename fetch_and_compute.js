// fetch_and_compute.js
// ESM, Node 18+ (no npm deps)
// Replace your file with this. Uses global fetch and fs/promises.

import fs from "fs/promises";

const ITEMS = {
  "adv_spare": "y3nmw",
  "std_spare": "l0og1",
  "cheap_spare": "j0w96",
  "adv_tool": "4q7pl",
  "std_tool": "qjqw9",
  "cheap_tool": "wjlrd"
};

const REGION = "na";
const OUTPUT_PATH = "prices.json";
const HISTORY_TIMESPAN_DAYS = Number(process.env.HISTORY_TIMESPAN_DAYS || 1); // default 1 day

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseTimestampToMs(rawTime) {
  if (rawTime == null) return NaN;
  if (typeof rawTime === "number") return rawTime < 1e12 ? rawTime * 1000 : rawTime;
  const parsed = Date.parse(rawTime);
  if (!Number.isNaN(parsed)) return parsed;
  const asNum = Number(rawTime);
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

async function fetchAllHistory(id) {
  const MAX_PAGES = 2;
  const cutoff = Date.now() - HISTORY_TIMESPAN_DAYS * 24 * 60 * 60 * 1000;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Referer": `https://stalcraftdb.net/${REGION}/`, // site-level referer ok; item referer used later per-request
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin"
  };

  let allPrices = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://stalcraftdb.net/api/items/${id}/auction-history?region=${REGION}&page=${page}`;
    // set Referer to item page (some endpoints require it)
    const reqHeaders = { ...headers, "Referer": `https://stalcraftdb.net/${REGION}/${id}` };

    const resp = await fetch(url, { method: "GET", headers: reqHeaders });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const data = await resp.json();
    const prices = Array.isArray(data.prices) ? data.prices : [];

    if (!prices.length) break;
    allPrices.push(...prices);

    // stop early if last item on page is older than cutoff
    const last = prices[prices.length - 1];
    if (parseTimestampToMs(last?.time) < cutoff) break;

    // polite delay between pages
    if (page < MAX_PAGES - 1) await sleep(500 + Math.floor(Math.random() * 300));
  }

  return allPrices;
}

function compute24hAverageWeighted(rawArray) {
  if (!Array.isArray(rawArray) || rawArray.length === 0) {
    return { avg24h: null, sampleCount: 0, min: null, max: null };
  }

  const cutoff = Date.now() - HISTORY_TIMESPAN_DAYS * 24 * 60 * 60 * 1000;

  const normalized = rawArray.map(p => ({
    ts: parseTimestampToMs(p.time),
    price: Number(p.price),
    amount: Number(p.amount || 1)
  })).filter(p =>
    !Number.isNaN(p.ts) &&
    p.ts >= cutoff &&
    Number.isFinite(p.price) &&
    p.price > 0 &&
    p.amount > 0
  );

  if (normalized.length === 0) return { avg24h: null, sampleCount: 0, min: null, max: null };

  const candidateA = normalized.map(p => p.price);
  const candidateB = normalized.map(p => p.price / p.amount);

  const medA = median(candidateA);
  const medB = median(candidateB);
  const madA = mad(candidateA, medA);
  const madB = mad(candidateB, medB);

  const relA = (medA && medA !== 0) ? (madA / Math.abs(medA)) : Infinity;
  const relB = (medB && medB !== 0) ? (madB / Math.abs(medB)) : Infinity;

  const LARGE_THRESHOLD = 1e6;
  const choosePerUnitCandidateB = (relB < relA) || (medA > LARGE_THRESHOLD && medB < medA);

  const unitPrices = choosePerUnitCandidateB ? candidateB : candidateA;

  const unitized = normalized.map((p, i) => ({
    unitPrice: unitPrices[i],
    amount: p.amount
  })).filter(u => Number.isFinite(u.unitPrice) && u.amount > 0);

  if (unitized.length === 0) return { avg24h: null, sampleCount: 0, min: null, max: null };

  const totalUnits = unitized.reduce((s, t) => s + t.amount, 0);
  const weightedSum = unitized.reduce((s, t) => s + t.unitPrice * t.amount, 0);
  const avg = totalUnits > 0 ? Math.round(weightedSum / totalUnits) : null;

  const unitValues = unitized.map(u => u.unitPrice);
  const min = Math.round(Math.min(...unitValues));
  const max = Math.round(Math.max(...unitValues));

  return {
    avg24h: avg,
    sampleCount: unitized.length,
    min,
    max,
    detection: choosePerUnitCandidateB ? "price/amount (stack total detected)" : "price (per-unit detected)",
    medianCandidateA: Math.round(medA || 0),
    medianCandidateB: Math.round(medB || 0),
    relMadA: relA,
    relMadB: relB,
    totalUnits
  };
}

async function main() {
  const out = { updated: new Date().toISOString(), region: REGION, prices: {} };
  const keys = Object.keys(ITEMS);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const id = ITEMS[key];
    try {
      const rawPrices = await fetchAllHistory(id);
      // debug for adv_spare
      if (key === "adv_spare") {
        console.log("DEBUG adv_spare: fetched entries:", rawPrices.length);
        console.log("DEBUG adv_spare sample:", rawPrices.slice(0, 8));
      }
      const result = compute24hAverageWeighted(rawPrices);
      out.prices[key] = {
        id,
        avg24h: result.avg24h,
        sampleCountLast24h: result.sampleCount,
        min: result.min,
        max: result.max,
        debug: {
          detection: result.detection,
          medianCandidateA: result.medianCandidateA,
          medianCandidateB: result.medianCandidateB,
          relMadA: result.relMadA,
          relMadB: result.relMadB,
          totalUnits: result.totalUnits
        }
      };
      await sleep(5500 + Math.floor(Math.random() * 1500));
    } catch (err) {
      out.prices[key] = { id, error: String(err) };
      console.error(`Error for ${key} (${id}):`, err?.toString?.() || err);
      await sleep(2000);
    }
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote", OUTPUT_PATH);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
