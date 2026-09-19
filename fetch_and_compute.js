// fetch_and_compute.js
// ESM, Node 18+ (no npm deps)
//
// Polls stalcraftdb auction-history for the items in items.json, merges each run
// into history/, and writes:
//
//   prices.json / prices.csv  weighted 24h & 7d per-unit averages (schema
//                             unchanged — the crafting calculator reads these)
//   outliers.json             audit trail of MAD-removed trades
//   market.json               richer feed: windows, quality tiers, provenance
//
// The host hands out synthetic stubs at random and bans clients that exceed its
// rate limit, so see lib/source.js for how both are handled.

import fs from "fs/promises";
import { Source, BannedError, HostHealthBreaker } from "./lib/source.js";
import { computeWindowStats, qualityTiers, normalise } from "./lib/stats.js";
import { mergeHistory, loadHistory } from "./lib/store.js";

const REGION = process.env.REGION || "na";
const OUTPUT_JSON = process.env.OUTPUT_JSON || "prices.json";
const OUTPUT_CSV = OUTPUT_JSON.replace(/\.json$/i, "") + ".csv";
const OUTLIERS_JSON = process.env.OUTLIERS_JSON || "outliers.json";
const MARKET_JSON = process.env.MARKET_JSON || "market.json";
const ITEMS_FILE = process.env.ITEMS_FILE || "items.json";
const MAX_PAGES = Number(process.env.MAX_PAGES || 10);

async function loadItems() {
  const raw = JSON.parse(await fs.readFile(ITEMS_FILE, "utf8"));
  const items = Array.isArray(raw) ? raw : raw.items;
  if (!Array.isArray(items) || !items.length) throw new Error(`No items defined in ${ITEMS_FILE}`);
  return items.filter((item) => item && item.key && item.id);
}

/** Previously observed totals, used to spot a collapsed response. */
async function loadKnownTotals() {
  try {
    const market = JSON.parse(await fs.readFile(MARKET_JSON, "utf8"));
    const out = {};
    for (const [key, entry] of Object.entries(market.items ?? {})) {
      if (entry.reportedTotal) out[key] = entry.reportedTotal;
    }
    return out;
  } catch {
    return {};
  }
}

/** The last published feed, so a failed run can fall back to it. */
async function loadPreviousPrices() {
  try {
    const previous = JSON.parse(await fs.readFile(OUTPUT_JSON, "utf8"));
    return previous?.prices ?? {};
  } catch {
    return {};
  }
}

const hasUsablePrice = (entry) =>
  Boolean(entry) && !entry.error && (Number.isFinite(entry.avg7d) || Number.isFinite(entry.avg24h));

function csvEscapeCell(cell) {
  if (cell === null || cell === undefined) return "";
  return `"${String(cell).replace(/"/g, '""')}"`;
}

async function main() {
  const items = await loadItems();
  const knownTotals = await loadKnownTotals();
  const previousPrices = await loadPreviousPrices();
  const source = new Source({ region: REGION });
  const breaker = new HostHealthBreaker(Number(process.env.HOST_DOWN_AFTER || 6));
  let carriedForward = 0;
  let hostDegraded = false;

  const out = { updated: new Date().toISOString(), region: REGION, prices: {} };
  const market = {
    updated: new Date().toISOString(),
    region: REGION,
    generator: "Stalcrafter-X",
    items: {}
  };
  const allOutliers = {
    updated: new Date().toISOString(),
    region: REGION,
    outlierDetectionSettings: {
      madThreshold: Number(process.env.OUTLIER_MAD_THRESHOLD || 2.5),
      minSamplesForDetection: Number(process.env.MIN_SAMPLES_FOR_OUTLIER_DETECTION || 5)
    },
    outliers: []
  };

  let banned = false;

  for (const item of items) {
    if (hostDegraded) break;
    const { key, id } = item;
    try {
      process.stdout.write(`Processing ${key} (${id})... `);

      // Items we have previously captured real data for get a bigger retry
      // budget, since we know asking repeatedly can pay off for them.
      const stored = await loadHistory(REGION, id);
      const known = knownTotals[key] ?? (stored.trades.length ? stored.trades.length : null);

      const fetched = await source.fetchHistory(id, {
        maxPages: MAX_PAGES,
        windowDays: 7,
        knownTotal: known
      });
      if (breaker.record(fetched)) hostDegraded = true;

      // Merge into the accumulated history and compute from the union, so a run
      // that gets mostly stubs still reports on everything captured previously.
      const { record, added } = await mergeHistory(REGION, id, fetched.prices);
      const trades = normalise(record.trades);

      const w24 = computeWindowStats(trades, 1, { key, preNormalised: true });
      const w7 = computeWindowStats(trades, 7, { key, preNormalised: true });
      const tiers = qualityTiers(trades, { windowDays: 7, preNormalised: true });

      allOutliers.outliers.push(...w24.outliers, ...w7.outliers);

      // A run where the host only returned stubs must never blank out a good
      // price. Carry the previous entry forward and mark it stale instead.
      if (!w7.cleanCount && !w24.cleanCount) {
        const previous = previousPrices[key];
        if (hasUsablePrice(previous)) {
          carriedForward++;
          out.prices[key] = {
            ...previous,
            stale: true,
            staleSince: previous.staleSince ?? out.updated
          };
          market.items[key] = {
            id,
            label: item.label ?? key,
            divisor: item.divisor ?? null,
            stale: true,
            staleSince: previous.staleSince ?? out.updated,
            storedTrades: record.count,
            newTrades: added,
            acceptedPages: fetched.acceptedPages,
            rejectedPages: fetched.rejectedPages,
            note: "no usable trades this run; previous values carried forward"
          };
          console.log(`no usable data — kept previous price (stale), ${fetched.rejectedPages} pages rejected`);
          continue;
        }
      }

      // Unchanged shape — the calculator and fetcher.html depend on these keys.
      out.prices[key] = {
        id,
        avg24h: w24.avg,
        mean24h: w24.mean,
        median24h: w24.median,
        sampleCountLast24h: w24.count,
        cleanSampleCount24h: w24.cleanCount,
        outliersRemoved24h: w24.outliersRemoved,
        min24h: w24.min,
        max24h: w24.max,
        avg7d: w7.avg,
        mean7d: w7.mean,
        median7d: w7.median,
        sampleCountLast7d: w7.count,
        cleanSampleCount7d: w7.cleanCount,
        outliersRemoved7d: w7.outliersRemoved,
        min7d: w7.min,
        max7d: w7.max,
        totalUnits7d: w7.totalUnits
      };

      market.items[key] = {
        id,
        label: item.label ?? key,
        divisor: item.divisor ?? null,
        reportedTotal: fetched.reportedTotal || knownTotals[key] || null,
        storedTrades: record.count,
        newTrades: added,
        acceptedPages: fetched.acceptedPages,
        rejectedPages: fetched.rejectedPages,
        windows: {
          "24h": { avg: w24.avg, median: w24.median, p25: w24.p25, p75: w24.p75, min: w24.min, max: w24.max, count: w24.count, clean: w24.cleanCount, units: w24.totalUnits },
          "7d": { avg: w7.avg, median: w7.median, p25: w7.p25, p75: w7.p75, min: w7.min, max: w7.max, count: w7.count, clean: w7.cleanCount, units: w7.totalUnits }
        },
        quality: { spread: tiers.spread, tiers: tiers.tiers }
      };

      console.log(
        `${record.count} stored (+${added} new), ${fetched.acceptedPages} pages ok` +
          (fetched.rejectedPages ? `, ${fetched.rejectedPages} rejected` : "")
      );
    } catch (err) {
      if (err instanceof BannedError) {
        console.error(`\n${err.message}`);
        banned = true;
        break;
      }
      console.log(`failed: ${err.message}`);
      const previous = previousPrices[key];
      if (hasUsablePrice(previous)) {
        carriedForward++;
        out.prices[key] = { ...previous, stale: true, staleSince: previous.staleSince ?? out.updated, lastError: String(err) };
      } else {
        out.prices[key] = { id, error: String(err) };
      }
      market.items[key] = { id, error: String(err), stale: hasUsablePrice(previous) };
    }
  }

  if (hostDegraded) {
    console.warn(
      `
Stopped early: ${breaker.consecutive} consecutive items returned nothing but synthetic pages, ` +
        `so the host is refusing this client or is degraded. Remaining items keep their previous prices.`
    );
  }

  // A ban or a degraded host breaks the loop early. Anything not reached keeps
  // its previous values rather than vanishing from the feed.
  for (const item of items) {
    if (out.prices[item.key]) continue;
    const previous = previousPrices[item.key];
    if (hasUsablePrice(previous)) {
      carriedForward++;
      out.prices[item.key] = { ...previous, stale: true, staleSince: previous.staleSince ?? out.updated };
      market.items[item.key] = { id: item.id, label: item.label ?? item.key, stale: true, note: "run aborted before this item" };
    }
  }

  market.source = {
    host: "stalcraftdb.net",
    requests: source.stats.requests,
    stubsRejected: source.stats.stubs,
    rateLimitHits: source.stats.rateLimited,
    carriedForward,
    hostDegraded,
    banned
  };
  out.stale = carriedForward;

  await fs.writeFile(OUTPUT_JSON, JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote", OUTPUT_JSON);
  await fs.writeFile(MARKET_JSON, JSON.stringify(market, null, 2), "utf8");
  console.log("Wrote", MARKET_JSON);
  await fs.writeFile(OUTLIERS_JSON, JSON.stringify(allOutliers, null, 2), "utf8");
  console.log(`Wrote ${OUTLIERS_JSON} with ${allOutliers.outliers.length} outliers detected`);

  const header = [
    "key", "id",
    "avg24h", "mean24h", "median24h", "sampleCountLast24h", "cleanSampleCount24h", "outliersRemoved24h", "min24h", "max24h",
    "avg7d", "mean7d", "median7d", "sampleCountLast7d", "cleanSampleCount7d", "outliersRemoved7d", "min7d", "max7d", "totalUnits7d"
  ];
  const rows = [header];
  for (const [k, v] of Object.entries(out.prices)) {
    rows.push([k, v.id ?? "", ...header.slice(2).map((h) => v[h] ?? "")].map(csvEscapeCell));
  }
  await fs.writeFile(OUTPUT_CSV, rows.map((r) => r.join(",")).join("\n"), "utf8");
  console.log("Wrote", OUTPUT_CSV);

  console.log(
    `\n${source.stats.requests} requests, ${source.stats.stubs} synthetic responses rejected, ` +
      `${source.stats.rateLimited} rate-limit hits, ${carriedForward} items kept at their previous price.`
  );

  // Surface a ban as a workflow failure so it is not silently ignored — but only
  // after the outputs above are written, so a partial run is still committed.
  if (banned) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
