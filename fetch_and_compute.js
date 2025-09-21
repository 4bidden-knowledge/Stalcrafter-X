// fetch_and_compute.js
// Node 18+ (GitHub Actions provides)
// Fetches StalcraftDB history for each item, computes 24h avg price, writes docs/prices.json

import fs from "fs/promises";
import fetch from "node-fetch";

const ITEMS = {
  // friendlyKey: item_id_on_stalcraftdb
  "adv_spare": "y3nmw",    // example; replace with real NA IDs
  "std_spare": "l0og1",
  "cheap_spare": "j0w96",
  "adv_tool": "4q7pl",
  "std_tool": "qjqw9",
  "cheap_tool": "wjlrd"
};

const REGION = "na";
const OUTPUT_PATH = "docs/prices.json";

function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }

async function fetchHistory(id){
  const url = `https://stalcraftdb.net/api/v1/auctions/history/${id}?region=${REGION}`;
  const resp = await fetch(url, { headers: { "User-Agent": "stalcraft-poller/1.0" }});
  if(!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

function compute24hAverage(prices){
  if(!Array.isArray(prices) || prices.length===0) return null;
  const now = Date.now();
  const dayAgo = now - 24*60*60*1000;
  const prices24 = prices
    .filter(p => new Date(p.time).getTime() >= dayAgo)
    .map(p => p.price)
    .filter(Boolean);
  if(prices24.length === 0) return null;
  const sum = prices24.reduce((a,b)=>a+b,0);
  return Math.round(sum / prices24.length);
}

async function main(){
  const out = { updated: new Date().toISOString(), region: REGION, prices: {} };
  const keys = Object.keys(ITEMS);
  for(let i=0;i<keys.length;i++){
    const key = keys[i];
    const id = ITEMS[key];
    try{
      const json = await fetchHistory(id);
      const avg = compute24hAverage(json.prices || json);
      out.prices[key] = {
        id,
        avg24h: avg,               // null if no data in last 24h
        sampleCountLast24h: (Array.isArray(json.prices)? json.prices.filter(p => new Date(p.time).getTime() >= (Date.now()-24*60*60*1000)).length : 0)
      };
      // stagger requests to be polite / avoid rate limits
      await sleep(1500 + Math.floor(Math.random()*1500));
    }catch(err){
      out.prices[key] = { id, error: String(err) };
      // continue to next item
      await sleep(2000);
    }
  }

  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out,null,2), "utf8");
  console.log("Wrote", OUTPUT_PATH);
}

main().catch(err=>{
  console.error(err);
  process.exit(1);
});
