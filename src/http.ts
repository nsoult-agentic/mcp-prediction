/**
 * MCP server for Prediction Markets — Polymarket integration with mock execution.
 * Deployed via GitHub Actions → ghcr.io → Portainer CE GitOps polling.
 *
 * Tools:
 *   prediction-list-markets    — List active Polymarket markets with prices
 *   prediction-get-market      — Get details for a specific market
 *   prediction-record-forecast — Record an AI probability forecast for a market
 *   prediction-execute-trade   — Execute a (mock) trade based on a forecast
 *   prediction-get-positions   — Get current open positions
 *   prediction-get-performance — Get portfolio performance and metrics
 *   prediction-resolve-market  — Record a market resolution and compute P&L
 *   prediction-get-trades      — Get trade history with reasoning
 *   prediction-system-status   — Get system health and operational status
 *
 * SECURITY: API keys read from /secrets/ directory (mounted from /srv/).
 * Keys never appear in tool output. Generic error messages only.
 *
 * Usage: PORT=8908 SECRETS_DIR=/secrets DATA_DIR=/data bun run src/http.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getDb } from "./db.js";
import {
  listMarkets,
  getMarket,
  type ParsedMarket,
} from "./polymarket.js";
import {
  restoreState,
  executeTrade,
  resolveMarket,
  getPositions,
  getPortfolioSummary,
  saveSnapshot,
  getCash,
} from "./mock-engine.js";

// ── Configuration ──────────────────────────────────────────

const PORT = Number(process.env["PORT"]) || 8908;
const EXCHANGE_MODE = process.env["EXCHANGE_MODE"] || "mock";

// ── Rate Limiter ──────────────────────────────────────────

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  while (
    requestTimestamps.length > 0 &&
    requestTimestamps[0] < now - RATE_WINDOW_MS
  ) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) return true;
  requestTimestamps.push(now);
  return false;
}

// ── Initialize ────────────────────────────────────────────

console.log(`[mcp-prediction] Starting in ${EXCHANGE_MODE} mode`);
getDb(); // Initialize schema
restoreState(); // Restore portfolio from DB

// ── MCP Setup ─────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-prediction",
    version: "0.1.0",
  });

  // ── Tool: prediction-list-markets ───────────────────────

  server.tool(
    "prediction-list-markets",
    "List active Polymarket markets sorted by volume. Returns market ID, question, YES/NO prices, volume, liquidity, and category.",
    {
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of markets to return (1-100)"),
      category: z
        .string()
        .optional()
        .describe("Filter by category (e.g., 'politics', 'crypto', 'economics')"),
      min_volume: z
        .number()
        .optional()
        .describe("Minimum volume in USD to filter for liquid markets"),
    },
    async ({ limit, category, min_volume }) => {
      if (isRateLimited()) {
        return {
          content: [
            { type: "text", text: "Rate limited. Try again in 60 seconds." },
          ],
        };
      }

      try {
        let markets = await listMarkets({ limit: Math.min(limit, 100) });

        if (category) {
          const cat = category.toLowerCase();
          markets = markets.filter(
            (m) => m.category.toLowerCase().includes(cat),
          );
        }
        if (min_volume) {
          markets = markets.filter((m) => m.volume >= min_volume);
        }

        const lines = markets.map(
          (m) =>
            `[${m.id}] ${m.question}\n  YES: $${m.yesPrice.toFixed(2)} | NO: $${m.noPrice.toFixed(2)} | Vol: $${m.volume.toLocaleString()} | Liq: $${m.liquidity.toLocaleString()} | Cat: ${m.category} | Ends: ${m.endDate}`,
        );

        return {
          content: [
            {
              type: "text",
              text: `Found ${markets.length} active markets:\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error fetching markets: ${msg}` }],
        };
      }
    },
  );

  // ── Tool: prediction-get-market ─────────────────────────

  server.tool(
    "prediction-get-market",
    "Get detailed information about a specific Polymarket market including description, prices, volume, and orderbook depth.",
    {
      market_id: z.string().describe("Polymarket market ID or slug"),
    },
    async ({ market_id }) => {
      if (isRateLimited()) {
        return {
          content: [{ type: "text", text: "Rate limited. Try again in 60 seconds." }],
        };
      }

      try {
        const m = await getMarket(market_id);
        const text = [
          `Market: ${m.question}`,
          `ID: ${m.id}`,
          `Slug: ${m.slug}`,
          `Status: ${m.active ? "Active" : "Inactive"} | ${m.closed ? "Closed" : "Open"}`,
          `YES Price: $${m.yesPrice.toFixed(2)} (${(m.yesPrice * 100).toFixed(1)}% implied)`,
          `NO Price: $${m.noPrice.toFixed(2)} (${(m.noPrice * 100).toFixed(1)}% implied)`,
          `Volume: $${m.volume.toLocaleString()}`,
          `Liquidity: $${m.liquidity.toLocaleString()}`,
          `Category: ${m.category}`,
          `End Date: ${m.endDate}`,
          ``,
          `Description: ${m.description || "(none)"}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error fetching market: ${msg}` }],
        };
      }
    },
  );

  // ── Tool: prediction-record-forecast ────────────────────

  server.tool(
    "prediction-record-forecast",
    "Record an AI probability forecast for a market. Stores the ensemble estimates, market price, edge, and reasoning. Does NOT execute a trade — use prediction-execute-trade after recording.",
    {
      market_id: z.string().describe("Polymarket market ID"),
      market_question: z.string().describe("The market question text"),
      category: z.string().default("unknown").describe("Market category"),
      estimates: z
        .array(z.number().min(0).max(1))
        .min(1)
        .max(10)
        .describe("Array of probability estimates (0-1) from ensemble runs"),
      market_price: z
        .number()
        .min(0)
        .max(1)
        .describe("Current market YES price (0-1)"),
      reasoning: z
        .string()
        .describe("AI reasoning chain explaining the probability estimate"),
    },
    async ({ market_id, market_question, category, estimates, market_price, reasoning }) => {
      const sorted = [...estimates].sort((a, b) => a - b);
      const median =
        sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];

      const edge = median - market_price;
      const direction = edge > 0 ? "YES" : "NO";
      const absEdge = Math.abs(edge);

      const db = getDb();
      const result = db.run(
        `INSERT INTO forecasts (market_id, market_question, category, estimate_1, estimate_2, estimate_3, estimate_4, estimate_5, median_estimate, market_price, edge, direction, reasoning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          market_id,
          market_question,
          category,
          estimates[0] ?? null,
          estimates[1] ?? null,
          estimates[2] ?? null,
          estimates[3] ?? null,
          estimates[4] ?? null,
          median,
          market_price,
          edge,
          direction,
          reasoning,
        ],
      );

      const forecastId = Number(result.lastInsertRowid);
      const tradeable = absEdge >= 0.05;

      return {
        content: [
          {
            type: "text",
            text: [
              `Forecast #${forecastId} recorded:`,
              `  Market: ${market_question}`,
              `  AI Estimate: ${(median * 100).toFixed(1)}% (ensemble: ${estimates.map((e) => (e * 100).toFixed(0) + "%").join(", ")})`,
              `  Market Price: ${(market_price * 100).toFixed(1)}%`,
              `  Edge: ${edge > 0 ? "+" : ""}${(edge * 100).toFixed(1)}pp → ${direction}`,
              `  Tradeable: ${tradeable ? "YES (edge ≥ 5pp)" : "NO (edge < 5pp)"}`,
              tradeable
                ? `  → Use prediction-execute-trade with forecast_id=${forecastId} to execute`
                : `  → Below minimum edge threshold, skip`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── Tool: prediction-execute-trade ──────────────────────

  server.tool(
    "prediction-execute-trade",
    "Execute a trade based on a recorded forecast. In mock mode, simulates the fill at market price. Uses Quarter-Kelly position sizing.",
    {
      forecast_id: z.number().describe("ID of the forecast to trade on"),
      kelly_fraction: z
        .number()
        .min(0)
        .max(1)
        .default(0.25)
        .describe("Kelly fraction (default 0.25 = quarter-Kelly)"),
    },
    async ({ forecast_id, kelly_fraction }) => {
      const db = getDb();
      const forecast = db
        .query<
          {
            id: number;
            market_id: string;
            market_question: string;
            direction: string;
            median_estimate: number;
            market_price: number;
            edge: number;
            traded: number;
          },
          [number]
        >("SELECT * FROM forecasts WHERE id = ?")
        .get(forecast_id);

      if (!forecast) {
        return {
          content: [{ type: "text", text: `Forecast #${forecast_id} not found` }],
        };
      }
      if (forecast.traded) {
        return {
          content: [
            { type: "text", text: `Forecast #${forecast_id} already traded` },
          ],
        };
      }

      const absEdge = Math.abs(forecast.edge);
      if (absEdge < 0.05) {
        return {
          content: [
            {
              type: "text",
              text: `Edge ${(absEdge * 100).toFixed(1)}pp is below 5pp minimum threshold`,
            },
          ],
        };
      }

      // Quarter-Kelly position sizing
      const direction = forecast.direction as "YES" | "NO";
      const price =
        direction === "YES" ? forecast.market_price : 1 - forecast.market_price;
      const odds = (1 - price) / price;
      const kellyFull = absEdge / odds;
      const kellyAdjusted = kellyFull * kelly_fraction;
      const portfolioValue =
        getCash() +
        getPositions()
          .reduce((sum, p) => sum + p.contracts * p.avg_cost, 0);
      const positionSize = Math.min(
        kellyAdjusted * portfolioValue,
        portfolioValue * 0.05, // hard cap at 5%
      );
      const contracts = positionSize / price;

      if (positionSize < 1) {
        return {
          content: [
            {
              type: "text",
              text: `Position size $${positionSize.toFixed(2)} too small (min $1)`,
            },
          ],
        };
      }

      if (EXCHANGE_MODE === "mock") {
        const result = executeTrade(
          forecast_id,
          forecast.market_id,
          forecast.market_question,
          direction,
          price,
          contracts,
        );

        if (!result.success) {
          return {
            content: [
              { type: "text", text: `Trade failed: ${result.error}` },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `Trade executed (MOCK):`,
                `  Order: ${result.order_id}`,
                `  Market: ${forecast.market_question}`,
                `  Direction: ${direction}`,
                `  Contracts: ${contracts.toFixed(2)}`,
                `  Fill Price: $${result.fill_price.toFixed(4)}`,
                `  Cost: $${result.cost.toFixed(2)}`,
                `  Remaining Cash: $${getCash().toFixed(2)}`,
                `  Kelly: ${(kellyFull * 100).toFixed(1)}% full → ${(kellyAdjusted * 100).toFixed(1)}% quarter`,
              ].join("\n"),
            },
          ],
        };
      }

      // TODO: Live execution via Polymarket CLOB API
      return {
        content: [
          {
            type: "text",
            text: "Live trading not yet implemented. Set EXCHANGE_MODE=mock for paper trading.",
          },
        ],
      };
    },
  );

  // ── Tool: prediction-get-positions ──────────────────────

  server.tool(
    "prediction-get-positions",
    "Get all open positions with current prices and unrealized P&L.",
    {},
    async () => {
      const pos = getPositions();
      if (pos.length === 0) {
        return {
          content: [{ type: "text", text: "No open positions." }],
        };
      }

      const lines = pos.map(
        (p) =>
          `${p.direction} ${p.market_question}\n  Contracts: ${p.contracts.toFixed(2)} @ $${p.avg_cost.toFixed(4)} | Unrealized P&L: $${p.unrealized_pnl.toFixed(2)}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `Open Positions (${pos.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    },
  );

  // ── Tool: prediction-get-performance ────────────────────

  server.tool(
    "prediction-get-performance",
    "Get portfolio performance metrics: total value, ROI, Brier score, calibration, win rate.",
    {},
    async () => {
      const summary = getPortfolioSummary();
      const db = getDb();

      // Brier score from resolved forecasts
      const resolved = db
        .query<
          { median_estimate: number; outcome: number },
          []
        >(
          "SELECT median_estimate, outcome FROM forecasts WHERE resolved = 1 AND traded = 1",
        )
        .all();

      let brierScore = 0;
      let wins = 0;
      let losses = 0;
      let totalPnl = 0;

      for (const r of resolved) {
        const prob =
          r.outcome === 1 ? r.median_estimate : 1 - r.median_estimate;
        brierScore += (1 - prob) ** 2;
        // Win/loss from forecasts table
      }
      brierScore = resolved.length > 0 ? brierScore / resolved.length : 0;

      // Win rate from P&L
      const pnlRows = db
        .query<{ pnl: number }, []>(
          "SELECT pnl FROM forecasts WHERE resolved = 1 AND traded = 1",
        )
        .all();
      for (const r of pnlRows) {
        if (r.pnl > 0) wins++;
        else losses++;
        totalPnl += r.pnl;
      }

      const text = [
        `=== Portfolio Performance (${EXCHANGE_MODE} mode) ===`,
        ``,
        `Value:      $${summary.total_value.toFixed(2)}`,
        `Cash:       $${summary.cash.toFixed(2)}`,
        `Positions:  $${summary.positions_value.toFixed(2)} (${summary.open_positions} open)`,
        ``,
        `ROI:        ${summary.roi_percent >= 0 ? "+" : ""}${summary.roi_percent.toFixed(2)}%`,
        `P&L:        $${summary.cumulative_pnl >= 0 ? "+" : ""}${summary.cumulative_pnl.toFixed(2)}`,
        `Max DD:     -${(summary.max_drawdown * 100).toFixed(2)}%`,
        ``,
        `Resolved:   ${resolved.length} predictions`,
        `Brier:      ${brierScore.toFixed(4)}${resolved.length < 30 ? " (insufficient data)" : ""}`,
        `Win Rate:   ${pnlRows.length > 0 ? ((wins / pnlRows.length) * 100).toFixed(1) : "0"}% (${wins}W / ${losses}L)`,
        `Total P&L:  $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );

  // ── Tool: prediction-resolve-market ─────────────────────

  server.tool(
    "prediction-resolve-market",
    "Record the resolution of a market (YES=1, NO=0). Updates positions and computes realized P&L.",
    {
      market_id: z.string().describe("Polymarket market ID"),
      outcome: z
        .number()
        .min(0)
        .max(1)
        .describe("Resolution: 1 = YES won, 0 = NO won"),
    },
    async ({ market_id, outcome }) => {
      const result = resolveMarket(market_id, outcome as 0 | 1);

      if (result.resolved === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No open positions found for market ${market_id}`,
            },
          ],
        };
      }

      saveSnapshot();

      return {
        content: [
          {
            type: "text",
            text: [
              `Market ${market_id} resolved: ${outcome === 1 ? "YES" : "NO"} won`,
              `Positions closed: ${result.resolved}`,
              `Realized P&L: $${result.pnl >= 0 ? "+" : ""}${result.pnl.toFixed(2)}`,
              `Cash after settlement: $${getCash().toFixed(2)}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── Tool: prediction-get-trades ─────────────────────────

  server.tool(
    "prediction-get-trades",
    "Get trade history with AI reasoning, edge, and P&L. Filterable by status and category.",
    {
      status: z
        .enum(["all", "open", "resolved"])
        .default("all")
        .describe("Filter: all, open (unresolved), or resolved"),
      category: z.string().optional().describe("Filter by market category"),
      limit: z.number().min(1).max(100).default(20).describe("Max results"),
    },
    async ({ status, category, limit }) => {
      const db = getDb();
      let query = "SELECT * FROM forecasts WHERE traded = 1";
      const params: (string | number)[] = [];

      if (status === "open") {
        query += " AND resolved = 0";
      } else if (status === "resolved") {
        query += " AND resolved = 1";
      }
      if (category) {
        query += " AND category = ?";
        params.push(category);
      }
      query += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);

      const rows = db
        .query<Record<string, unknown>, (string | number)[]>(query)
        .all(...params);

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No trades found." }],
        };
      }

      const lines = rows.map((r) => {
        const edge = Number(r.edge) || 0;
        const pnl = r.resolved ? `P&L: $${Number(r.pnl).toFixed(2)}` : "OPEN";
        return [
          `#${r.id} [${r.direction}] ${r.market_question}`,
          `  AI: ${((Number(r.median_estimate)) * 100).toFixed(1)}% | Mkt: ${((Number(r.market_price)) * 100).toFixed(1)}% | Edge: ${edge > 0 ? "+" : ""}${(edge * 100).toFixed(1)}pp | ${pnl}`,
          `  Reasoning: ${String(r.reasoning || "").slice(0, 200)}${String(r.reasoning || "").length > 200 ? "..." : ""}`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: `Trade History (${rows.length} trades):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    },
  );

  // ── Tool: prediction-system-status ──────────────────────

  server.tool(
    "prediction-system-status",
    "Get system health: exchange mode, DB stats, last cycle, positions count.",
    {},
    async () => {
      const db = getDb();
      const totalForecasts = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM forecasts")
        .get()?.count ?? 0;
      const tradedForecasts = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM forecasts WHERE traded = 1",
        )
        .get()?.count ?? 0;
      const resolvedForecasts = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM forecasts WHERE resolved = 1",
        )
        .get()?.count ?? 0;
      const lastCycle = db
        .query<{ timestamp: string; cycle_status: string }, []>(
          "SELECT timestamp, cycle_status FROM system_health ORDER BY id DESC LIMIT 1",
        )
        .get();

      const summary = getPortfolioSummary();

      const text = [
        `=== System Status ===`,
        `Mode:           ${EXCHANGE_MODE}`,
        `Portfolio:      $${summary.total_value.toFixed(2)}`,
        `Open Positions: ${summary.open_positions}`,
        ``,
        `Forecasts:      ${totalForecasts} total`,
        `Traded:         ${tradedForecasts}`,
        `Resolved:       ${resolvedForecasts}`,
        `Pending:        ${tradedForecasts - resolvedForecasts}`,
        ``,
        `Last Cycle:     ${lastCycle ? `${lastCycle.timestamp} (${lastCycle.cycle_status})` : "none"}`,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}

// ── HTTP Transport ────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", mode: EXCHANGE_MODE }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // MCP endpoint
    if (url.pathname === "/mcp" && req.method === "POST") {
      const server = createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      return transport.handleRequest(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  `[mcp-prediction] Listening on port ${PORT} (${EXCHANGE_MODE} mode)`,
);
