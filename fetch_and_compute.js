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

async function fetchHistory(id){ 
  const url = `https://stalcraftdb.net/api/items/${id}/auction-history?region=${REGION}&page=0`;
  const resp = await fetch(url, { headers: { "User-Agent": "stalcraft-poller/1.0" }});
  if(!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

// NEW: weighted per-unit average
function compute24hAverageWeighted(raw){
  if(!Array.isArray(raw) || raw.length === 0) return { avg24h: null, sampleCount: 0 };

  const cutoff = Date.now() - 24*60*60*1000;
  const trades = raw
    .filter(p => new Date(p.time).getTime() >= cutoff)
    .map(p => ({
      unitPrice: p.price / p.amount,
      amount: p.amount
    }))
    .filter(p => Number.isFinite(p.unitPrice) && p.amount > 0);

  if(trades.length === 0) return { avg24h: null, sampleCount: 0 };

  const totalUnits = trades.reduce((sum, t) => sum + t.amount, 0);
  const weightedSum = trades.reduce((sum, t) => sum + t.unitPrice * t.amount, 0);

  return {
    avg24h: totalUnits > 0 ? Math.round(weightedSum / totalUnits) : null,
    sampleCount: trades.length
  };
}

async function main(){
  const out = { updated: new Date().toISOString(), region: REGION, prices: {} };
  const keys = Object.keys(ITEMS);
  for(let i=0;i<keys.length;i++){
    const key = keys[i];
    const id = ITEMS[key];
    try{
      const json = await fetchHistory(id);
      const { avg24h, sampleCount } = compute24hAverageWeighted(json.prices || json);
      out.prices[key] = {
        id,
        avg24h,
        sampleCountLast24h: sampleCount
      };
      // stagger requests to avoid rate limits
      await sleep(5500 + Math.floor(Math.random()*1500));
    }catch(err){
      out.prices[key] = { id, error: String(err) };
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
