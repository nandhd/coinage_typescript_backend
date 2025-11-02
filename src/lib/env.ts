import { z } from "zod";

// Detect when the runtime is executing under Bun's test runner so we can
// supply deterministic defaults without relaxing production validation.
const isTestEnv =
  process.env.NODE_ENV === "test" ||
  process.env.BUN_TEST === "true" ||
  process.env.BUN_TEST === "1";

/**
 * Validates required environment variables at startup so the service fails
 * fast if SnapTrade partner credentials are missing.
 */
const envSchema = z.object({
  SNAPTRADE_CLIENT_ID: z.string().min(1, "SNAPTRADE_CLIENT_ID is required"),
  SNAPTRADE_CONSUMER_KEY: z.string().min(1, "SNAPTRADE_CONSUMER_KEY is required"),
  SNAPTRADE_BASE_URL: z
    .string()
    .url("SNAPTRADE_BASE_URL must be a valid URL")
    .default("https://api.snaptrade.com/api/v1"),
  COINAGE_TS_SHARED_SECRET: z.string().optional()
});

/**
 * Strongly-typed wrapper around process.env. Downstream modules import `env`
 * instead of reading directly from the environment.
 */
export const env = envSchema.parse({
  SNAPTRADE_CLIENT_ID:
    process.env.SNAPTRADE_CLIENT_ID ??
    // Unit tests run inside a sandboxed Bun runtime without partner creds; provide
    // stable dummies so the schema still enforces presence in production.
    (isTestEnv ? "test-client" : undefined),
  SNAPTRADE_CONSUMER_KEY:
    process.env.SNAPTRADE_CONSUMER_KEY ?? (isTestEnv ? "test-key" : undefined),
  SNAPTRADE_BASE_URL: process.env.SNAPTRADE_BASE_URL,
  COINAGE_TS_SHARED_SECRET: process.env.COINAGE_TS_SHARED_SECRET
});
