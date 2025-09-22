// fetch_and_compute.js
// ESM, Node 18+ (no npm deps)
// Fetches StalcraftDB history for each item, computes weighted 24h and 7d avg prices, writes prices.json

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
const MAX_PAGES = 10; // increase to cover 7-day window for higher-volume items
const PER_PAGE_DELAY_MS = 500 + Math.floor(Math.random() * 300);
const BETWEEN_ITEMS_MS = 5500 + Math.floor(Math.random() * 1500);

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

    const resp = await fetch(url, { method: "GET", headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const data = await resp.json();
    const prices = Array.isArray(data.prices) ? data.prices : [];

    if (!prices.length) break;
    allPrices.push(...prices);

    // if the last item on this page is older than 7-day cutoff we can stop early
    const lastTime = parseTimestampToMs(prices[prices.length - 1]?.time);
    if (!Number.isNaN(lastTime) && lastTime < cutoff7) break;

    if (page < MAX_PAGES - 1) await sleep(PER_PAGE_DELAY_MS);
  }
  return allPrices;
}

function computeWindowStats(trades, windowDays) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const normalized = (trades || []).map(p => ({
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

  if (normalized.length === 0) return { avg: null, count: 0, min: null, max: null, totalUnits: 0 };

  const candidateA = normalized.map(p => p.price);
  const candidateB = normalized.map(p => p.price / p.amount);

  const medA = median(candidateA);
  const medB = median(candidateB);
  const madA = mad(candidateA, medA);
  const madB = mad(candidateB, medB);

  const relA = (medA && medA !== 0) ? (madA / Math.abs(medA)) : Infinity;
  const relB = (medB && medB !== 0) ? (madB / Math.abs(medB)) : Infinity;
  const LARGE_THRESHOLD = 1e6;

  const chooseB = (relB < relA) || (medA > LARGE_THRESHOLD && medB < medA);
  const unitPrices = chooseB ? candidateB : candidateA;

  const unitized = normalized.map((p, i) => ({
    unitPrice: unitPrices[i],
    amount: p.amount
  })).filter(u => Number.isFinite(u.unitPrice) && u.amount > 0);

  if (unitized.length === 0) return { avg: null, count: 0, min: null, max: null, totalUnits: 0 };

  const totalUnits = unitized.reduce((s, t) => s + t.amount, 0);
  const weightedSum = unitized.reduce((s, t) => s + t.unitPrice * t.amount, 0);
  const avg = totalUnits > 0 ? Math.round(weightedSum / totalUnits) : null;
  const unitVals = unitized.map(u => u.unitPrice);
  const min = Math.round(Math.min(...unitVals));
  const max = Math.round(Math.max(...unitVals));

  return { avg, count: unitized.length, min, max, totalUnits, detection: chooseB ? "price/amount" : "price" };
}

async function main() {
  const out = { updated: new Date().toISOString(), region: REGION, prices: {} };

  for (const [key, id] of Object.entries(ITEMS)) {
    try {
      const rawTrades = await fetchAllHistory(id);

      // compute 24h and 7d stats
      const w24 = computeWindowStats(rawTrades, 1);
      const w7 = computeWindowStats(rawTrades, 7);

      out.prices[key] = {
        id,
        avg24h: w24.avg,
        sampleCountLast24h: w24.count,
        min24h: w24.min,
        max24h: w24.max,
        avg7d: w7.avg,
        sampleCountLast7d: w7.count,
        min7d: w7.min,
        max7d: w7.max
      };

      await sleep(BETWEEN_ITEMS_MS);
    } catch (err) {
      out.prices[key] = { id, error: String(err) };
      await sleep(2000);
    }
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote", OUTPUT_PATH);
}

main().catch(err => { console.error(err); process.exit(1); });
