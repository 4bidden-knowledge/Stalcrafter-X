// lib/source.js
// Rate-limited, validating client for the stalcraftdb auction-history endpoint.
//
// Two hazards this exists to handle:
//
//   1. The host publishes a budget in X-Ratelimit-* headers (30 requests per 60
//      seconds). Its own web client treats 429 as a 60-second cooldown and 420 as
//      a temporary ban. Blowing through either gets this poller blocked, so we
//      pace under the budget, read the headers, and abort the whole run on a 420
//      rather than continuing to hammer.
//
//   2. The same URL returns either real history (hundreds of trades, sorted
//      newest first, `additional` populated) or a small synthetic stub with
//      shuffled timestamps and no detail — apparently at random. Pooling a stub
//      into the averages silently corrupts them, so every page is validated
//      before it is accepted.

const BASE = "https://stalcraftdb.net";
const USER_AGENT =
  process.env.USER_AGENT ||
  "Stalcrafter-X poller (+https://github.com/4bidden-knowledge/Stalcrafter-X)";

// Stay well under the published 30/60s budget.
const REQUESTS_PER_MINUTE = Number(process.env.REQUESTS_PER_MINUTE || 15);
const MIN_INTERVAL_MS = 60_000 / REQUESTS_PER_MINUTE;
// Pause for the reset window when the server says this few requests remain.
const REMAINING_FLOOR = Number(process.env.REMAINING_FLOOR || 6);
// A stub is bad luck rather than a permanent state, so retry a page a few times.
const STUB_RETRIES = Number(process.env.STUB_RETRIES || 3);
const HTTP_RETRIES = Number(process.env.HTTP_RETRIES || 3);

export class BannedError extends Error {
  constructor() {
    super(
      "stalcraftdb.net returned HTTP 420 (temporarily banned). Aborting the run. " +
        "Lower REQUESTS_PER_MINUTE before trying again."
    );
    this.name = "BannedError";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is this payload real auction history, or the synthetic stub?
 *
 * The endpoint's contract is that prices come back sorted newest first, so an
 * unsorted response is definitively fabricated. A tiny result with no lot detail
 * on any entry is the secondary signal, and a total that has collapsed against
 * what we saw for the same item previously is the third.
 */
export function inspectPayload(payload, { knownTotal = null } = {}) {
  const prices = Array.isArray(payload?.prices) ? payload.prices : [];
  const total = Number(payload?.total) || 0;

  if (!prices.length) return { ok: true, empty: true, reason: "no trades in this page" };

  const times = prices.map((p) => Date.parse(p.time));
  if (times.some((t) => !Number.isFinite(t))) {
    return { ok: false, reason: "unparseable timestamps" };
  }
  if (!times.every((t, i) => i === 0 || times[i - 1] >= t)) {
    return { ok: false, reason: "timestamps not in descending order" };
  }
  if (knownTotal && total < knownTotal * 0.25 && total < 100) {
    return { ok: false, reason: `total collapsed from ${knownTotal} to ${total}` };
  }
  const anyDetail = prices.some((p) => p.additional && Object.keys(p.additional).length > 0);
  if (!anyDetail && total < 50) {
    return { ok: false, reason: `no lot detail on any of ${total} entries` };
  }
  return { ok: true, empty: false };
}

export class Source {
  constructor({ region = "na" } = {}) {
    this.region = region;
    this.lastRequestAt = 0;
    this.remaining = null;
    this.reset = null;
    this.banned = false;
    this.stats = { requests: 0, stubs: 0, rateLimited: 0, retries: 0 };
  }

  async #throttle() {
    const gap = Date.now() - this.lastRequestAt;
    if (gap < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - gap);
    if (this.remaining !== null && this.remaining <= REMAINING_FLOOR) {
      const waitMs = ((this.reset ?? 60) + 1) * 1000;
      console.log(`  budget nearly spent (${this.remaining} left), waiting ${Math.round(waitMs / 1000)}s`);
      this.remaining = null;
      await sleep(waitMs);
    }
  }

  /** One HTTP GET with throttling, 429 backoff and 420 abort. */
  async #get(url) {
    if (this.banned) throw new BannedError();

    for (let attempt = 1; attempt <= HTTP_RETRIES; attempt++) {
      await this.#throttle();

      let resp;
      try {
        resp = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(25_000)
        });
      } catch (err) {
        if (attempt === HTTP_RETRIES) throw new Error(`Network error for ${url}: ${err?.message || err}`);
        await sleep(1000 * attempt);
        continue;
      }

      this.lastRequestAt = Date.now();
      this.stats.requests++;

      const remaining = Number(resp.headers.get("x-ratelimit-remaining"));
      const reset = Number(resp.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(remaining)) this.remaining = remaining;
      if (Number.isFinite(reset)) this.reset = reset;

      if (resp.status === 420) {
        this.banned = true;
        throw new BannedError();
      }

      if (resp.status === 429) {
        this.stats.rateLimited++;
        const waitSeconds = Math.max(Number.isFinite(reset) ? reset : 60, 60);
        console.warn(`  rate limited, waiting ${waitSeconds}s before retrying`);
        if (attempt === HTTP_RETRIES) throw new Error(`Rate limited repeatedly on ${url}`);
        await sleep((waitSeconds + 1) * 1000);
        continue;
      }

      if (!resp.ok) {
        if (resp.status < 500 || attempt === HTTP_RETRIES) throw new Error(`HTTP ${resp.status} for ${url}`);
        await sleep(700 * 2 ** (attempt - 1));
        continue;
      }

      try {
        return await resp.json();
      } catch (err) {
        throw new Error(`Invalid JSON from ${url}: ${err?.message || err}`);
      }
    }
    throw new Error(`Gave up on ${url}`);
  }

  /** Fetch one page, retrying while the host answers with a synthetic stub. */
  async #page(id, page, knownTotal) {
    let lastReason = null;
    for (let attempt = 1; attempt <= STUB_RETRIES; attempt++) {
      const payload = await this.#get(
        `${BASE}/api/items/${id}/auction-history?region=${this.region}&page=${page}`
      );
      const verdict = inspectPayload(payload, { knownTotal });
      if (verdict.ok) {
        if (attempt > 1) this.stats.retries += attempt - 1;
        return { ...payload, accepted: true, empty: verdict.empty };
      }
      this.stats.stubs++;
      lastReason = verdict.reason;
    }
    return { total: 0, prices: [], accepted: false, reason: lastReason };
  }

  /**
   * Walk history pages newest-first until `windowDays` is covered or `maxPages`
   * is reached. Rejected pages do not stop the walk — the next page may be fine —
   * but they contribute nothing.
   */
  async fetchHistory(id, { maxPages = 10, windowDays = 7, knownTotal = null } = {}) {
    const cutoff = Date.now() - windowDays * 86_400_000;
    const collected = [];
    let reportedTotal = 0;
    let acceptedPages = 0;
    let rejectedPages = 0;

    for (let page = 0; page < maxPages; page++) {
      const result = await this.#page(id, page, knownTotal);

      if (!result.accepted) {
        rejectedPages++;
        // Page 0 being fabricated says nothing about page 1, but several in a row
        // means the host is in a bad phase — stop rather than burn the budget.
        if (rejectedPages >= 2) break;
        continue;
      }

      acceptedPages++;
      reportedTotal = Math.max(reportedTotal, Number(result.total) || 0);
      const prices = result.prices ?? [];
      if (!prices.length) break;

      collected.push(...prices);

      const oldest = Date.parse(prices[prices.length - 1]?.time);
      if (Number.isFinite(oldest) && oldest < cutoff) break;
    }

    return { prices: collected, reportedTotal, acceptedPages, rejectedPages };
  }
}
