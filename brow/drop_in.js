// drop_in.js
// Pure ESM, browser-ready
// Provides getItemStats(id) -> { 24h, 7d }

import { fetchItemHistory } from "./fetch_item.js";
import { computeWindowStats } from "./compute_stats.js";

export async function getItemStats(id, region = "na") {
  const trades = await fetchItemHistory(id, { region });
  const stats24h = computeWindowStats(trades, 1, { key: id });
  const stats7d = computeWindowStats(trades, 7, { key: id });
  return { id, stats24h, stats7d };
}
