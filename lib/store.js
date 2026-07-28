// lib/store.js
// Accumulates raw trades across runs.
//
// One poll only reaches back as far as the host will paginate, and it runs twice
// a day. Merging each run into a committed per-item file means coverage deepens
// over time instead of resetting, which is what makes this repo usable as a
// price backend rather than just a snapshot.

import fs from "fs/promises";
import path from "path";

const HISTORY_DIR = process.env.HISTORY_DIR || "history";
// Keep the repo from growing without bound. 90 days is far more than any of the
// windows we report on.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);

const keyOf = (entry) => `${entry.time}|${entry.price}|${entry.amount}`;

function fileFor(region, id) {
  return path.join(HISTORY_DIR, region, `${id}.json`);
}

export async function loadHistory(region, id) {
  try {
    const text = await fs.readFile(fileFor(region, id), "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.trades) ? parsed : { region, id, trades: [] };
  } catch (err) {
    if (err.code === "ENOENT") return { region, id, trades: [] };
    throw err;
  }
}

/**
 * Union of stored and freshly fetched trades, newest first, pruned to the
 * retention window. Returns the merged set plus how many entries were new.
 */
export async function mergeHistory(region, id, fetched) {
  const stored = await loadHistory(region, id);
  const seen = new Map(stored.trades.map((t) => [keyOf(t), t]));
  let added = 0;

  for (const entry of fetched ?? []) {
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    const record = { time: entry.time, price: entry.price, amount: entry.amount };
    // `additional` carries the quality tier — dropping it would flatten tiers.
    if (entry.additional && Object.keys(entry.additional).length) record.additional = entry.additional;
    seen.set(key, record);
    added++;
  }

  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const trades = [...seen.values()]
    .filter((t) => {
      const ts = Date.parse(t.time);
      return !Number.isFinite(ts) || ts >= cutoff;
    })
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

  const record = { region, id, updated: new Date().toISOString(), count: trades.length, trades };
  await fs.mkdir(path.join(HISTORY_DIR, region), { recursive: true });
  await fs.writeFile(fileFor(region, id), JSON.stringify(record), "utf8");

  return { record, added, kept: trades.length };
}
