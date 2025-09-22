// fetch_and_compute.js
// Pure CommonJS (no npm deps), Node 18+
// Uses https + zlib instead of fetch

const fs = require("fs/promises");
const https = require("https");
const zlib = require("zlib");

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
const HISTORY_TIMESPAN_DAYS = 1;

// ---- HTTP fetch with headers ----
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let stream = res;
      // handle gzip/deflate/br transparently
      const enc = res.headers["content-encoding"];
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

      let data = "";
      stream.on("data", (chunk) => (data += chunk));
      stream.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error("Invalid JSON: " + err.message));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseTimestampToMs(raw) {
  if (!raw) return NaN;
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const parsed = Date.parse(raw);
  if (!isNaN(parsed)) return parsed;
  const num = Number(raw);
  return !isNaN(num) ? (num < 1e12 ? num * 1000 : num) : NaN;
}
function median(arr) { if (!arr.length) return null; const a = [...arr].sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function mad(arr,med){ if(!arr.length)return null; return median(arr.map(x=>Math.abs(x-med))); }

async function fetchAllHistory(id) {
  let allPrices = [];
  let page = 0;
  const cutoff = Date.now() - HISTORY_TIMESPAN_DAYS * 86400 * 1000;
  const MAX_PAGES = 2;
  while (page < MAX_PAGES) {
    const url = `https://stalcraftdb.net/api/items/${id}/auction-history?region=${REGION}&page=${page}`;
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Referer": `https://stalcraftdb.net/${REGION}/${id}`,
      "Connection": "keep-alive"
    };

    const data = await fetchJson(url, headers);
    const prices = Array.isArray(data.prices) ? data.prices : [];
    if (prices.length === 0) break;

    allPrices.push(...prices);
    const last = prices[prices.length - 1];
    if (parseTimestampToMs(last.time) < cutoff) break;

    page++;
    if (page < MAX_PAGES) await sleep(500 + Math.random() * 300);
  }
  return allPrices;
}

function compute24hAverageWeighted(rawArray) {
  if (!Array.isArray(rawArray) || !rawArray.length)
    return { avg24h: null, sampleCount: 0, min: null, max: null };

  const cutoff = Date.now() - HISTORY_TIMESPAN_DAYS * 86400 * 1000;
  const norm = rawArray.map(p => ({
    ts: parseTimestampToMs(p.time),
    price: Number(p.price),
    amount: Number(p.amount || 1)
  })).filter(p => p.ts >= cutoff && p.price > 0 && p.amount > 0);

  if (!norm.length) return { avg24h: null, sampleCount: 0, min: null, max: null };

  const candidateA = norm.map(p => p.price);
  const candidateB = norm.map(p => p.price / p.amount);
  const medA = median(candidateA), medB = median(candidateB);
  const madA = mad(candidateA, medA), madB = mad(candidateB, medB);
  const relA = medA ? madA / medA : Infinity;
  const relB = medB ? madB / medB : Infinity;
  const LARGE = 1e6;
  const useB = (relB < relA) || (medA > LARGE && medB < medA);

  const unitized = norm.map((p,i)=>({
    unitPrice: useB ? candidateB[i] : candidateA[i],
    amount: p.amount
  })).filter(u => u.unitPrice > 0);

  if (!unitized.length) return { avg24h: null, sampleCount: 0, min: null, max: null };

  const totalUnits = unitized.reduce((s,t)=>s+t.amount,0);
  const weightedSum = unitized.reduce((s,t)=>s+t.unitPrice*t.amount,0);
  const avg = Math.round(weightedSum / totalUnits);
  const unitVals = unitized.map(u=>u.unitPrice);

  return {
    avg24h: avg,
    sampleCount: unitized.length,
    min: Math.round(Math.min(...unitVals)),
    max: Math.round(Math.max(...unitVals)),
    detection: useB ? "price/amount (stack total detected)" : "price (per-unit detected)"
  };
}

async function main() {
  const out = { updated: new Date().toISOString(), region: REGION, prices: {} };
  for (const [key, id] of Object.entries(ITEMS)) {
    try {
      const raw = await fetchAllHistory(id);
      const r = compute24hAverageWeighted(raw);
      out.prices[key] = { id, ...r };
      await sleep(5500 + Math.random() * 1500);
    } catch (e) {
      out.prices[key] = { id, error: String(e) };
      await sleep(2000);
    }
  }
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out,null,2),"utf8");
  console.log("Wrote", OUTPUT_PATH);
}

main().catch(e => { console.error(e); process.exit(1); });
