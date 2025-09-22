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
const HISTORY_TIMESPAN_DAYS = 1; // Fetch history for the last 24 hours

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ---- robust timestamp parser ----
function parseTimestampToMs(rawTime) {
    if (rawTime == null) return NaN;
    if (typeof rawTime === "number") {
        if (rawTime < 1e12) return rawTime * 1000; // seconds to ms
        return rawTime;
    }
    const parsed = Date.parse(rawTime);
    if (!isNaN(parsed)) return parsed;
    const asNum = Number(rawTime);
    if (!isNaN(asNum)) {
        if (asNum < 1e12) return asNum * 1000;
        return asNum;
    }
    return NaN;
}

// ---- helper: median and MAD (robust) ----
function median(arr) {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function mad(arr, med) {
    if (!arr.length) return null;
    const diffs = arr.map(x => Math.abs(x - med));
    return median(diffs);
}

// ---- fetch all pages for a given item ----
async function fetchAllHistory(id) {
    let allPrices = [];
    let page = 0;
    const cutoff = Date.now() - (HISTORY_TIMESPAN_DAYS * 24 * 60 * 60 * 1000);

    while (true) {
        const url = `https://stalcraftdb.net/api/items/${id}/auction-history?region=${REGION}&page=${page}`;
        const resp = await fetch(url, { headers: { "User-Agent": "stalcraft-poller/1.0" } } );
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        
        const data = await resp.json();
        // The actual price data is in the 'prices' property of the response
        const prices = Array.isArray(data.prices) ? data.prices : [];

        if (prices.length === 0) {
            break; // No more prices on this page, so we're done.
        }

        allPrices.push(...prices);

        const lastPrice = prices[prices.length - 1];
        if (parseTimestampToMs(lastPrice.time) < cutoff) {
            break; // Stop if the last item is already outside our desired time window
        }

        page++;
        await sleep(500); // Be nice to the API
    }

    return allPrices;
}


// ---- compute weighted average with auto-detect per-unit vs stack-total ----
function compute24hAverageWeighted(rawArray) {
    if (!Array.isArray(rawArray) || rawArray.length === 0) return {
        avg24h: null, sampleCount: 0, min: null, max: null
    };

    // *** FIX: Use the same timespan constant as the fetcher ***
    const cutoff = Date.now() - (HISTORY_TIMESPAN_DAYS * 24 * 60 * 60 * 1000);

    const normalized = rawArray.map(p => ({
        ts: parseTimestampToMs(p.time),
        price: Number(p.price),
        amount: Number(p.amount || 1)
    })).filter(p => !Number.isNaN(p.ts) && p.ts >= cutoff && Number.isFinite(p.price) && p.amount > 0);

    if (normalized.length === 0) return {
        avg24h: null, sampleCount: 0, min: null, max: null
    };

    const candidateA = normalized.map(p => p.price);
    const candidateB = normalized.map(p => p.price / p.amount);

    const medA = median(candidateA);
    const medB = median(candidateB);
    const madA = mad(candidateA, medA);
    const madB = mad(candidateB, medB);

    const relA = (medA && medA !== 0) ? (madA / Math.abs(medA)) : Infinity;
    const relB = (medB && medB !== 0) ? (madB / Math.abs(medB)) : Infinity;

    const LARGE_THRESHOLD = 1e6;
    let choosePerUnitCandidateB = (relB < relA) || (medA > LARGE_THRESHOLD && medB < medA);

    const unitPrices = choosePerUnitCandidateB ? candidateB : candidateA;
    const chosenLabel = choosePerUnitCandidateB ? "price/amount (stack total detected)" : "price (per-unit detected)";

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
        detection: chosenLabel,
        medianCandidateA: Math.round(medA || 0),
        medianCandidateB: Math.round(medB || 0),
        relMadA: relA,
        relMadB: relB
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

            if (key === "adv_spare") {
                console.log("DEBUG adv_spare computed:", out.prices[key]);
                console.log(`SAMPLE raw entries (fetched ${rawPrices.length}):`, rawPrices.slice(0, 5));
            }

            await sleep(1200 + Math.floor(Math.random() * 800));
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
