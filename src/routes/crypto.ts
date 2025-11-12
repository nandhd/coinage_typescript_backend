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
