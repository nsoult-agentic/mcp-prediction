import { describe, test, expect } from "bun:test";

import {
  computeMedian,
  computeForecast,
  computeKellySizing,
  computeBrierScore,
  computeWinStats,
  createRateLimiter,
  MIN_EDGE,
  MAX_POSITION_FRACTION,
  DEFAULT_KELLY_FRACTION,
} from "../src/forecast.js";

// Expected values below are derived BY HAND from the formulas/constants in
// src/forecast.ts, not by running the implementation, so a logic regression is
// caught rather than mirrored.

describe("computeMedian", () => {
  test("odd count returns the middle of the sorted values", () => {
    // sorted [0.2, 0.4, 0.6] → middle = 0.4
    expect(computeMedian([0.2, 0.6, 0.4])).toBe(0.4);
  });

  test("even count averages the two middle sorted values", () => {
    // sorted [0.1, 0.3, 0.5, 0.9] → (0.3 + 0.5) / 2 = 0.4
    expect(computeMedian([0.9, 0.1, 0.5, 0.3])).toBe(0.4);
  });

  test("single estimate is its own median", () => {
    expect(computeMedian([0.42])).toBe(0.42);
  });

  test("does not mutate the input array", () => {
    const input = [0.9, 0.1, 0.5];
    const copy = [...input];
    computeMedian(input);
    expect(input).toEqual(copy);
  });

  test("empty input is NaN", () => {
    expect(computeMedian([])).toBeNaN();
  });
});

describe("computeForecast", () => {
  test("positive edge → YES, tradeable when |edge| ≥ 5pp", () => {
    // median 0.7, price 0.6 → edge +0.10
    const f = computeForecast([0.7], 0.6);
    expect(f.median).toBe(0.7);
    expect(f.edge).toBeCloseTo(0.1, 10);
    expect(f.absEdge).toBeCloseTo(0.1, 10);
    expect(f.direction).toBe("YES");
    expect(f.tradeable).toBe(true);
  });

  test("negative edge → NO direction", () => {
    // median 0.4, price 0.6 → edge -0.20
    const f = computeForecast([0.4], 0.6);
    expect(f.edge).toBeCloseTo(-0.2, 10);
    expect(f.absEdge).toBeCloseTo(0.2, 10);
    expect(f.direction).toBe("NO");
    expect(f.tradeable).toBe(true);
  });

  test("edge exactly at the 5pp threshold is tradeable (≥)", () => {
    // median 0.65, price 0.60 → edge 0.05 == MIN_EDGE
    const f = computeForecast([0.65], 0.6);
    expect(f.absEdge).toBeCloseTo(MIN_EDGE, 10);
    expect(f.tradeable).toBe(true);
  });

  test("edge just below threshold is not tradeable", () => {
    // median 0.64, price 0.60 → edge 0.04 < MIN_EDGE
    const f = computeForecast([0.64], 0.6);
    expect(f.tradeable).toBe(false);
  });

  test("zero edge is treated as NO (no positive edge)", () => {
    const f = computeForecast([0.5], 0.5);
    expect(f.edge).toBe(0);
    expect(f.direction).toBe("NO");
    expect(f.tradeable).toBe(false);
  });

  test("uses the ensemble median, not the mean", () => {
    // estimates [0.1, 0.2, 0.9]: median 0.2 (mean would be 0.4)
    const f = computeForecast([0.1, 0.2, 0.9], 0.2);
    expect(f.median).toBe(0.2);
    expect(f.edge).toBe(0);
  });
});

describe("computeKellySizing", () => {
  test("YES at even-money price, quarter-Kelly, under the 5% cap", () => {
    // price 0.5, odds=(1-0.5)/0.5=1, kellyFull=0.1/1=0.1,
    // adjusted=0.1*0.25=0.025, raw=0.025*5000=125 < cap 250 → 125,
    // contracts=125/0.5=250
    const k = computeKellySizing("YES", 0.5, 0.1, 5_000, 0.25);
    expect(k.price).toBe(0.5);
    expect(k.odds).toBe(1);
    expect(k.kellyFull).toBeCloseTo(0.1, 10);
    expect(k.kellyAdjusted).toBeCloseTo(0.025, 10);
    expect(k.positionSize).toBeCloseTo(125, 6);
    expect(k.contracts).toBeCloseTo(250, 6);
  });

  test("large edge is clamped to the 5% portfolio cap", () => {
    // price 0.5, odds 1, kellyFull=0.5, adjusted=0.125, raw=625 > cap 250
    // → positionSize=250 (5% of 5000), contracts=250/0.5=500
    const k = computeKellySizing("YES", 0.5, 0.5, 5_000, 0.25);
    expect(k.positionSize).toBe(5_000 * MAX_POSITION_FRACTION);
    expect(k.positionSize).toBe(250);
    expect(k.contracts).toBe(500);
  });

  test("NO side prices at (1 - marketPrice) and adjusts odds", () => {
    // marketPrice 0.8 → NO price 0.2, odds=(1-0.2)/0.2=4,
    // kellyFull=0.1/4=0.025, adjusted=0.00625, raw=0.00625*5000=31.25 < cap,
    // contracts=31.25/0.2=156.25
    const k = computeKellySizing("NO", 0.8, 0.1, 5_000, 0.25);
    expect(k.price).toBeCloseTo(0.2, 10);
    expect(k.odds).toBeCloseTo(4, 10);
    expect(k.kellyFull).toBeCloseTo(0.025, 10);
    expect(k.positionSize).toBeCloseTo(31.25, 6);
    expect(k.contracts).toBeCloseTo(156.25, 6);
  });

  test("default kelly fraction is quarter-Kelly", () => {
    const explicit = computeKellySizing("YES", 0.5, 0.1, 5_000, DEFAULT_KELLY_FRACTION);
    const defaulted = computeKellySizing("YES", 0.5, 0.1, 5_000);
    expect(DEFAULT_KELLY_FRACTION).toBe(0.25);
    expect(defaulted.positionSize).toBe(explicit.positionSize);
  });

  test("full Kelly (fraction=1) is 4x the quarter-Kelly fraction", () => {
    // kellyAdjusted scales linearly with the fraction (it is the pre-cap term):
    // quarter: kellyFull=0.1/1=0.1, adj=0.1*0.25=0.025
    // full:    adj=0.1*1   =0.1   → exactly 4x the quarter fraction
    const quarter = computeKellySizing("YES", 0.5, 0.1, 100, 0.25);
    const full = computeKellySizing("YES", 0.5, 0.1, 100, 1);
    expect(quarter.kellyFull).toBeCloseTo(0.1, 10);
    expect(full.kellyFull).toBeCloseTo(0.1, 10);
    expect(quarter.kellyAdjusted).toBeCloseTo(0.025, 10);
    expect(full.kellyAdjusted).toBeCloseTo(0.1, 10);
    expect(full.kellyAdjusted / quarter.kellyAdjusted).toBeCloseTo(4, 6);
    // positionSize, by contrast, is capped at 5% of portfolio (=5 here) for
    // BOTH, since 0.1>0.05: quarter raw=0.025*100=2.5 (<cap), full raw=10 (>cap→5)
    expect(quarter.positionSize).toBeCloseTo(2.5, 6); // under the cap
    expect(full.positionSize).toBe(100 * MAX_POSITION_FRACTION); // 5, clamped
  });

  test("position size never exceeds the 5% cap (invariant)", () => {
    for (const edge of [0.05, 0.2, 0.5, 0.95]) {
      for (const price of [0.1, 0.5, 0.9]) {
        const k = computeKellySizing("YES", price, edge, 5_000, 1);
        expect(k.positionSize).toBeLessThanOrEqual(5_000 * MAX_POSITION_FRACTION + 1e-9);
      }
    }
  });
});

describe("computeBrierScore", () => {
  test("mean squared error of predicted prob vs actual outcome", () => {
    // r1: outcome 1, median 0.8 → prob 0.8 → (1-0.8)^2 = 0.04
    // r2: outcome 0, median 0.3 → prob 0.7 → (1-0.7)^2 = 0.09
    // mean = (0.04 + 0.09) / 2 = 0.065
    const score = computeBrierScore([
      { median_estimate: 0.8, outcome: 1 },
      { median_estimate: 0.3, outcome: 0 },
    ]);
    expect(score).toBeCloseTo(0.065, 10);
  });

  test("a perfect forecaster scores 0", () => {
    const score = computeBrierScore([
      { median_estimate: 1, outcome: 1 },
      { median_estimate: 0, outcome: 0 },
    ]);
    expect(score).toBe(0);
  });

  test("the worst possible forecaster scores 1", () => {
    const score = computeBrierScore([
      { median_estimate: 0, outcome: 1 },
      { median_estimate: 1, outcome: 0 },
    ]);
    expect(score).toBe(1);
  });

  test("a 50/50 forecast always scores 0.25", () => {
    // prob 0.5 regardless of outcome → (1-0.5)^2 = 0.25
    expect(
      computeBrierScore([
        { median_estimate: 0.5, outcome: 1 },
        { median_estimate: 0.5, outcome: 0 },
      ]),
    ).toBe(0.25);
  });

  test("empty input returns 0", () => {
    expect(computeBrierScore([])).toBe(0);
  });

  test("score stays within [0, 1] (invariant)", () => {
    for (const median of [0, 0.25, 0.5, 0.75, 1]) {
      for (const outcome of [0, 1] as const) {
        const s = computeBrierScore([{ median_estimate: median, outcome }]);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("computeWinStats", () => {
  test("tallies wins, losses, total P&L and win rate", () => {
    const s = computeWinStats([{ pnl: 10 }, { pnl: -5 }, { pnl: 3 }, { pnl: -2 }]);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.totalPnl).toBeCloseTo(6, 10); // 10 - 5 + 3 - 2
    expect(s.winRate).toBe(0.5);
  });

  test("zero P&L counts as a loss (not a win)", () => {
    const s = computeWinStats([{ pnl: 0 }, { pnl: 1 }]);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
  });

  test("empty input → zero win rate, no division by zero", () => {
    const s = computeWinStats([]);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.totalPnl).toBe(0);
    expect(s.winRate).toBe(0);
  });

  test("wins + losses always equals the row count (invariant)", () => {
    const rows = [{ pnl: 5 }, { pnl: 0 }, { pnl: -1 }, { pnl: 9 }];
    const s = computeWinStats(rows);
    expect(s.wins + s.losses).toBe(rows.length);
  });
});

describe("createRateLimiter", () => {
  test("allows up to the limit, then blocks within the window", () => {
    const now = 1_000;
    const limited = createRateLimiter(3, 60_000, () => now);
    expect(limited()).toBe(false); // 1st
    expect(limited()).toBe(false); // 2nd
    expect(limited()).toBe(false); // 3rd
    expect(limited()).toBe(true); // 4th — over limit
    expect(limited()).toBe(true); // still blocked
  });

  test("a blocked call is not recorded, so it cannot poison the window", () => {
    let now = 0;
    const limited = createRateLimiter(2, 100, () => now);
    limited(); // t=0 recorded
    limited(); // t=0 recorded (2 in window)
    now = 50;
    expect(limited()).toBe(true); // blocked, NOT recorded
    now = 101; // window slides past the two t=0 entries
    // both t=0 entries are now older than 101-100=1 → evicted; window empty
    expect(limited()).toBe(false);
  });

  test("requests outside the window are evicted and no longer count", () => {
    let now = 0;
    const limited = createRateLimiter(1, 100, () => now);
    expect(limited()).toBe(false); // t=0
    now = 50;
    expect(limited()).toBe(true); // 1 still in window → blocked
    now = 200; // t=0 is older than 200-100=100 → evicted
    expect(limited()).toBe(false); // window empty again
  });

  test("default limit is 30 requests per window", () => {
    const now = 0;
    const limited = createRateLimiter(undefined, undefined, () => now);
    for (let i = 0; i < 30; i++) {
      expect(limited()).toBe(false);
    }
    expect(limited()).toBe(true); // 31st blocked
  });
});
