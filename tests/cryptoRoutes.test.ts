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

mock.module("../src/lib/snaptrade", () => ({
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

    const accountId = "11111111-2222-4333-8aaa-555555555555";

    tradingMocks.searchCryptocurrencyPairInstruments.mockImplementation(async (payload) => {
      expect(payload.accountId).toBe(accountId);
      expect(payload.userId).toBe("snap-user");
      expect(payload.userSecret).toBe("snap-secret");
      const headers = {
        get: (key: string) => {
          const lower = key.toLowerCase();
          if (lower === "x-request-id") {
            return "req-123";
          }
          if (lower === "x-ratelimit-limit") {
            return "100";
          }
          if (lower === "x-ratelimit-remaining") {
            return "99";
          }
          if (lower === "x-ratelimit-reset") {
            return "1699999999";
          }
          return undefined;
        }
      };
      return {
        data: responseBody,
        headers
      };
    });

    const app = createApp();
    const res = await app.request(`/crypto/pairs?accountId=${accountId}&userId=snap-user&userSecret=snap-secret`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(tradingMocks.searchCryptocurrencyPairInstruments.mock.calls.length).toBe(1);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-123");
    expect(res.headers.get("X-SnapTrade-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-SnapTrade-RateLimit-Remaining")).toBe("99");
    expect(res.headers.get("X-SnapTrade-RateLimit-Reset")).toBe("1699999999");
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
      headers: {
        get: (key: string) => {
          const lower = key.toLowerCase();
          if (lower === "x-request-id") {
            return "req-order";
          }
          if (lower === "x-ratelimit-remaining") {
            return "42";
          }
          return undefined;
        }
      }
    }));

    const payload = {
      accountId: "22222222-3333-4444-8bbb-666666666666",
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
    expect(first.headers.get("X-SnapTrade-RateLimit-Remaining")).toBe("42");

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
    const quoteAccountId = "33333333-4444-4555-8ccc-777777777777";
    const res = await app.request(
      `/crypto/quote?accountId=${quoteAccountId}&userId=snap-user&userSecret=snap-secret&instrumentSymbol=ETH-USD`
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("snaptrade_error");
    expect(body.status).toBe(503);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-fail");
  });

  it("maps expiration_date to expiration_time in order payloads", async () => {
    const payload = {
      accountId: "44444444-5555-4666-8ddd-888888888888",
      userId: "snap-user",
      userSecret: "snap-secret",
      instrument: { symbol: "BTC-USD", type: "CRYPTOCURRENCY_PAIR" as const },
      side: "SELL" as const,
      type: "LIMIT" as const,
      time_in_force: "GTD" as const,
      amount: "5",
      limit_price: "45000",
      post_only: true,
      expiration_date: "2025-01-01T00:00:00Z"
    };

    tradingMocks.previewCryptoOrder.mockImplementation(async (request) => {
      expect(request.requestBody).not.toHaveProperty("expiration_date");
      expect(request.requestBody.expiration_time).toBe(payload.expiration_date);
      expect(request.requestBody.limit_price).toBe(payload.limit_price);
      expect(request.requestBody.post_only).toBe(true);
      return {
        data: { order_id: "preview-123" },
        headers: { get: () => undefined }
      };
    });

    const app = createApp();
    const res = await app.request("/crypto/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ order_id: "preview-123" });
    expect(tradingMocks.previewCryptoOrder.mock.calls.length).toBe(1);
  });
});
