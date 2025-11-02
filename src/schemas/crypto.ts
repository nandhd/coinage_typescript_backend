import { z } from "zod";

type OrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP_LOSS_MARKET"
  | "STOP_LOSS_LIMIT"
  | "TAKE_PROFIT_MARKET"
  | "TAKE_PROFIT_LIMIT";

/**
 * Query params accepted by the cryptocurrency pair discovery endpoint.
 * SnapTrade expects the UUID of the linked account plus partner-level
 * identifiers for the user and their per-connection secret.
 */
export const pairQuerySchema = z.object({
  accountId: z.string().uuid(),
  userId: z.string().min(1),
  userSecret: z.string().min(1),
  base: z.string().optional(),
  quote: z.string().optional()
});

/**
 * Query params for retrieving a quote on a specific cryptocurrency pair.
 * The `instrumentSymbol` follows the SnapTrade format (e.g., "BTC-USD").
 */
export const quoteQuerySchema = z.object({
  accountId: z.string().uuid(),
  userId: z.string().min(1),
  userSecret: z.string().min(1),
  instrumentSymbol: z.string().min(1)
});

/**
 * Shared payload structure for order preview and placement requests.
 * The SnapTrade TypeScript SDK passes this object through to the API
 * without modification, so we validate every field up front.
 */
export const orderSchema = z
  .object({
    accountId: z.string().uuid(),
    userId: z.string().min(1),
    userSecret: z.string().min(1),
    instrument: z.object({
      symbol: z.string().min(1),
      type: z.literal("CRYPTOCURRENCY_PAIR")
    }),
    side: z.enum(["BUY", "SELL"]),
    type: z.enum([
      "MARKET",
      "LIMIT",
      "STOP_LOSS_MARKET",
      "STOP_LOSS_LIMIT",
      "TAKE_PROFIT_MARKET",
      "TAKE_PROFIT_LIMIT"
    ]),
    time_in_force: z.enum(["GTC", "FOK", "IOC", "GTD"]),
    // SnapTrade expects decimal values as strings; keep validation lightweight.
    amount: z
      .string()
      .min(1)
      .regex(/^[0-9]+(\.[0-9]+)?$/, "amount must be a decimal string"),
    limit_price: z
      .string()
      .regex(/^[0-9]+(\.[0-9]+)?$/, "limit_price must be a decimal string")
      .optional(),
    stop_price: z
      .string()
      .regex(/^[0-9]+(\.[0-9]+)?$/, "stop_price must be a decimal string")
      .optional(),
    post_only: z.boolean().optional(),
    expiration_date: z.string().datetime({ offset: true }).optional()
  })
  .superRefine((value, ctx) => {
    // SnapTrade requires a limit price for any order that could rest on the book.
    const needsLimit: OrderType[] = ["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"];
    if (needsLimit.includes(value.type) && !value.limit_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "limit_price is required for LIMIT and *_LIMIT orders",
        path: ["limit_price"]
      });
    }

    // STOP/TAKE_PROFIT orders always require a stop trigger in addition to the amount.
    const needsStop: OrderType[] = [
      "STOP_LOSS_MARKET",
      "STOP_LOSS_LIMIT",
      "TAKE_PROFIT_MARKET",
      "TAKE_PROFIT_LIMIT"
    ];
    if (needsStop.includes(value.type) && !value.stop_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stop_price is required for STOP_* and TAKE_PROFIT_* orders",
        path: ["stop_price"]
      });
    }

    // Post-only is only legal for limit orders that can rest; guard before hitting the API.
    if (value.post_only !== undefined && value.type !== "LIMIT") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "post_only is only valid for LIMIT orders",
        path: ["post_only"]
      });
    }

    // GTD orders must include an expiry timestamp.
    if (value.time_in_force === "GTD" && !value.expiration_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiration_date is required when time_in_force=GTD",
        path: ["expiration_date"]
      });
    }
  });

export type PairQuery = z.infer<typeof pairQuerySchema>;
export type QuoteQuery = z.infer<typeof quoteQuerySchema>;
export type OrderPayload = z.infer<typeof orderSchema>;
