import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { env } from "../src/lib/env";

/**
 * Regression coverage for `handleSnaptradeError` on CRYPTO routes.
 *
 * Why this test exists:
 * - The SnapTrade TS SDK can throw a custom `SnaptradeError` (non-Axios shape).
 * - Historically our bridge only handled Axios-like errors, which caused us to return a synthetic 500.
 * - Returning 500 breaks downstream mapping (Java expects SnapTrade's raw `{ code, detail, raw_error }`)
 *   and also breaks rate-limit/backoff behaviors (Retry-After, x-request-id correlation, etc.).
 *
 * This suite ensures the crypto routes preserve:
 * - Upstream HTTP status code from SnapTrade,
 * - Raw SnapTrade error payload (object or JSON string),
 * - SnapTrade request id header propagation (X-SnapTrade-Request-ID + X-Request-ID),
 * - Optional retry-after propagation when present.
 */

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

const originalSharedSecret = env.COINAGE_TS_SHARED_SECRET;

beforeEach(() => {
  resetCryptoRateLimiterForTests();
  /**
   * Make this test environment-independent.
   *
   * In CI/dev, `COINAGE_TS_SHARED_SECRET` may be set, which enables the `/crypto/*` auth middleware
   * and would cause these requests (which intentionally omit `X-Coinage-TS-Secret`) to return 401.
   *
   * This suite is specifically validating `handleSnaptradeError` for SnapTrade SDK error shapes,
   * so we disable the middleware by forcing the secret to a falsy value for the duration of each test.
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

describe("crypto routes - SnaptradeError shape", () => {
  it("returns raw error JSON + status for SDK SnaptradeError (object responseBody)", async () => {
    const responseBody = {
      code: "1119",
      detail: "Order rejected by brokerage - https://example.com/remediation",
      raw_error: {
        body: {
          error_code: "SOME_BROKER_CODE",
          message: "https://example.com/remediation"
        }
      }
    };

    tradingMocks.getCryptocurrencyPairQuote.mockImplementation(async () => {
      const err: any = new Error("Request failed with status code 400");
      err.status = 400;
      err.headers = {
        get: (key: string) => {
          const lower = key.toLowerCase();
          if (lower === "x-request-id") return "req-crypto-1";
          if (lower === "retry-after") return "3";
          return undefined;
        }
      };
      err.responseBody = responseBody;
      throw err;
    });

    const app = createApp();
    const res = await app.request(
      "/crypto/quote?accountId=33333333-4444-4555-8ccc-777777777777&userId=snap-user&userSecret=snap-secret&instrumentSymbol=ETH-USD"
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(responseBody);
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-crypto-1");
    expect(res.headers.get("X-Request-ID")).toBe("req-crypto-1");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(tradingMocks.getCryptocurrencyPairQuote.mock.calls.length).toBe(1);
  });

  it("parses JSON-string responseBody for SDK SnaptradeError and returns object", async () => {
    const raw = JSON.stringify({
      code: "RATE_LIMITED",
      detail: "Too many requests",
      status_code: 429
    });

    tradingMocks.searchCryptocurrencyPairInstruments.mockImplementation(async () => {
      const err: any = new Error("Request failed with status code 429");
      err.statusCode = 429;
      err.headers = {
        get: (key: string) => {
          const lower = key.toLowerCase();
          if (lower === "x-request-id") return "req-crypto-2";
          if (lower === "retry-after") return "5";
          if (lower === "x-ratelimit-limit") return "250";
          if (lower === "x-ratelimit-remaining") return "0";
          if (lower === "x-ratelimit-reset") return "1769547000";
          return undefined;
        }
      };
      err.responseBody = raw;
      throw err;
    });

    const accountId = "11111111-2222-4333-8aaa-555555555555";
    const app = createApp();
    const res = await app.request(`/crypto/pairs?accountId=${accountId}&userId=snap-user&userSecret=snap-secret`);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      code: "RATE_LIMITED",
      detail: "Too many requests",
      status_code: 429
    });
    expect(res.headers.get("X-SnapTrade-Request-ID")).toBe("req-crypto-2");
    expect(res.headers.get("X-Request-ID")).toBe("req-crypto-2");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("X-SnapTrade-RateLimit-Limit")).toBe("250");
    expect(res.headers.get("X-SnapTrade-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-SnapTrade-RateLimit-Reset")).toBe("1769547000");
    expect(tradingMocks.searchCryptocurrencyPairInstruments.mock.calls.length).toBe(1);
  });
});
