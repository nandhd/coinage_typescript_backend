import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { env } from "../src/lib/env";

const tradingMocks = {
  getOrderImpact: mock(async () => {
    throw new Error("getOrderImpact mock not configured");
  }),
  placeForceOrder: mock(async () => {
    throw new Error("placeForceOrder mock not configured");
  })
};

mock.module("../src/lib/snaptrade", () => ({
  snaptrade: {
    trading: tradingMocks
  }
}));

import { registerEquityRoutes } from "../src/routes/equity";

function createApp() {
  const app = new Hono();
  registerEquityRoutes(app);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(tradingMocks)) {
    fn.mockReset();
    fn.mockImplementation(async () => {
      throw new Error("mock not configured");
    });
  }
});

afterAll(() => {
  // no-op; env is read-only for tests
});

describe("equity routes", () => {
  it("runs order impact and propagates headers", async () => {
    const accountId = "11111111-2222-4333-8aaa-555555555555";
    const responseBody = { trade: { id: "trade-123" } };

    tradingMocks.getOrderImpact.mockImplementation(async (payload) => {
      expect(payload.userId).toBe("snap-user");
      expect(payload.userSecret).toBe("snap-secret");
      expect(payload.account_id).toBe(accountId);
      expect(payload.action).toBe("SELL");
      expect(payload.order_type).toBe("Market");
      expect(payload.time_in_force).toBe("Day");
      expect(payload.symbol).toBe("AAPL");
      expect(payload.universal_symbol_id).toBeUndefined(); // symbol takes precedence
      expect(payload.units).toBeUndefined();
      expect(payload.notional_value).toBe(25);
      expect(payload.price).toBeUndefined();
      expect(payload.stop).toBeUndefined();
      return {
        data: responseBody,
        headers: {
          get: (key: string) => {
            const lower = key.toLowerCase();
            if (lower === "x-request-id") return "req-imp";
            if (lower === "x-ratelimit-limit") return "100";
            return undefined;
          }
        }
      };
    });

    const app = createApp();
    const res = await app.request("/equity/impact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.COINAGE_TS_SHARED_SECRET ? { "X-Coinage-TS-Secret": env.COINAGE_TS_SHARED_SECRET } : {})
      },
      body: JSON.stringify({
        accountId,
        userId: "snap-user",
        userSecret: "snap-secret",
        action: "SELL",
        orderType: "Market",
        timeInForce: "Day",
        symbol: "AAPL",
        notionalValue: "25"
      })
    });

    const body = await res.json();
    if (res.status !== 200) {
      console.error("impact error body", body);
    }
    expect(res.status).toBe(200);
    expect(body).toEqual(responseBody);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-imp");
    expect(res.headers.get("X-SnapTrade-RateLimit-Limit")).toBe("100");
    expect(tradingMocks.getOrderImpact.mock.calls.length).toBe(1);
  });

  it("runs place and normalizes numeric strings", async () => {
    const accountId = "22222222-3333-4444-8bbb-666666666666";
    const responseBody = { brokerage_order_id: "bo-1", status: "submitted" };

    tradingMocks.placeForceOrder.mockImplementation(async (payload) => {
      expect(payload.account_id).toBe(accountId);
      expect(payload.action).toBe("BUY");
      expect(payload.notional_value).toBe(50); // string -> number
      expect(payload.price).toBeUndefined();
      expect(payload.stop).toBeUndefined();
      return {
        data: responseBody,
        headers: {
          get: (key: string) => {
            const lower = key.toLowerCase();
            if (lower === "x-request-id") return "req-place";
            return undefined;
          }
        }
      };
    });

    const app = createApp();
    const res = await app.request("/equity/place", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.COINAGE_TS_SHARED_SECRET ? { "X-Coinage-TS-Secret": env.COINAGE_TS_SHARED_SECRET } : {})
      },
      body: JSON.stringify({
        accountId,
        userId: "snap-user",
        userSecret: "snap-secret",
        action: "BUY",
        orderType: "Market",
        timeInForce: "Day",
        symbol: "AAPL",
        notionalValue: "50"
      })
    });

    const body = await res.json();
    if (res.status !== 200) {
      console.error("place error body", body);
    }
    expect(res.status).toBe(200);
    expect(body).toEqual(responseBody);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-place");
    expect(tradingMocks.placeForceOrder.mock.calls.length).toBe(1);
  });

  it("enforces shared secret when configured", async () => {
    // Only run if a shared secret is configured; otherwise auth is disabled.
    if (env.COINAGE_TS_SHARED_SECRET) {
      const app = createApp();
      const res = await app.request("/equity/impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // missing secret header
        body: JSON.stringify({
          accountId: "33333333-4444-4555-8ccc-777777777777",
          userId: "snap-user",
          userSecret: "snap-secret",
          action: "BUY",
          orderType: "Market",
          timeInForce: "Day",
          symbol: "MSFT",
          units: 1
        })
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("unauthorized");
    }
  });

  it("rejects invalid payloads with 400", async () => {
    const app = createApp();
    const res = await app.request("/equity/place", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.COINAGE_TS_SHARED_SECRET ? { "X-Coinage-TS-Secret": env.COINAGE_TS_SHARED_SECRET } : {})
      },
      body: JSON.stringify({
        // missing accountId/userId/userSecret, etc.
        action: "BUY",
        orderType: "Market",
        timeInForce: "Day",
        symbol: "AAPL"
      })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("validation_error");
  });
});
