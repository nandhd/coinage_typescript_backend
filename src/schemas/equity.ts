import { z } from "zod";

/**
 * Shared payload for equity order impact/place requests.
 * Mirrors SnapTrade ManualTradeFormWithOptions and adds validation
 * for mutual exclusivity (symbol vs universal id, units vs notional).
 */
export const equityOrderSchema = z
  .object({
    accountId: z.string().uuid(),
    userId: z.string().min(1),
    userSecret: z.string().min(1),
    action: z.enum(["BUY", "SELL"]),
    orderType: z.enum(["Market", "Limit", "Stop", "StopLimit"]),
    timeInForce: z.enum(["Day", "GTC", "FOK", "IOC"]),
    tradingSession: z.enum(["REGULAR", "EXTENDED"]).optional(),
    universalSymbolId: z.string().uuid().optional(),
    symbol: z.string().min(1).optional(),
    units: z
      .number()
      .finite()
      .nonnegative()
      .optional(),
    notionalValue: z
      .union([z.number().finite().nonnegative(), z.string().regex(/^[0-9]+(\.[0-9]+)?$/)])
      .optional(),
    price: z
      .union([z.number().finite().positive(), z.string().regex(/^[0-9]+(\.[0-9]+)?$/)])
      .optional(),
    stop: z
      .union([z.number().finite().positive(), z.string().regex(/^[0-9]+(\.[0-9]+)?$/)])
      .optional(),
    clientEventId: z.string().min(1).optional()
  })
  .superRefine((value, ctx) => {
    // Require exactly one identifier: symbol xor universalSymbolId.
    const hasSymbol = !!value.symbol;
    const hasUniversal = !!value.universalSymbolId;
    if (hasSymbol === hasUniversal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of symbol or universalSymbolId",
        path: ["symbol"]
      });
    }

    // Require exactly one sizing field: units xor notionalValue.
    const hasUnits = value.units !== undefined;
    const hasNotional = value.notionalValue !== undefined;
    if (hasUnits === hasNotional) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of units or notionalValue",
        path: ["units"]
      });
    }

    // Price/stop requirements based on order type.
    const type = value.orderType;
    if (type === "Limit" || type === "StopLimit") {
      if (value.price === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "price is required for Limit and StopLimit orders",
          path: ["price"]
        });
      }
    }
    if (type === "Stop" || type === "StopLimit") {
      if (value.stop === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "stop is required for Stop and StopLimit orders",
          path: ["stop"]
        });
      }
    }

    // Notional is only allowed with Market + Day per SnapTrade docs.
    if (hasNotional && !(type === "Market" && value.timeInForce === "Day")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "notionalValue requires orderType=Market and timeInForce=Day",
        path: ["notionalValue"]
      });
    }
  });

export type EquityOrderPayload = z.infer<typeof equityOrderSchema>;
