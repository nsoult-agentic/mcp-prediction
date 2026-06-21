import { describe, test, expect } from "bun:test";

import { parseMarket, type PolymarketMarket } from "../src/polymarket.js";

// parseMarket is a pure transform from the raw Gamma-API shape to ParsedMarket.
// Expected values are derived by hand from the input strings below.

function raw(overrides: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    id: "123",
    question: "Will X happen?",
    conditionId: "0xabc",
    slug: "will-x-happen",
    active: true,
    closed: false,
    acceptingOrders: true,
    outcomePrices: '["0.55", "0.45"]',
    outcomes: '["Yes", "No"]',
    volume: "1000.5",
    liquidity: "250.25",
    endDate: "2026-12-31",
    category: "politics",
    description: "Some description",
    ...overrides,
  };
}

describe("parseMarket", () => {
  test("parses YES/NO prices out of the JSON-string outcomePrices", () => {
    const m = parseMarket(raw());
    expect(m.yesPrice).toBeCloseTo(0.55, 10);
    expect(m.noPrice).toBeCloseTo(0.45, 10);
  });

  test("coerces numeric strings for volume and liquidity", () => {
    const m = parseMarket(raw());
    expect(m.volume).toBe(1000.5);
    expect(m.liquidity).toBe(250.25);
  });

  test("passes through identity/status fields unchanged", () => {
    const m = parseMarket(raw());
    expect(m.id).toBe("123");
    expect(m.question).toBe("Will X happen?");
    expect(m.slug).toBe("will-x-happen");
    expect(m.active).toBe(true);
    expect(m.closed).toBe(false);
    expect(m.endDate).toBe("2026-12-31");
    expect(m.category).toBe("politics");
    expect(m.description).toBe("Some description");
  });

  test("malformed outcomePrices JSON leaves prices at 0 (no throw)", () => {
    const m = parseMarket(raw({ outcomePrices: "not json" }));
    expect(m.yesPrice).toBe(0);
    expect(m.noPrice).toBe(0);
  });

  test("non-numeric price entries fall back to 0", () => {
    const m = parseMarket(raw({ outcomePrices: '["abc", "def"]' }));
    expect(m.yesPrice).toBe(0);
    expect(m.noPrice).toBe(0);
  });

  test("missing category defaults to 'unknown'", () => {
    const m = parseMarket(raw({ category: undefined }));
    expect(m.category).toBe("unknown");
  });

  test("missing description defaults to empty string", () => {
    const m = parseMarket(raw({ description: undefined }));
    expect(m.description).toBe("");
  });

  test("non-numeric volume / liquidity fall back to 0", () => {
    const m = parseMarket(raw({ volume: "n/a", liquidity: "" }));
    expect(m.volume).toBe(0);
    expect(m.liquidity).toBe(0);
  });

  test("accepts numeric (non-string) price entries too", () => {
    // Gamma sometimes returns numbers rather than strings; Number() handles both
    const m = parseMarket(
      raw({ outcomePrices: JSON.stringify([0.7, 0.3]) }),
    );
    expect(m.yesPrice).toBeCloseTo(0.7, 10);
    expect(m.noPrice).toBeCloseTo(0.3, 10);
  });
});
