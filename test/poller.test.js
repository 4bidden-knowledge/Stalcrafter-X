// node --test test/poller.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { inspectPayload } from "../lib/source.js";
import { computeWindowStats, qualityTiers, normalise, detectOutliers } from "../lib/stats.js";

const HOUR = 3_600_000;
const now = Date.now();

/** Real shape: sorted newest first, lot detail present. */
const realPayload = (count = 200, total = 6306) => ({
  total,
  prices: Array.from({ length: count }, (_, i) => ({
    amount: 1,
    price: 80_000 + i,
    time: new Date(now - i * HOUR).toISOString(),
    additional: { qlt: 0, upgrade_bonus: 0 }
  }))
});

/* ------------------------------------------------ response validation */

test("real history is accepted", () => {
  assert.equal(inspectPayload(realPayload()).ok, true);
});

test("the synthetic stub is rejected — shuffled timestamps", () => {
  const stub = {
    total: 5,
    prices: [40, 3, 61, 12, 55].map((h) => ({
      amount: 1,
      price: 500_000,
      time: new Date(now - h * HOUR).toISOString(),
      additional: {}
    }))
  };
  const verdict = inspectPayload(stub);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /descending/);
});

test("a sorted but detail-free tiny payload is rejected", () => {
  const payload = {
    total: 6,
    prices: Array.from({ length: 6 }, (_, i) => ({
      amount: 1,
      price: 1000,
      time: new Date(now - i * HOUR).toISOString(),
      additional: {}
    }))
  };
  assert.equal(inspectPayload(payload).ok, false);
});

test("a collapsed total is rejected against a known total", () => {
  const verdict = inspectPayload(realPayload(9, 9), { knownTotal: 6306 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /collapsed/);
});

test("an item with genuinely no trades is not treated as fake", () => {
  const verdict = inspectPayload({ total: 0, prices: [] });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.empty, true);
});

/* -------------------------------------------------------- statistics */

test("unit price divides the lot total by amount", () => {
  const trades = normalise([{ amount: 5, price: 10_000, time: new Date(now).toISOString() }]);
  assert.equal(trades[0].unitPrice, 2000);
});

test("the weighted average weights by quantity, not by trade count", () => {
  const stats = computeWindowStats(
    [
      { amount: 100, price: 100 * 10, time: new Date(now).toISOString() },
      { amount: 1, price: 1000, time: new Date(now).toISOString() }
    ],
    1
  );
  // Straight mean of unit prices is 505; volume weighted is ~19.8.
  assert.ok(stats.avg < 25, `avg was ${stats.avg}`);
  assert.equal(stats.mean, 505);
});

test("MAD removes a wild outlier but leaves clean data alone", () => {
  const clean = Array.from({ length: 30 }, () => 10_000);
  assert.equal(detectOutliers(clean).filter(Boolean).length, 0);

  const withSpike = [...Array.from({ length: 30 }, (_, i) => 10_000 + (i % 3) * 50), 5_000_000];
  const flags = detectOutliers(withSpike);
  assert.equal(flags[flags.length - 1], true);
  assert.equal(flags.slice(0, -1).filter(Boolean).length, 0);
});

test("outlier detection stands down below the minimum sample size", () => {
  assert.equal(detectOutliers([1, 999_999]).filter(Boolean).length, 0);
});

test("trades outside the window are excluded", () => {
  const trades = [
    { amount: 1, price: 100, time: new Date(now - 2 * HOUR).toISOString() },
    { amount: 1, price: 100, time: new Date(now - 60 * HOUR).toISOString() }
  ];
  assert.equal(computeWindowStats(trades, 1).count, 1);
  assert.equal(computeWindowStats(trades, 7).count, 2);
});

/* ----------------------------------------------------- quality tiers */

test("tiers are separated and the spread is measured", () => {
  const medians = { 0: 10_000, 1: 15_000, 2: 40_000, 3: 90_000 };
  const prices = [];
  let i = 0;
  for (const [qlt, median] of Object.entries(medians)) {
    for (let n = 0; n < 15; n++) {
      prices.push({
        amount: 1,
        price: Math.round(median * (1 + 0.05 * Math.sin(n))),
        time: new Date(now - i++ * HOUR).toISOString(),
        additional: { qlt: Number(qlt) }
      });
    }
  }
  const { tiers, spread } = qualityTiers(prices, { windowDays: 7 });
  assert.equal(tiers.length, 4);
  assert.deepEqual(tiers.map((t) => t.quality), [0, 1, 2, 3]);
  assert.ok(spread > 8, `spread was ${spread}`);
});

test("commodity items with a single tier report no spread", () => {
  const prices = Array.from({ length: 20 }, (_, i) => ({
    amount: 1,
    price: 10_000,
    time: new Date(now - i * HOUR).toISOString(),
    additional: { qlt: 0 }
  }));
  assert.equal(qualityTiers(prices, { windowDays: 7 }).spread, null);
});

/* ------------------------------------------------------------- store */

test("history merge dedupes and keeps the quality tier", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sx-store-"));
  process.env.HISTORY_DIR = dir;
  const { mergeHistory } = await import(`../lib/store.js?t=${Date.now()}`);

  const batch = [
    { time: new Date(now).toISOString(), price: 5000, amount: 1, additional: { qlt: 3 } },
    { time: new Date(now - HOUR).toISOString(), price: 6000, amount: 2 }
  ];

  const first = await mergeHistory("na", "test", batch);
  assert.equal(first.added, 2);

  // Same batch again plus one new entry.
  const second = await mergeHistory("na", "test", [
    ...batch,
    { time: new Date(now - 2 * HOUR).toISOString(), price: 7000, amount: 1 }
  ]);
  assert.equal(second.added, 1, "duplicates must not be re-added");
  assert.equal(second.record.count, 3);

  const stored = second.record.trades.find((t) => t.price === 5000);
  assert.deepEqual(stored.additional, { qlt: 3 }, "additional must survive the round trip");

  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.HISTORY_DIR;
});
