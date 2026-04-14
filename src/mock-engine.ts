/**
 * Mock execution engine for Phase 1 paper trading.
 *
 * Simulates order placement and portfolio tracking against live Polymarket prices.
 * Stores all state in SQLite. When EXCHANGE_MODE=live, this layer is bypassed
 * and real orders go to Polymarket's CLOB API.
 *
 * Simulated fills execute at the current market price (no slippage modeling in Phase 1).
 */
import { getDb } from "./db.js";

const INITIAL_CAPITAL = 5_000; // $5,000 USDC simulated

// ── Types ──────────────────────────────────────────────

export interface Position {
  market_id: string;
  market_question: string;
  direction: "YES" | "NO";
  contracts: number;
  avg_cost: number;
  current_price: number;
  unrealized_pnl: number;
}

export interface PortfolioSummary {
  total_value: number;
  cash: number;
  positions_value: number;
  open_positions: number;
  daily_pnl: number;
  cumulative_pnl: number;
  max_drawdown: number;
  roi_percent: number;
}

export interface TradeResult {
  success: boolean;
  order_id: string;
  fill_price: number;
  contracts: number;
  cost: number;
  error?: string;
}

// ── Mock Portfolio State ───────────────────────────────

let cash = INITIAL_CAPITAL;
let peakValue = INITIAL_CAPITAL;
const positions = new Map<
  string,
  {
    market_id: string;
    market_question: string;
    direction: "YES" | "NO";
    contracts: number;
    avg_cost: number;
  }
>();

// Restore state from DB on startup
export function restoreState(): void {
  const db = getDb();

  // Get latest portfolio snapshot for cash
  const snap = db
    .query<{ cash: number; total_value: number }, []>(
      "SELECT cash, total_value FROM portfolio_snapshots ORDER BY id DESC LIMIT 1",
    )
    .get();

  if (snap) {
    cash = snap.cash;
    peakValue = Math.max(peakValue, snap.total_value);
  }

  // Rebuild positions from unresolved traded forecasts
  const rows = db
    .query<
      {
        market_id: string;
        market_question: string;
        direction: string;
        contracts: number;
        fill_price: number;
      },
      []
    >(
      `SELECT market_id, market_question, direction, contracts, fill_price
       FROM forecasts WHERE traded = 1 AND resolved = 0`,
    )
    .all();

  positions.clear();
  for (const row of rows) {
    const key = `${row.market_id}:${row.direction}`;
    const existing = positions.get(key);
    if (existing) {
      const totalContracts = existing.contracts + row.contracts;
      existing.avg_cost =
        (existing.avg_cost * existing.contracts +
          row.fill_price * row.contracts) /
        totalContracts;
      existing.contracts = totalContracts;
    } else {
      positions.set(key, {
        market_id: row.market_id,
        market_question: row.market_question ?? "",
        direction: row.direction as "YES" | "NO",
        contracts: row.contracts,
        avg_cost: row.fill_price,
      });
    }
  }

  console.log(
    `[mock-engine] Restored: $${cash.toFixed(2)} cash, ${positions.size} positions`,
  );
}

// ── Trade Execution ────────────────────────────────────

/**
 * Simulate a trade at the current market price.
 */
export function executeTrade(
  forecastId: number,
  marketId: string,
  marketQuestion: string,
  direction: "YES" | "NO",
  marketPrice: number,
  contracts: number,
): TradeResult {
  const cost = marketPrice * contracts;

  if (cost > cash) {
    return {
      success: false,
      order_id: "",
      fill_price: 0,
      contracts: 0,
      cost: 0,
      error: `Insufficient cash: need $${cost.toFixed(2)}, have $${cash.toFixed(2)}`,
    };
  }

  // Check position limits
  if (positions.size >= 50 && !positions.has(`${marketId}:${direction}`)) {
    return {
      success: false,
      order_id: "",
      fill_price: 0,
      contracts: 0,
      cost: 0,
      error: "Max 50 concurrent positions reached",
    };
  }

  // Check single position limit (5% of portfolio)
  const portfolioValue = getPortfolioValue();
  const maxPositionValue = portfolioValue * 0.05;
  const existingKey = `${marketId}:${direction}`;
  const existing = positions.get(existingKey);
  const existingValue = existing ? existing.contracts * existing.avg_cost : 0;
  if (existingValue + cost > maxPositionValue) {
    return {
      success: false,
      order_id: "",
      fill_price: 0,
      contracts: 0,
      cost: 0,
      error: `Position would exceed 5% limit ($${maxPositionValue.toFixed(2)})`,
    };
  }

  // Execute
  cash -= cost;
  const orderId = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Update position
  if (existing) {
    const totalContracts = existing.contracts + contracts;
    existing.avg_cost =
      (existing.avg_cost * existing.contracts + marketPrice * contracts) /
      totalContracts;
    existing.contracts = totalContracts;
  } else {
    positions.set(existingKey, {
      market_id: marketId,
      market_question: marketQuestion,
      direction,
      contracts,
      avg_cost: marketPrice,
    });
  }

  // Update DB
  const db = getDb();
  db.run(
    `UPDATE forecasts SET traded = 1, order_id = ?, fill_price = ?, contracts = ?, cost = ?
     WHERE id = ?`,
    [orderId, marketPrice, contracts, cost, forecastId],
  );

  return {
    success: true,
    order_id: orderId,
    fill_price: marketPrice,
    contracts,
    cost,
  };
}

// ── Resolution ─────────────────────────────────────────

/**
 * Resolve a market outcome. Updates P&L and returns cash.
 */
export function resolveMarket(
  marketId: string,
  outcome: 0 | 1, // 1 = YES won, 0 = NO won
): { resolved: number; pnl: number } {
  let totalPnl = 0;
  let resolved = 0;

  // Check both YES and NO positions
  for (const dir of ["YES", "NO"] as const) {
    const key = `${marketId}:${dir}`;
    const pos = positions.get(key);
    if (!pos) continue;

    const won =
      (dir === "YES" && outcome === 1) || (dir === "NO" && outcome === 0);
    const payout = won ? pos.contracts * 1.0 : 0; // Winning = $1/contract
    const pnl = payout - pos.contracts * pos.avg_cost;

    cash += payout;
    totalPnl += pnl;
    resolved++;
    positions.delete(key);

    // Update all forecasts for this market+direction
    const db = getDb();
    db.run(
      `UPDATE forecasts SET resolved = 1, outcome = ?, pnl = ?, resolved_at = datetime('now')
       WHERE market_id = ? AND direction = ? AND traded = 1 AND resolved = 0`,
      [outcome, pnl, marketId, dir],
    );
  }

  return { resolved, pnl: totalPnl };
}

// ── Portfolio Queries ──────────────────────────────────

function getPortfolioValue(): number {
  let positionsValue = 0;
  for (const pos of positions.values()) {
    positionsValue += pos.contracts * pos.avg_cost; // Use cost basis for mock
  }
  return cash + positionsValue;
}

export function getPositions(
  currentPrices?: Map<string, number>,
): Position[] {
  const result: Position[] = [];
  for (const pos of positions.values()) {
    const currentPrice = currentPrices?.get(pos.market_id) ?? pos.avg_cost;
    const unrealizedPnl =
      pos.direction === "YES"
        ? (currentPrice - pos.avg_cost) * pos.contracts
        : (pos.avg_cost - currentPrice) * pos.contracts;

    result.push({
      market_id: pos.market_id,
      market_question: pos.market_question,
      direction: pos.direction,
      contracts: pos.contracts,
      avg_cost: pos.avg_cost,
      current_price: currentPrice,
      unrealized_pnl: unrealizedPnl,
    });
  }
  return result;
}

export function getPortfolioSummary(): PortfolioSummary {
  const totalValue = getPortfolioValue();
  const positionsValue = totalValue - cash;
  const cumulativePnl = totalValue - INITIAL_CAPITAL;
  peakValue = Math.max(peakValue, totalValue);
  const maxDrawdown =
    peakValue > 0 ? (peakValue - totalValue) / peakValue : 0;

  return {
    total_value: totalValue,
    cash,
    positions_value: positionsValue,
    open_positions: positions.size,
    daily_pnl: 0, // Computed from snapshots
    cumulative_pnl: cumulativePnl,
    max_drawdown: maxDrawdown,
    roi_percent: (cumulativePnl / INITIAL_CAPITAL) * 100,
  };
}

/**
 * Save a portfolio snapshot to DB.
 */
export function saveSnapshot(): void {
  const summary = getPortfolioSummary();
  const db = getDb();
  db.run(
    `INSERT INTO portfolio_snapshots (total_value, cash, open_positions, daily_pnl, cumulative_pnl, max_drawdown)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      summary.total_value,
      summary.cash,
      summary.open_positions,
      summary.daily_pnl,
      summary.cumulative_pnl,
      summary.max_drawdown,
    ],
  );
}

export function getCash(): number {
  return cash;
}
