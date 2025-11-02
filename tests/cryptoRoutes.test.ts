import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

const tradingMocks = {
  searchCryptocurrencyPairInstruments: mock(async () => {
    throw new Error("searchCryptocurrencyPairInstruments mock not configured");
  }),
  getCryptocurrencyPairQuote: mock(async () => {
    throw new Error("getCryptocurrencyPairQuote mock not configured");
  }),
  previewCryptoOrder: mock(async () => {
    throw new Error("previewCryptoOrder mock not configured");
  }),
  placeCryptoOrder: mock(async () => {
    throw new Error("placeCryptoOrder mock not configured");
  })
};

mock.module("../src/lib/snaptrade.ts", () => ({
  snaptrade: {
    trading: tradingMocks
  }
}));

import { registerCryptoRoutes, resetCryptoRateLimiterForTests } from "../src/routes/crypto";

function createApp() {
  const app = new Hono();
  registerCryptoRoutes(app);
  return app;
}

beforeEach(() => {
  resetCryptoRateLimiterForTests();
  for (const fn of Object.values(tradingMocks)) {
    fn.mockReset();
    fn.mockImplementation(async () => {
      throw new Error("mock not configured");
    });
  }
});

describe("crypto routes", () => {
  it("returns cryptocurrency pairs and propagates SnapTrade request id", async () => {
    const responseBody = [{ symbol: "BTC-USD" }];

    tradingMocks.searchCryptocurrencyPairInstruments.mockImplementation(async (payload) => {
      expect(payload.accountId).toBe("00000000-0000-0000-0000-000000000001");
      expect(payload.userId).toBe("snap-user");
      expect(payload.userSecret).toBe("snap-secret");
      return {
        data: responseBody,
        headers: {
          get: (key: string) => (key.toLowerCase() === "x-request-id" ? "req-123" : undefined)
        }
      };
    });

    const app = createApp();
    const res = await app.request(
      "/crypto/pairs?accountId=00000000-0000-0000-0000-000000000001&userId=snap-user&userSecret=snap-secret"
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(tradingMocks.searchCryptocurrencyPairInstruments.mock.calls.length).toBe(1);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-123");
  });

  it("rejects invalid pair queries with 400", async () => {
    const app = createApp();
    const res = await app.request("/crypto/pairs");

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("validation_error");
  });

  it("enforces per-account rate limiting on place order", async () => {
    tradingMocks.placeCryptoOrder.mockImplementation(async () => ({
      data: { order_id: "abc" },
      headers: { get: () => "req-order" }
    }));

    const payload = {
      accountId: "00000000-0000-0000-0000-000000000002",
      userId: "snap-user",
      userSecret: "snap-secret",
      instrument: { symbol: "BTC-USD", type: "CRYPTOCURRENCY_PAIR" as const },
      side: "BUY" as const,
      type: "MARKET" as const,
      time_in_force: "GTC" as const,
      amount: "10"
    };

    const app = createApp();

    const first = await app.request("/crypto/place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ order_id: "abc" });

    const second = await app.request("/crypto/place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(second.status).toBe(429);
    const retryPayload = await second.json();
    expect(retryPayload.error).toBe("rate_limited");
    expect(tradingMocks.placeCryptoOrder.mock.calls.length).toBe(1);
  });

  it("maps SnapTrade errors onto the HTTP response", async () => {
    tradingMocks.getCryptocurrencyPairQuote.mockImplementation(async () => {
      const error: any = new Error("snaptrade unavailable");
      error.response = {
        status: 503,
        data: { error: "maintenance" },
        headers: { "x-request-id": "req-fail" }
      };
      throw error;
    });

    const app = createApp();
    const res = await app.request(
      "/crypto/quote?accountId=00000000-0000-0000-0000-000000000003&userId=snap-user&userSecret=snap-secret&instrumentSymbol=ETH-USD"
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("snaptrade_error");
    expect(body.status).toBe(503);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-fail");
  });
});
