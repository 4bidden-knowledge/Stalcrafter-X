# Stalcrafter-X

Tracks Stalcraft auction-house prices and works out which crafting recipes are
actually worth doing. A GitHub Action re-polls the market every 12 hours and
commits the recomputed prices back to the repo, so the site is served from static
JSON with no backend to keep alive.

## The interesting part: the prices are noisy

Auction data is full of garbage — fat-finger listings, single-unit trades at
absurd prices, and stale entries. Taking a naive mean gives you a number that
says a recipe is wildly profitable when it isn't.

So `fetch_and_compute.js` does a few things:

- **IQR outlier rejection.** Per item, it computes the interquartile range and
  drops samples outside `Q1 - 1.5·IQR` / `Q3 + 1.5·IQR`, but only once there are
  at least 5 samples — below that the quartiles are meaningless and you'd throw
  away real data. Rejected samples are written to `outliers.json` rather than
  discarded silently, so the filter itself can be checked.
- **Volume weighting** across 24-hour and 7-day windows, so a 400-unit sale
  counts more than a 1-unit sale.
- **Timestamp normalization**, because the API returns times as ISO strings,
  second-precision epochs, and millisecond-precision epochs depending on the
  endpoint.
- **Untradeable caching.** Items with no valid market data get recorded in
  `untradeable_ids.json` and skipped on later runs, which cuts the poll short by
  a large fraction.

Writes are atomic in the sense that an item only lands in `prices.json` if it
came out with valid pricing — a failed fetch leaves the previous value alone
instead of writing a null over it.

## Rate limiting

The upstream API allows 60 requests/minute. The poller sleeps 1 s between pages
and 1 s between items, tunable via `PER_PAGE_DELAY_MS` and `BETWEEN_ITEMS_MS`.
It's deliberately slower than it needs to be.

## Running it

```bash
npm install
node fetch_and_compute.js
```

Configuration is all environment variables:

| Var | Default | |
|---|---|---|
| `REGION` | `na` | Server region |
| `MAX_PAGES` | `10` | Pages of auction history per item |
| `PER_PAGE_DELAY_MS` | `1000` | Delay between pages |
| `BETWEEN_ITEMS_MS` | `1000` | Delay between items |
| `OUTLIER_IQR_MULTIPLIER` | `1.5` | IQR fence width |
| `MIN_SAMPLES_FOR_OUTLIER_DETECTION` | `5` | Below this, no filtering |

`server.js` is a local dev helper that serves the static pages and proxies API
calls past CORS. It needs your own API token and is gitignored — it isn't part of
the deployed site.

## Layout

| | |
|---|---|
| `fetch_and_compute.js` | Poller, outlier filtering, price computation |
| `extract_recipes.js` | Builds `recipes.json` from game data |
| `brow/` | Browser-side fetch and stats helpers |
| `crafting.html` / `prices.html` / `lots.html` | The front end |
| `.github/workflows/poller.yml` | 12-hour schedule |

## License

MIT
