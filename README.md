# Stalcrafter-X

A price backend for Stalcraft crafting. A GitHub Action polls stalcraftdb's
auction history twice a day, merges each run into a committed per-item archive,
and publishes a validated price feed as static JSON — so the crafting calculator
has no backend to keep running.

## Why it's more than a fetch loop

Two things about the upstream host make the naive version produce quietly wrong
numbers.

**It serves fake data at random.** The same URL returns either real history —
hundreds of trades, sorted newest first, `additional` populated — or a small
synthetic stub with shuffled timestamps and no detail. Pooling a stub into the
averages corrupts them without any visible error, so `lib/source.js` validates
every page before accepting it and retries a page a few times on the assumption
that a stub is bad luck rather than a permanent state.

**It bans clients that push too hard.** The host publishes a 30-requests-per-60s
budget in `X-Ratelimit-*` headers, treats 429 as a 60-second cooldown, and 420 as
a temporary ban. The client paces at 15 req/min, reads the headers, pauses when
the remaining count hits a floor, and aborts the entire run on a 420 instead of
continuing to hammer a host that has already said no.

## Outlier removal

Auction data is full of fat-finger listings and single-unit trades at absurd
prices. `lib/stats.js` uses a **modified z-score built on median absolute
deviation** — a sample is rejected when `|0.6745·(x − median)| / MAD > 2.5`.

MAD is used over a fixed percentile trim because it adapts: it removes nothing
when the data is clean and a lot when it isn't, where trimming always discards
the same fraction whether or not there's anything wrong. Rejected trades are
written to `outliers.json` rather than dropped silently, so the filter can be
audited instead of trusted.

Items with fewer than 5 samples skip filtering entirely — quartiles and
deviations are meaningless at that size and you'd throw away real data.

## History accumulation

One poll only reaches as far back as the host will paginate. `lib/store.js`
merges every run into `history/<region>/<id>.json`, deduplicating on
`time|price|amount`, so coverage deepens over time rather than resetting twice a
day. Entries older than 90 days are pruned to keep the repo bounded — far beyond
any window actually reported on.

A run that fails falls back to the previously published feed instead of
overwriting good data with nulls.

## Outputs

| File | |
|---|---|
| `prices.json` / `prices.csv` | Weighted 24h & 7d per-unit averages — schema is frozen, the calculator reads these |
| `market.json` | Richer feed: windows, quality tiers, provenance |
| `outliers.json` | Audit trail of every MAD-rejected trade |
| `history/` | Accumulated raw trades per item |

## Running it

Node 18+, no dependencies.

```bash
npm start        # one poll cycle
npm test         # node --test test/poller.test.js
```

Everything is configured by environment variable — `REGION`, `MAX_PAGES`,
`REQUESTS_PER_MINUTE`, `REMAINING_FLOOR`, `STUB_RETRIES`, `HTTP_RETRIES`,
`OUTLIER_MAD_THRESHOLD`, `RETENTION_DAYS`.

`server.js` is a local dev helper that serves the pages and proxies past CORS. It
needs your own API token and is gitignored — it is not part of the deployed site.

## Layout

| | |
|---|---|
| `fetch_and_compute.js` | Run orchestration |
| `lib/source.js` | Rate-limited, stub-validating API client |
| `lib/stats.js` | MAD outlier rejection, weighted windows, quality tiers |
| `lib/store.js` | Per-item history merge and retention |
| `brow/` | Browser-side fetch and stats helpers |
| `.github/workflows/poller.yml` | 12-hour schedule |

## License

MIT
