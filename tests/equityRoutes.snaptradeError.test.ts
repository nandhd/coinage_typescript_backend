import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { env } from "../src/lib/env";

/**
 * Regression test for a production incident (Jan 27, 2026):
 * - SnapTrade rejected a Webull order with HTTP 400 and a body containing `raw_error.body.error_code`.
 * - The SnapTrade TS SDK threw a non-Axios `SnaptradeError` instance with fields like `status` and `responseBody`.
 * - Our bridge previously ONLY handled Axios-like errors, so we fell back to a synthetic 500 and lost the raw body.
 * - The Java backend then could not map the error to `WEBULL_FRACTIONAL_AGREEMENT_REQUIRED` (412) and could not
 *   send the "Action needed" email containing the Webull agreement URL.
 *
 * This test ensures we preserve:
 * - The upstream status code (400),
 * - The raw SnapTrade JSON body (code/detail/raw_error),
 * - The request id header propagation (X-Request-ID + X-SnapTrade-Request-ID),
 * so downstream (Java) error mapping remains correct.
 */

const tradingMocks = {
  getOrderImpact: mock(async () => {
    throw new Error("getOrderImpact mock not configured");
  }),
  placeForceOrder: mock(async () => {
    throw new Error("placeForceOrder mock not configured");
  }),
  placeOrder: mock(async () => {
    throw new Error("placeOrder mock not configured");
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

const originalSharedSecret = env.COINAGE_TS_SHARED_SECRET;

beforeEach(() => {
  /**
   * Make this test environment-independent.
   *
   * Some environments (CI/dev) set `COINAGE_TS_SHARED_SECRET`, which enables the auth middleware
   * in `registerEquityRoutes` and would cause requests that do not include `X-Coinage-TS-Secret`
   * to be rejected with 401 *before* they reach `handleSnaptradeError`.
   *
   * For this suite we want to exercise the error-mapping logic, not auth behavior, so we force the
   * secret to an empty string (falsy) which disables the middleware for the duration of the test.
   */
  (env as any).COINAGE_TS_SHARED_SECRET = "";
  for (const fn of Object.values(tradingMocks)) {
    fn.mockReset();
    fn.mockImplementation(async () => {
      throw new Error("mock not configured");
    });
  }
});

afterAll(() => {
  (env as any).COINAGE_TS_SHARED_SECRET = originalSharedSecret;
});

describe("equity routes - SnaptradeError shape", () => {
  it("returns raw SnapTrade error JSON for SDK SnaptradeError (non-Axios) and propagates request id", async () => {
    const agreementUrl =
      "https://sp.webull.com/agreement/third-party?bizTypes=TRADE_FRACT_PRO&secAccountId=26616805&hl=en";
    const responseBody = {
      detail: `Trade 28b655ac-7379-4368-807c-a749e86ff504: Order rejected by brokerage - ${agreementUrl}`,
      status_code: 400,
      code: "1119",
      raw_error: {
        body: {
          message: agreementUrl,
          error_code: "OAUTH_OPENAPI_OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE"
        }
      }
    };

    // Simulate the SnapTrade TS SDK error class by throwing an object with:
    // - `status` (HTTP status),
    // - `headers` (contains x-request-id),
    // - `responseBody` (raw SnapTrade error JSON).
    //
    // NOTE: In production the SDK throws an actual class instance, but the bridge should
    // not rely on `instanceof` — we only require a stable shape.
    tradingMocks.placeForceOrder.mockImplementation(async () => {
      const err: any = new Error("Request failed with status code 400");
      err.status = 400;
      err.headers = {
        get: (key: string) => {
          if (key.toLowerCase() === "x-request-id") return "eccc15510721ac92952fdc730a232bc2";
          return undefined;
        }
      };
      err.responseBody = responseBody;
      throw err;
    });

    const payload = {
      accountId: "c3941b53-93f2-4396-9e8e-deb47dab2108",
      userId: "37f3c539-5cac-4aa7-ac63-a2b935319c21",
      userSecret: "snap-secret",
      action: "BUY",
      symbol: "SLV",
      orderType: "Market",
      timeInForce: "Day",
      notionalValue: 5.5
    };

    const app = createApp();
    const res = await app.request("/equity/place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(responseBody);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("eccc15510721ac92952fdc730a232bc2");
    expect(res.headers.get("X-Request-ID")).toBe("eccc15510721ac92952fdc730a232bc2");
    expect(tradingMocks.placeForceOrder.mock.calls.length).toBe(1);
  });
});
