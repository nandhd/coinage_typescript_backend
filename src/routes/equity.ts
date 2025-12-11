import type { Hono } from "hono";
import type { Context } from "hono";
import { ZodError, type ZodType } from "zod";
import { snaptrade } from "../lib/snaptrade";
import { env } from "../lib/env";
import { equityOrderSchema, type EquityOrderPayload } from "../schemas/equity";
import { handleSnaptradeError, propagateRateLimitHeaders, unwrapSnaptradeResponse, validationError } from "../utils/snaptrade";

/**
 * Registers equity trading routes (impact + place) that proxy to SnapTrade via the TypeScript SDK.
 * These mirror the crypto routes: shared-secret auth, strict validation, and response header passthrough.
 */
export function registerEquityRoutes(app: Hono) {
  // Build marker to confirm deployed version in logs.
  logInfo("snaptrade.equity.bridge.build", {
    marker: "ts-equity-bridge-2025-12-11-01"
  });

  // Shared-secret guard for all equity endpoints to prevent public access.
  app.use("/equity/*", async (c, next) => {
    const secret = env.COINAGE_TS_SHARED_SECRET;
    if (!secret) {
      return next();
    }
    const provided = c.req.header("X-Coinage-TS-Secret");
    if (provided !== secret) {
      logWarn("snaptrade.equity.auth.error", { route: c.req.path, reason: "missing_or_invalid_secret" });
      return c.json(
        {
          error: "unauthorized",
          message: "Missing or invalid shared secret."
        },
        401
      );
    }
    return next();
  });

  // Order impact (pre-check) endpoint.
  app.post("/equity/impact", async (c) => {
    const payloadResult = await parseJsonBody<EquityOrderPayload>(c, equityOrderSchema);
    if (payloadResult instanceof Response) {
      return payloadResult;
    }
    const payload = payloadResult;
    const user = userSnippet(payload.userId);
    const account = accountSnippet(payload.accountId);
    logInfo("snaptrade.equity.impact.request", {
      user,
      account,
      symbol: payload.symbol ?? null,
      universalSymbolId: payload.universalSymbolId ?? null,
      orderType: payload.orderType,
      timeInForce: payload.timeInForce,
      units: payload.units ?? null,
      notional: payload.notionalValue ?? null
    });

    try {
      const body = buildManualTradeForm(payload);
      const result = await snaptrade.trading.getOrderImpact({
        userId: payload.userId,
        userSecret: payload.userSecret,
        manualTradeForm: body
      });

      const { data, requestId, headers } = unwrapSnaptradeResponse(result);
      propagateRequestId(c, requestId);
      propagateRateLimitHeaders(c, headers);
      logInfo("snaptrade.equity.impact.response", {
        user,
        account,
        requestId,
        tradeId: (data as any)?.trade?.id ?? null
      });
      return c.json(data);
    } catch (error) {
      logWarn("snaptrade.equity.impact.error", { user, account, message: (error as Error)?.message });
      return handleSnaptradeError(c, error);
    }
  });

  // Direct placement endpoint (placeForceOrder).
  app.post("/equity/place", async (c) => {
    const payloadResult = await parseJsonBody<EquityOrderPayload>(c, equityOrderSchema);
    if (payloadResult instanceof Response) {
      return payloadResult;
    }
    const payload = payloadResult;
    const user = userSnippet(payload.userId);
    const account = accountSnippet(payload.accountId);
    logInfo("snaptrade.equity.place.request", {
      user,
      account,
      symbol: payload.symbol ?? null,
      universalSymbolId: payload.universalSymbolId ?? null,
      orderType: payload.orderType,
      timeInForce: payload.timeInForce,
      units: payload.units ?? null,
      notional: payload.notionalValue ?? null
    });

    try {
      const body = buildManualTradeForm(payload);
      const result = await snaptrade.trading.placeForceOrder({
        userId: payload.userId,
        userSecret: payload.userSecret,
        manualTradeFormWithOptions: body
      });

      const { data, requestId, headers } = unwrapSnaptradeResponse(result);
      propagateRequestId(c, requestId);
      propagateRateLimitHeaders(c, headers);
      logInfo("snaptrade.equity.place.response", {
        user,
        account,
        requestId,
        brokerageOrderId: (data as any)?.brokerage_order_id ?? null,
        status: (data as any)?.status ?? null
      });
      return c.json(data);
    } catch (error) {
      logWarn("snaptrade.equity.place.error", { user, account, message: (error as Error)?.message });
      return handleSnaptradeError(c, error);
    }
  });
}

/**
 * Build a lean ManualTradeFormWithOptions payload, omitting undefined fields so
 * we send the smallest possible body to SnapTrade.
 */
function buildManualTradeForm(payload: EquityOrderPayload) {
  const toNumber = (v: unknown) => (typeof v === "string" ? Number(v) : v);
  return {
    account_id: payload.accountId,
    action: payload.action,
    order_type: payload.orderType,
    time_in_force: payload.timeInForce,
    trading_session: payload.tradingSession,
    ...(payload.universalSymbolId ? { universal_symbol_id: payload.universalSymbolId } : {}),
    ...(payload.symbol ? { symbol: payload.symbol } : {}),
    ...(payload.units !== undefined ? { units: payload.units } : {}),
    // SnapTrade accepts number|string for notional_value; normalize strings to numbers for consistency.
    ...(payload.notionalValue !== undefined ? { notional_value: toNumber(payload.notionalValue) } : {}),
    ...(payload.price !== undefined ? { price: toNumber(payload.price) } : {}),
    ...(payload.stop !== undefined ? { stop: toNumber(payload.stop) } : {}),
    // The SDK does not expose clientEventId/clientOrderId for equities; keep request lean.
  };
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

function propagateRequestId(c: Context, requestId: string | undefined) {
  if (requestId) {
    c.header("X-SnapTrade-Request-ID", requestId);
  }
}

function userSnippet(userId: string) {
  return userId.slice(-6);
}

function accountSnippet(accountId: string) {
  return accountId.slice(0, 8);
}

function logInfo(event: string, meta: Record<string, unknown>) {
  try {
    console.info(JSON.stringify({ event, ...meta, timestamp: new Date().toISOString() }));
  } catch {
    console.info(event, meta);
  }
}

function logWarn(event: string, meta: Record<string, unknown>) {
  try {
    console.warn(JSON.stringify({ event, ...meta, timestamp: new Date().toISOString() }));
  } catch {
    console.warn(event, meta);
  }
}
