import type { Hono } from "hono";
import { ZodError, type ZodType } from "zod";
import type { Context } from "hono";
import { snaptrade } from "../lib/snaptrade";
import { env } from "../lib/env";
import { orderDetailSchema, type OrderDetailPayload } from "../schemas/orderDetail";
import { handleSnaptradeError, propagateRateLimitHeaders, unwrapSnaptradeResponse, validationError } from "../utils/snaptrade";

/**
 * Registers order-detail endpoints used by the Java backend to fetch fill
 * details (execution price/quantity) for SnapTrade-placed orders.
 */
export function registerOrderRoutes(app: Hono) {
  app.use("/orders/*", async (c, next) => {
    const secret = env.COINAGE_TS_SHARED_SECRET;
    if (!secret) {
      return next();
    }
    const provided = c.req.header("X-Coinage-TS-Secret");
    if (provided !== secret) {
      logWarn("snaptrade.order_detail.auth.error", { route: c.req.path, reason: "missing_or_invalid_secret" });
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

  // SnapTrade order detail proxy. Used by the Java confirmation worker to fetch
  // execution price/quantity for a single brokerage order id.
  app.post("/orders/detail", async (c) => {
    const payloadResult = await parseJsonBody<OrderDetailPayload>(c, orderDetailSchema);
    if (payloadResult instanceof Response) {
      return payloadResult;
    }
    const payload = payloadResult;
    const user = userSnippet(payload.userId);
    const account = accountSnippet(payload.accountId);

    logInfo("snaptrade.order_detail.request", {
      user,
      account,
      brokerageOrderId: payload.brokerage_order_id
    });

    try {
      const result = await snaptrade.accountInformation.getUserAccountOrderDetail({
        accountId: payload.accountId,
        userId: payload.userId,
        userSecret: payload.userSecret,
        brokerage_order_id: payload.brokerage_order_id
      });

      // SDK sometimes returns `{ data, headers }`, other times raw data; normalize.
      const { data, requestId, headers } = unwrapSnaptradeResponse(result);
      if (requestId) {
        c.header("X-SnapTrade-Request-ID", requestId);
      }
      propagateRateLimitHeaders(c, headers);
      logInfo("snaptrade.order_detail.response", {
        user,
        account,
        requestId,
        status: (data as any)?.status ?? null
      });
      return c.json(data);
    } catch (error) {
      logWarn("snaptrade.order_detail.error", {
        user,
        account,
        message: (error as Error)?.message
      });
      return handleSnaptradeError(c, error);
    }
  });
}

/**
 * Parses and validates JSON bodies for POST endpoints. Any parsing or schema
 * issues are surfaced to the client through a standardised error shape.
 */
async function parseJsonBody<T>(c: Context, schema: ZodType<T, any, any>): Promise<T | Response> {
  try {
    const raw = await c.req.json(); // honor Hono's native JSON parser to avoid body rewind issues
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
