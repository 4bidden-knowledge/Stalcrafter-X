// fetch_and_compute.js
// Node 18+ (GitHub Actions provides)
// Fetches StalcraftDB history for each item, computes weighted 24h avg price, writes prices.json

import fs from "fs/promises";

const ITEMS = {
  "adv_spare": "y3nmw",    // example; replace with real NA IDs
  "std_spare": "l0og1",
  "cheap_spare": "j0w96",
  "adv_tool": "4q7pl",
  "std_tool": "qjqw9",
  "cheap_tool": "wjlrd"
};

const REGION = "na";
const OUTPUT_PATH = "prices.json";

function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }

// ---- robust timestamp parser ----
function parseTimestampToMs(rawTime){
  if(rawTime == null) return NaN;
  if(typeof rawTime === "number"){
    // if looks like seconds (less than ~1e12), treat as seconds
    if(rawTime < 1e12) return rawTime * 1000;
    return rawTime;
  }
  // if string, try Date.parse first
  const parsed = Date.parse(rawTime);
  if(!isNaN(parsed)) return parsed;
  // fallback numeric string
  const asNum = Number(rawTime);
  if(!isNaN(asNum)){
    if(asNum < 1e12) return asNum * 1000;
    return asNum;
  }
  return NaN;
}

// ---- helper: median and MAD (robust) ----
function median(arr){
  if(!arr.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return a.length%2 ? a[mid] : (a[mid-1]+a[mid])/2;
}
function mad(arr, med){
  if(!arr.length) return null;
  const diffs = arr.map(x => Math.abs(x - med));
  return median(diffs);
}

// ---- fetch one page ----
async function fetchHistory(id, page=0){
  const url = `https://stalcraftdb.net/api/items/${id}/auction-history?region=${REGION}&page=${page}`;
  const resp = await fetch(url, { headers: { "User-Agent": "stalcraft-poller/1.0" }});
  if(!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

// ---- compute weighted average with auto-detect per-unit vs stack-total ----
function compute24hAverageWeighted(rawArray){
  // rawArray is expected as an array of { amount, price, time, ... }
  if(!Array.isArray(rawArray) || rawArray.length === 0) return {
    avg24h: null, sampleCount: 0, min: null, max: null
  };

const cutoff = Date.now() - 7*24*60*60*1000;


  // Normalize entries: timestamp ms, price number, amount number
  const normalized = rawArray.map(p => {
    const ts = parseTimestampToMs(p.time);
    return {
      ts,
      price: Number(p.price),
      amount: Number(p.amount || 1)
    };
  }).filter(p => !Number.isNaN(p.ts) && p.ts >= cutoff && Number.isFinite(p.price) && p.amount > 0);

  if(normalized.length === 0) return {
    avg24h: null, sampleCount: 0, min: null, max: null
  };

  // Candidate unit price arrays:
  // A = assume price field is already per-unit
  // B = assume price field is stack-total -> unit = price / amount
  const candidateA = normalized.map(p => p.price);
  const candidateB = normalized.map(p => p.price / p.amount);

  const medA = median(candidateA);
  const medB = median(candidateB);
  const madA = mad(candidateA, medA);
  const madB = mad(candidateB, medB);

  // Heuristic to choose which candidate to use:
  //  - Choose candidate with lower relative MAD (mad/median)
  //  - If median is tiny (edge cases), avoid division by zero.
  const relA = (medA && medA !== 0) ? (madA / Math.abs(medA)) : Infinity;
  const relB = (medB && medB !== 0) ? (madB / Math.abs(medB)) : Infinity;

  // Additional safety: if medA is extremely large (>> typical unit price ranges), prefer B
  // threshold chosen conservatively
  const LARGE_THRESHOLD = 1e6;

  let choosePerUnitCandidateB = false;
  if(relB < relA) choosePerUnitCandidateB = true;
  if(medA > LARGE_THRESHOLD && medB < medA) choosePerUnitCandidateB = true;

  const unitPrices = choosePerUnitCandidateB ? candidateB : candidateA;
  const chosenLabel = choosePerUnitCandidateB ? "price/amount (stack total detected)" : "price (per-unit detected)";

  // Convert to weighted average using amounts
  // Need amounts array corresponding to chosen unitPrices mapping
  const unitized = normalized.map((p, i) => ({
    unitPrice: unitPrices[i],
    amount: p.amount
  })).filter(u => Number.isFinite(u.unitPrice) && u.amount > 0);

  if(unitized.length === 0) return { avg24h: null, sampleCount: 0, min: null, max: null };

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
    detection: chosenLabel,
    medianCandidateA: Math.round(medA || 0),
    medianCandidateB: Math.round(medB || 0),
    relMadA: relA,
    relMadB: relB
  };
}

async function main(){
  const out = { updated: new Date().toISOString(), region: REGION, prices: {} };
  const keys = Object.keys(ITEMS);

  for(let i=0;i<keys.length;i++){
    const key = keys[i];
    const id = ITEMS[key];
    try{
      const json = await fetchHistory(id); // page 0 only, like your reference
      const rawPrices = Array.isArray(json.prices) ? json.prices : (Array.isArray(json) ? json : []);
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
          relMadB: result.relMadB
        }
      };

      // debug print for adv_spare so you can confirm
      if(key === "adv_spare"){
        console.log("DEBUG adv_spare computed:", out.prices[key]);
        console.log("SAMPLE raw entries (first 8):", rawPrices.slice(0,8));
      }

      await sleep(1200 + Math.floor(Math.random()*800));
    }catch(err){
      out.prices[key] = { id, error: String(err) };
      console.error(`Error for ${key} (${id}):`, err?.toString?.() || err);
      await sleep(2000);
    }
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out,null,2), "utf8");
  console.log("Wrote", OUTPUT_PATH);
}

main().catch(err=>{
  console.error(err);
  process.exit(1);
});
