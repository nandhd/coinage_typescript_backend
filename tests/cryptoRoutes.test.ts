import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

// Lock in test-aware defaults for the env schema before any modules import it.
process.env.BUN_TEST = "true";
process.env.NODE_ENV = "test";
process.env.SNAPTRADE_CLIENT_ID ??= "test-client";
process.env.SNAPTRADE_CONSUMER_KEY ??= "test-key";
process.env.SNAPTRADE_BASE_URL ??= "https://api.snaptrade.com/api/v1";

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

const { registerCryptoRoutes, resetCryptoRateLimiterForTests } = await import("../src/routes/crypto");

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

    tradingMocks.searchCryptocurrencyPairInstruments.mockImplementation(
      async (payload) => {
        expect(payload.accountId).toBe("123e4567-e89b-12d3-a456-426614174000");
        expect(payload.userId).toBe("snap-user");
        expect(payload.userSecret).toBe("snap-secret");
        return {
          data: responseBody,
          headers: {
            get: (key: string) => {
              switch (key.toLowerCase()) {
                case "x-request-id":
                  return "req-123";
                case "x-ratelimit-limit":
                  return "120";
                case "x-ratelimit-remaining":
                  return "119";
                case "x-ratelimit-reset":
                  return "42";
                default:
                  return undefined;
              }
            }
          }
        };
      }
    );

    const app = createApp();
    const res = await app.request(
      "/crypto/pairs?accountId=123e4567-e89b-12d3-a456-426614174000&userId=snap-user&userSecret=snap-secret"
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(tradingMocks.searchCryptocurrencyPairInstruments.mock.calls.length).toBe(1);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-123");
    expect(res.headers.get("X-SnapTrade-RateLimit-Limit")).toBe("120");
    expect(res.headers.get("X-SnapTrade-RateLimit-Remaining")).toBe("119");
    expect(res.headers.get("X-SnapTrade-RateLimit-Reset")).toBe("42");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects invalid pair queries with 400", async () => {
    const app = createApp();
    const res = await app.request("/crypto/pairs");

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("validation_error");
  });

  it("requires limit_price for limit orders", async () => {
    const app = createApp();
    const res = await app.request("/crypto/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: "123e4567-e89b-12d3-a456-426614174004",
        userId: "snap-user",
        userSecret: "snap-secret",
        instrument: { symbol: "BTC-USD", type: "CRYPTOCURRENCY_PAIR" as const },
        side: "BUY" as const,
        type: "LIMIT" as const,
        time_in_force: "GTC" as const,
        amount: "1"
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
    expect(body.issues.fieldErrors.limit_price?.[0]).toContain("limit_price is required");
  });

  it("requires expiration date for GTD orders", async () => {
    const app = createApp();
    const res = await app.request("/crypto/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: "123e4567-e89b-12d3-a456-426614174005",
        userId: "snap-user",
        userSecret: "snap-secret",
        instrument: { symbol: "BTC-USD", type: "CRYPTOCURRENCY_PAIR" as const },
        side: "BUY" as const,
        type: "MARKET" as const,
        time_in_force: "GTD" as const,
        amount: "1"
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
    expect(body.issues.fieldErrors.expiration_date?.[0]).toContain("expiration_date is required");
  });

  it("rejects non-decimal amounts", async () => {
    const app = createApp();
    const res = await app.request("/crypto/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: "123e4567-e89b-12d3-a456-426614174006",
        userId: "snap-user",
        userSecret: "snap-secret",
        instrument: { symbol: "BTC-USD", type: "CRYPTOCURRENCY_PAIR" as const },
        side: "BUY" as const,
        type: "MARKET" as const,
        time_in_force: "GTC" as const,
        amount: "12.two"
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
    expect(body.issues.fieldErrors.amount?.[0]).toContain("decimal string");
  });

  it("enforces per-account rate limiting on place order", async () => {
    tradingMocks.placeCryptoOrder.mockImplementation(async () => ({
      data: { order_id: "abc" },
      headers: {
        get: (key: string) => {
          switch (key.toLowerCase()) {
            case "x-request-id":
              return "req-order";
            case "x-ratelimit-limit":
              return "60";
            case "x-ratelimit-remaining":
              return "59";
            case "x-ratelimit-reset":
              return "15";
            default:
              return undefined;
          }
        }
      }
    }));

    const payload = {
      accountId: "123e4567-e89b-12d3-a456-426614174001",
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
    expect(first.headers.get("X-SnapTrade-Request-ID")).toBe("req-order");
    expect(first.headers.get("X-SnapTrade-RateLimit-Limit")).toBe("60");
    expect(first.headers.get("X-SnapTrade-RateLimit-Remaining")).toBe("59");
    expect(first.headers.get("X-SnapTrade-RateLimit-Reset")).toBe("15");
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("X-SnapTrade-RateLimit-Reset")).toBe("15");

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
        headers: {
          "x-request-id": "req-fail",
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "60",
          "retry-after": "3"
        }
      };
      throw error;
    });

    const app = createApp();
    const res = await app.request(
      "/crypto/quote?accountId=123e4567-e89b-12d3-a456-426614174002&userId=snap-user&userSecret=snap-secret&instrumentSymbol=ETH-USD"
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("snaptrade_error");
    expect(body.status).toBe(503);
    expect(body.details).toEqual({ error: "maintenance" });
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-fail");
    expect(res.headers.get("X-SnapTrade-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-SnapTrade-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-SnapTrade-RateLimit-Reset")).toBe("60");
    expect(res.headers.get("Retry-After")).toBe("3");
  });
});
