// fetch_item.js
// ESM, Node 18+ (no npm deps)
// Fetches raw auction history for a given item ID.

function parseTimestampToMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
  return NaN;
}

const headersBase = {
  "User-Agent": "Mozilla/5.0 (compatible; StalcraftFetcher/1.0)",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.5",
  "Connection": "keep-alive"
};

export async function fetchItemHistory(id, { region = "na", maxPages = 5 } = {}) {
  const cutoff7 = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let allPrices = [];

  for (let page = 0; page < maxPages; page++) {
    const url = `https://stalcraftdb.net/api/items/${id}/auction-history?region=${region}&page=${page}`;
    const headers = { ...headersBase, "Referer": `https://stalcraftdb.net/${region}/${id}` };

    let resp;
    try {
      resp = await fetch(url, { method: "GET", headers });
    } catch (err) {
      throw new Error(`Network error for ${url}: ${err?.message || err}`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      throw new Error(`Invalid JSON from ${url}: ${err?.message || err}`);
    }

    const prices = Array.isArray(data.prices) ? data.prices : (Array.isArray(data) ? data : []);
    if (!prices.length) break;

    allPrices.push(...prices);

    const last = prices[prices.length - 1];
    const lastTs = parseTimestampToMs(last?.time);
    if (!Number.isNaN(lastTs) && lastTs < cutoff7) break;
  }

  return allPrices;
}
