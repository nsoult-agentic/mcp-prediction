/**
 * Polymarket API client — fetches live market data from Gamma API.
 * Read-only operations only (market listing, prices, orderbook).
 * No authentication needed for public data.
 *
 * APIs:
 *   Gamma API  — market metadata, events (gamma-api.polymarket.com)
 *   CLOB API   — orderbook, prices (clob.polymarket.com)
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// ── Types ──────────────────────────────────────────────

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  active: boolean;
  closed: boolean;
  markets: PolymarketMarket[];
  startDate: string;
  endDate: string;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  outcomePrices: string; // JSON string: e.g. '[0.55, 0.45]'
  outcomes: string; // JSON string: e.g. '["Yes", "No"]'
  volume: string;
  liquidity: string;
  endDate: string;
  category?: string;
  description?: string;
}

export interface ParsedMarket {
  id: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  yesPrice: number;
  noPrice: number;
  volume: number;
  liquidity: number;
  endDate: string;
  category: string;
  description: string;
}

export interface OrderbookEntry {
  price: string;
  size: string;
}

export interface Orderbook {
  market: string;
  asset_id: string;
  bids: OrderbookEntry[];
  asks: OrderbookEntry[];
}

// ── Fetch Helper ───────────────────────────────────────

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const domain = new URL(url).hostname;
    console.error(`[polymarket] ${domain} HTTP ${res.status}`);
    throw new Error(`Polymarket API HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Public API ─────────────────────────────────────────

/**
 * Fetch active markets from Gamma API.
 * Filters: active, not closed, accepting orders.
 */
export async function listMarkets(opts?: {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
}): Promise<ParsedMarket[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts?.limit ?? 100));
  params.set("offset", String(opts?.offset ?? 0));
  params.set("active", String(opts?.active ?? true));
  params.set("closed", String(opts?.closed ?? false));
  params.set("order", "volume");
  params.set("ascending", "false");

  const raw = await apiFetch<PolymarketMarket[]>(
    `${GAMMA_BASE}/markets?${params}`,
  );
  return raw.map(parseMarket).filter((m) => m.yesPrice > 0);
}

/**
 * Fetch a single market by ID or slug.
 */
export async function getMarket(idOrSlug: string): Promise<ParsedMarket> {
  const raw = await apiFetch<PolymarketMarket>(
    `${GAMMA_BASE}/markets/${idOrSlug}`,
  );
  return parseMarket(raw);
}

/**
 * Fetch events (groups of related markets).
 */
export async function listEvents(opts?: {
  limit?: number;
  active?: boolean;
}): Promise<PolymarketEvent[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts?.limit ?? 50));
  params.set("active", String(opts?.active ?? true));
  params.set("order", "volume");
  params.set("ascending", "false");

  return apiFetch<PolymarketEvent[]>(`${GAMMA_BASE}/events?${params}`);
}

/**
 * Fetch orderbook for a market from CLOB API.
 */
export async function getOrderbook(tokenId: string): Promise<Orderbook> {
  return apiFetch<Orderbook>(`${CLOB_BASE}/book?token_id=${tokenId}`);
}

// ── Parser ─────────────────────────────────────────────

function parseMarket(m: PolymarketMarket): ParsedMarket {
  let yesPrice = 0;
  let noPrice = 0;
  try {
    const prices = JSON.parse(m.outcomePrices) as number[];
    yesPrice = prices[0] ?? 0;
    noPrice = prices[1] ?? 0;
  } catch {
    // malformed data — leave at 0
  }

  return {
    id: m.id,
    question: m.question,
    slug: m.slug,
    active: m.active,
    closed: m.closed,
    yesPrice,
    noPrice,
    volume: Number(m.volume) || 0,
    liquidity: Number(m.liquidity) || 0,
    endDate: m.endDate,
    category: m.category ?? "unknown",
    description: m.description ?? "",
  };
}
