import type { Hono } from "hono";
import type { Context } from "hono";
import { ZodError, type ZodType } from "zod";
import { snaptrade } from "../lib/snaptrade";
import { PerKeyRateLimiter } from "../lib/rateLimiter";
import { OrderPayload, PairQuery, QuoteQuery, orderSchema, pairQuerySchema, quoteQuerySchema } from "../schemas/crypto";
import { handleSnaptradeError, propagateRateLimitHeaders, unwrapSnaptradeResponse, validationError } from "../utils/snaptrade";

// Enforce one trade per second per account to align with SnapTrade guidance.
const tradingLimiter = new PerKeyRateLimiter(1_000);

/**
 * Registers all crypto-related endpoints on the supplied Hono application.
 * Each handler focuses on validation and translating to the SnapTrade SDK,
 * leaving error shaping and rate limiting to small helpers.
 */
export function registerCryptoRoutes(app: Hono) {
  app.get("/crypto/pairs", async (c) => {
    const paramsResult = parseQuery<PairQuery>(c, pairQuerySchema);
    if (paramsResult instanceof Response) {
      return paramsResult;
    }
    const params = paramsResult;
    const user = userSnippet(params.userId);
    const account = accountSnippet(params.accountId);
    // Emit a lightweight log so we can trace pair discovery issues without logging secrets.
    logInfo("snaptrade.crypto.search.request", {
      user,
      account,
      base: params.base ?? null,
      quote: params.quote ?? null
    });

    try {
      const result = await snaptrade.trading.searchCryptocurrencyPairInstruments({
        accountId: params.accountId,
        userId: params.userId,
        userSecret: params.userSecret,
        base: params.base,
        quote: params.quote
      });

      const { data, requestId, headers } = unwrapSnaptradeResponse(result);
      propagateRequestId(c, requestId);
      propagateRateLimitHeaders(c, headers);
      // Pair count is enough for debugging; avoid logging entire payload to keep logs lean.
      logInfo("snaptrade.crypto.search.response", {
        user,
        account,
        count: Array.isArray(data) ? data.length : undefined,
        requestId
      });
      return c.json(data);
    } catch (error) {
      logWarn("snaptrade.crypto.search.error", { user, account, message: (error as Error)?.message });
      return handleSnaptradeError(c, error);
    }
  });

  app.get("/crypto/quote", async (c) => {
    const paramsResult = parseQuery<QuoteQuery>(c, quoteQuerySchema);
    if (paramsResult instanceof Response) {
      return paramsResult;
    }
    const params = paramsResult;
    const user = userSnippet(params.userId);
    const account = accountSnippet(params.accountId);
    logInfo("snaptrade.crypto.quote.request", {
      user,
      account,
      pair: params.instrumentSymbol
    });

    try {
      const result = await snaptrade.trading.getCryptocurrencyPairQuote({
        accountId: params.accountId,
        instrumentSymbol: params.instrumentSymbol,
        userId: params.userId,
        userSecret: params.userSecret
      });

      const { data, requestId, headers } = unwrapSnaptradeResponse(result);
      propagateRequestId(c, requestId);
      propagateRateLimitHeaders(c, headers);
      logInfo("snaptrade.crypto.quote.response", {
        user,
        account,
        pair: params.instrumentSymbol,
        requestId
      });
      return c.json(data);
    } catch (error) {
      logWarn("snaptrade.crypto.quote.error", { user, account, message: (error as Error)?.message });
      return handleSnaptradeError(c, error);
    }
  });

  app.post("/crypto/preview", async (c) => {
    const payloadResult = await parseJsonBody<OrderPayload>(c, orderSchema);
    if (payloadResult instanceof Response) {
      return payloadResult;
    }
    const payload = payloadResult;
    const user = userSnippet(payload.userId);
    const account = accountSnippet(payload.accountId);
    // Include the sanitized order metadata so we can correlate Bun + Java logs by event id.
    logInfo("snaptrade.crypto.preview.request", {
      user,
      account,
      ...summarizeOrder(payload)
    });

    try {
      const result = await snaptrade.trading.previewCryptoOrder({
        accountId: payload.accountId,
        userId: payload.userId,
        userSecret: payload.userSecret,
        requestBody: buildOrderRequest(payload)
      });

      const { data, requestId, headers } = unwrapSnaptradeResponse(result);
      propagateRequestId(c, requestId);
      propagateRateLimitHeaders(c, headers);
      logInfo("snaptrade.crypto.preview.response", {
        user,
        account,
        requestId,
        feeAmount: (data as any)?.estimated_fee?.amount ?? null,
        feeCurrency: (data as any)?.estimated_fee?.currency ?? null
      });
      return c.json(data);
    } catch (error) {
      logWarn("snaptrade.crypto.preview.error", { user, account, message: (error as Error)?.message });
      return handleSnaptradeError(c, error);
    }
  });

  app.post("/crypto/place", async (c) => {
    const payloadResult = await parseJsonBody<OrderPayload>(c, orderSchema);
    if (payloadResult instanceof Response) {
      return payloadResult;
    }
    const payload = payloadResult;
    const user = userSnippet(payload.userId);
    const account = accountSnippet(payload.accountId);
    logInfo("snaptrade.crypto.place.request", {
      user,
      account,
      ...summarizeOrder(payload)
    });

    const limiterKey = `${payload.accountId}:${payload.userId}`;
    const limiterResult = tradingLimiter.tryAcquire(limiterKey);

    if (!limiterResult.allowed) {
      logWarn("snaptrade.crypto.place.rate_limited", {
        user,
        account,
        retryAfterMs: limiterResult.retryAfterMs
      });
      // Returning HTTP 429 makes the retry semantics explicit for callers.
      c.header("Retry-After", Math.max(1, Math.ceil(limiterResult.retryAfterMs / 1000)).toString());
      return c.json(
        {
          error: "rate_limited",
          message: "Crypto order placement is limited to one request per second per account.",
          retryAfterMs: limiterResult.retryAfterMs
        },
        429
      );
    }

    try {
      const result = await snaptrade.trading.placeCryptoOrder({
        accountId: payload.accountId,
        userId: payload.userId,
        userSecret: payload.userSecret,
        requestBody: buildOrderRequest(payload)
      });

      const { data, requestId, headers } = unwrapSnaptradeResponse(result);
      propagateRequestId(c, requestId);
      propagateRateLimitHeaders(c, headers);
      const orderNode = (data as any)?.order ?? data;
      logInfo("snaptrade.crypto.place.response", {
        user,
        account,
        requestId,
        brokerageOrderId: orderNode?.brokerage_order_id ?? orderNode?.id ?? null,
        status: orderNode?.status ?? null
      });
      return c.json(data);
    } catch (error) {
      logWarn("snaptrade.crypto.place.error", { user, account, message: (error as Error)?.message });
      return handleSnaptradeError(c, error);
    }
  });
}

/**
 * Testing hook to clear per-account rate-limit state between specs.
 */
export function resetCryptoRateLimiterForTests() {
  tradingLimiter.reset();
}

/**
 * SnapTrade surfaces a partner-facing request id in the response headers.
 * Returning it to our caller makes debugging brokerage escalations easier.
 */
function propagateRequestId(c: Context, requestId: string | undefined) {
  if (requestId) {
    c.header("X-SnapTrade-Request-ID", requestId);
  }
}

/**
 * Build the JSON payload forwarded to SnapTrade, dropping undefined optional
 * fields so the SDK produces the leanest possible request body.
 */
function buildOrderRequest(payload: OrderPayload) {
  return {
    instrument: payload.instrument,
    side: payload.side,
    type: payload.type,
    time_in_force: payload.time_in_force,
    amount: payload.amount,
    ...(payload.limit_price !== undefined ? { limit_price: payload.limit_price } : {}),
    ...(payload.stop_price !== undefined ? { stop_price: payload.stop_price } : {}),
    ...(payload.post_only !== undefined ? { post_only: payload.post_only } : {}),
    ...(payload.expiration_date !== undefined ? { expiration_time: payload.expiration_date } : {})
  };
}

/**
 * Shared query parsing helper used by the GET endpoints. When validation fails
 * the resulting HTTP response is returned directly to the caller.
 *
 * Hono exposes query parameters as `URLSearchParams`, but Zod expects a plain
 * record of strings. We normalize before validation so callers can reliably
 * send repeated keys (we keep the first value) without tripping the schema.
 */
function parseQuery<T>(c: Context, schema: ZodType<T, any, any>): T | Response {
  const raw = c.req.query();
  const normalized = normalizeQueryParams(raw);
  const parsed = schema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }
  return validationError(c, parsed.error);
}

/**
 * Converts the heterogeneous query parameter shapes that Hono hands us
 * (`URLSearchParams`, array values from Node-style objects, or plain records)
 * into the `{ [key]: string }` map format that Zod expects.
 *
 * - When a parameter appears multiple times (e.g. `?foo=a&foo=b`) we retain the
 *   first occurrence so callers don't accidentally send arrays to SnapTrade.
 * - For Node/Express-style objects we collapse `string[]` values the same way.
 * - Anything else (numbers, booleans, nullish) is skipped to keep validation strict.
 */
function normalizeQueryParams(params: unknown): Record<string, string> {
  if (!params) {
    return {};
  }

  const normalized: Record<string, string> = {};

  if (params instanceof URLSearchParams) {
    for (const [key, value] of params.entries()) {
      if (!(key in normalized)) {
        normalized[key] = value;
      }
    }
    return normalized;
  }

  if (typeof params !== "object") {
    return normalized;
  }

  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      normalized[key] = value[0];
    }
  }

  return normalized;
}

function summarizeOrder(payload: OrderPayload) {
  // Strip potentially large or sensitive fields before logging; only structural data remains.
  return {
    pair: payload.instrument.symbol,
    side: payload.side,
    orderType: payload.type,
    tif: payload.time_in_force,
    amount: payload.amount,
    limitPrice: payload.limit_price ?? null,
    stopPrice: payload.stop_price ?? null,
    postOnly: payload.post_only ?? null
  };
}

function userSnippet(userId: string) {
  return userId.slice(-6);
}

function accountSnippet(accountId: string) {
  return accountId.slice(0, 8);
}

function logInfo(event: string, meta: Record<string, unknown>) {
  // JSON logs make it easier to search in Fly/Datadog; fall back to console formatting if stringify fails.
  try {
    console.info(JSON.stringify({ event, ...meta, timestamp: new Date().toISOString() }));
  } catch {
    console.info(event, meta);
  }
}

function logWarn(event: string, meta: Record<string, unknown>) {
  // Mirror logInfo but write to stderr so warnings/errors pop in aggregated logs.
  try {
    console.warn(JSON.stringify({ event, ...meta, timestamp: new Date().toISOString() }));
  } catch {
    console.warn(event, meta);
  }
}

/**
 * Parses and validates JSON bodies for POST endpoints. Any parsing or schema
 * issues are surfaced to the client through a standardised error shape.
 */
async function parseJsonBody<T>(c: Context, schema: ZodType<T, any, any>): Promise<T | Response> {
  try {
    const raw = await c.req.json();
    return schema.parse(raw) as T;
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(c, error);
    } else {
      return c.json(
        {
          error: "invalid_json",
          message: "Unable to parse request body"
        },
        400
      );
    }
  }
}
