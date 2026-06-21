/**
 * Forecast & position-sizing logic — pure, deterministic, no I/O.
 *
 * Extracted from http.ts so the probability / edge / Kelly-sizing / Brier math
 * can be unit tested without booting the HTTP server (http.ts calls Bun.serve
 * at import time). http.ts re-imports these — behavior is unchanged.
 */

// ── Constants (mirror the thresholds used in the MCP tool handlers) ──────────

export const MIN_EDGE = 0.05; // 5 percentage-point minimum edge to trade
export const MAX_POSITION_FRACTION = 0.05; // hard cap: 5% of portfolio per position
export const DEFAULT_KELLY_FRACTION = 0.25; // quarter-Kelly
export const MIN_POSITION_USD = 1; // minimum position size in dollars

export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 60_000;

// ── Ensemble median ─────────────────────────────────────────────────────────

/**
 * Median of an array of probability estimates.
 * For an even count, returns the average of the two middle values.
 * Does not mutate the input.
 */
export function computeMedian(estimates: number[]): number {
  const sorted = [...estimates].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return NaN;
  return n % 2 === 0
    ? (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
    : sorted[Math.floor(n / 2)]!;
}

// ── Forecast (median / edge / direction / tradeable) ─────────────────────────

export interface Forecast {
  median: number;
  edge: number; // median - marketPrice
  absEdge: number;
  direction: "YES" | "NO";
  tradeable: boolean; // absEdge >= MIN_EDGE
}

/**
 * Given ensemble estimates and the current market YES price, compute the
 * forecast: median estimate, edge vs the market, trade direction, and whether
 * the edge clears the minimum threshold.
 *
 * direction is YES when the AI thinks the event is MORE likely than the market
 * (edge > 0), NO otherwise. A zero edge is treated as NO (no positive edge).
 */
export function computeForecast(
  estimates: number[],
  marketPrice: number,
): Forecast {
  const median = computeMedian(estimates);
  const edge = median - marketPrice;
  const absEdge = Math.abs(edge);
  return {
    median,
    edge,
    absEdge,
    direction: edge > 0 ? "YES" : "NO",
    tradeable: absEdge >= MIN_EDGE,
  };
}

// ── Quarter-Kelly position sizing ────────────────────────────────────────────

export interface KellySizing {
  /** Price actually paid per contract for the chosen side (0-1). */
  price: number;
  /** Decimal odds = (1 - price) / price. */
  odds: number;
  /** Full-Kelly fraction = absEdge / odds. */
  kellyFull: number;
  /** Fraction after applying kellyFraction (e.g. quarter-Kelly). */
  kellyAdjusted: number;
  /** Dollar position size, capped at MAX_POSITION_FRACTION of portfolio. */
  positionSize: number;
  /** Number of contracts = positionSize / price. */
  contracts: number;
}

/**
 * Quarter-Kelly position sizing, mirroring the execute-trade tool handler.
 *
 * `price` is the cost of the chosen side: marketPrice for YES, (1 - marketPrice)
 * for NO. positionSize is min(kellyAdjusted * portfolio, 5% of portfolio).
 */
export function computeKellySizing(
  direction: "YES" | "NO",
  marketPrice: number,
  absEdge: number,
  portfolioValue: number,
  kellyFraction: number = DEFAULT_KELLY_FRACTION,
): KellySizing {
  const price = direction === "YES" ? marketPrice : 1 - marketPrice;
  const odds = (1 - price) / price;
  const kellyFull = absEdge / odds;
  const kellyAdjusted = kellyFull * kellyFraction;
  const positionSize = Math.min(
    kellyAdjusted * portfolioValue,
    portfolioValue * MAX_POSITION_FRACTION,
  );
  const contracts = positionSize / price;
  return { price, odds, kellyFull, kellyAdjusted, positionSize, contracts };
}

// ── Brier score ──────────────────────────────────────────────────────────────

/**
 * Mean Brier score over resolved forecasts.
 *
 * For each forecast: prob = median_estimate if YES won (outcome 1), else
 * (1 - median_estimate). The squared error is (1 - prob)^2. Lower is better;
 * a perfect forecaster scores 0. Empty input returns 0.
 */
export function computeBrierScore(
  resolved: { median_estimate: number; outcome: 0 | 1 }[],
): number {
  if (resolved.length === 0) return 0;
  let sum = 0;
  for (const r of resolved) {
    const prob = r.outcome === 1 ? r.median_estimate : 1 - r.median_estimate;
    sum += (1 - prob) ** 2;
  }
  return sum / resolved.length;
}

// ── Win rate ─────────────────────────────────────────────────────────────────

export interface WinStats {
  wins: number;
  losses: number;
  totalPnl: number;
  winRate: number; // wins / total, 0 when no rows
}

/**
 * Win/loss tally and total P&L over resolved trades. A non-positive pnl counts
 * as a loss (mirrors the handler's `if (pnl > 0) wins else losses`).
 */
export function computeWinStats(pnlRows: { pnl: number }[]): WinStats {
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  for (const r of pnlRows) {
    if (r.pnl > 0) wins++;
    else losses++;
    totalPnl += r.pnl;
  }
  return {
    wins,
    losses,
    totalPnl,
    winRate: pnlRows.length > 0 ? wins / pnlRows.length : 0,
  };
}

// ── Rate limiter ─────────────────────────────────────────────────────────────

/**
 * Sliding-window rate limiter factory. Returns a function that records the
 * current time and reports whether the caller is rate limited. Pulled out of
 * http.ts so the windowing logic is testable with an injectable clock.
 *
 * Behavior matches the original: timestamps older than the window are evicted;
 * if `limit` requests remain in the window, the call is limited (and NOT
 * recorded); otherwise the call is recorded and allowed.
 */
export function createRateLimiter(
  limit: number = RATE_LIMIT,
  windowMs: number = RATE_WINDOW_MS,
  now: () => number = Date.now,
): () => boolean {
  const timestamps: number[] = [];
  return function isRateLimited(): boolean {
    const t = now();
    while (timestamps.length > 0 && timestamps[0]! < t - windowMs) {
      timestamps.shift();
    }
    if (timestamps.length >= limit) return true;
    timestamps.push(t);
    return false;
  };
}
