import { z } from "zod";

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
export const orderSchema = z.object({
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
  amount: z.string().min(1),
  limit_price: z.string().optional(),
  stop_price: z.string().optional(),
  post_only: z.boolean().optional(),
  expiration_date: z.string().datetime({ offset: true }).optional()
});

export type PairQuery = z.infer<typeof pairQuerySchema>;
export type QuoteQuery = z.infer<typeof quoteQuerySchema>;
export type OrderPayload = z.infer<typeof orderSchema>;
