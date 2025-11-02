import type { Hono } from "hono";
import type { Context } from "hono";
import { ZodError, type ZodType } from "zod";
import { snaptrade } from "../lib/snaptrade";
import { PerKeyRateLimiter } from "../lib/rateLimiter";
import { OrderPayload, PairQuery, QuoteQuery, orderSchema, pairQuerySchema, quoteQuerySchema } from "../schemas/crypto";
import {
  handleSnaptradeError,
  unwrapSnaptradeResponse,
  validationError,
  propagateRateLimitHeaders
} from "../utils/snaptrade";

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
      markNonCacheable(c);
      return c.json(data);
    } catch (error) {
      return handleSnaptradeError(c, error);
    }
  });

  app.get("/crypto/quote", async (c) => {
    const paramsResult = parseQuery<QuoteQuery>(c, quoteQuerySchema);
    if (paramsResult instanceof Response) {
      return paramsResult;
    }
    const params = paramsResult;

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
      markNonCacheable(c);
      return c.json(data);
    } catch (error) {
      return handleSnaptradeError(c, error);
    }
  });

  app.post("/crypto/preview", async (c) => {
    const payloadResult = await parseJsonBody<OrderPayload>(c, orderSchema);
    if (payloadResult instanceof Response) {
      return payloadResult;
    }
    const payload = payloadResult;

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
      markNonCacheable(c);
      return c.json(data);
    } catch (error) {
      return handleSnaptradeError(c, error);
    }
  });

  app.post("/crypto/place", async (c) => {
    const payloadResult = await parseJsonBody<OrderPayload>(c, orderSchema);
    if (payloadResult instanceof Response) {
      return payloadResult;
    }
    const payload = payloadResult;

    const limiterKey = `${payload.accountId}:${payload.userId}`;
    const limiterResult = tradingLimiter.tryAcquire(limiterKey);

    if (!limiterResult.allowed) {
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
      markNonCacheable(c);
      return c.json(data);
    } catch (error) {
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
    limit_price: payload.limit_price,
    stop_price: payload.stop_price,
    post_only: payload.post_only,
    expiration_date: payload.expiration_date
  };
}

/**
 * Shared query parsing helper used by the GET endpoints. When validation fails
 * the resulting HTTP response is returned directly to the caller.
 */
function parseQuery<T>(c: Context, schema: ZodType<T, any, any>): T | Response {
  const parsed = schema.safeParse(normalizeQueryParams(c.req.query()));
  if (parsed.success) {
    return parsed.data;
  }

  return validationError(c, parsed.error);
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

function normalizeQueryParams(params: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      // Hono hands multi-value params in array form (even when there is only one
      // entry). SnapTrade expects a single string, so we collapse to the first
      // element to keep validation predictable.
      normalized[key] = value[0];
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

function markNonCacheable(c: Context) {
  c.header("Cache-Control", "no-store");
}
