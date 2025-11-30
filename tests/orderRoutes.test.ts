import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { env } from "../src/lib/env";
import { registerOrderRoutes } from "../src/routes/orders";

const accountInformationMocks = {
  getUserAccountOrderDetail: mock(async () => {
    throw new Error("getUserAccountOrderDetail mock not configured");
  })
};

mock.module("../src/lib/snaptrade", () => ({
  snaptrade: {
    accountInformation: accountInformationMocks
  }
}));

function createApp() {
  const app = new Hono();
  registerOrderRoutes(app);
  return app;
}

const originalSharedSecret = env.COINAGE_TS_SHARED_SECRET;

beforeEach(() => {
  (env as any).COINAGE_TS_SHARED_SECRET = originalSharedSecret;
  for (const fn of Object.values(accountInformationMocks)) {
    fn.mockReset();
    fn.mockImplementation(async () => {
      throw new Error("mock not configured");
    });
  }
});

afterAll(() => {
  (env as any).COINAGE_TS_SHARED_SECRET = originalSharedSecret;
});

describe("order detail route", () => {
  it("returns order detail and propagates SnapTrade headers", async () => {
    const payload = {
      accountId: "11111111-2222-4333-8aaa-555555555555",
      userId: "snap-user",
      userSecret: "snap-secret",
      brokerage_order_id: "ord-123"
    };

    accountInformationMocks.getUserAccountOrderDetail.mockImplementation(async (req: any) => {
      expect(req.accountId).toBe(payload.accountId);
      expect(req.userId).toBe(payload.userId);
      expect(req.userSecret).toBe(payload.userSecret);
      expect(req.brokerage_order_id).toBe(payload.brokerage_order_id);
      const headers = {
        get: (key: string) => {
          const lower = key.toLowerCase();
          if (lower === "x-request-id") return "req-order";
          if (lower === "x-ratelimit-limit") return "50";
          if (lower === "x-ratelimit-remaining") return "49";
          if (lower === "x-ratelimit-reset") return "1700000000";
          return undefined;
        }
      };
      return {
        data: {
          execution_price: 12.34,
          filled_quantity: "1.50",
          status: "EXECUTED"
        },
        headers
      };
    });

    const app = createApp();
    const res = await app.request("/orders/detail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      execution_price: 12.34,
      filled_quantity: "1.50",
      status: "EXECUTED"
    });
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-order");
    expect(res.headers.get("X-SnapTrade-RateLimit-Limit")).toBe("50");
    expect(res.headers.get("X-SnapTrade-RateLimit-Remaining")).toBe("49");
    expect(res.headers.get("X-SnapTrade-RateLimit-Reset")).toBe("1700000000");
    expect(accountInformationMocks.getUserAccountOrderDetail.mock.calls.length).toBe(1);
  });

  it("rejects when shared secret is missing", async () => {
    (env as any).COINAGE_TS_SHARED_SECRET = "bridge-secret";
    const app = createApp();
    const res = await app.request("/orders/detail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: "11111111-2222-4333-8aaa-555555555555",
        userId: "snap-user",
        userSecret: "snap-secret",
        brokerage_order_id: "ord-123"
      })
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(accountInformationMocks.getUserAccountOrderDetail.mock.calls.length).toBe(0);
  });

  it("returns 400 on validation errors", async () => {
    const app = createApp();
    const res = await app.request("/orders/detail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}) // missing required fields
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
    expect(accountInformationMocks.getUserAccountOrderDetail.mock.calls.length).toBe(0);
  });
});
