import { z } from "zod";

/**
 * Payload for fetching a single order's detail from SnapTrade. Mirrors the
 * parameters required by `getUserAccountOrderDetail`.
 */
export const orderDetailSchema = z.object({
  accountId: z.string().uuid(),
  userId: z.string().min(1),
  userSecret: z.string().min(1),
  brokerage_order_id: z.string().min(1)
});

export type OrderDetailPayload = z.infer<typeof orderDetailSchema>;
