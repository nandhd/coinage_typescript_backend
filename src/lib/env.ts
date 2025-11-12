import { z } from "zod";

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

const isTestEnvironment =
  process.env.NODE_ENV === "test" ||
  process.env.BUN_TEST === "1" ||
  process.env.VITEST === "true";

/**
 * In CI/unit tests we don't want to supply real partner credentials but we still
 * want the service to boot (so routes can be exercised). Bun exposes BUN_TEST=1
 * during `bun test`, so we detect that and inject deterministic placeholders.
 * Production keeps the hard failure semantics because missing SnapTrade creds
 * should crash immediately.
 */
const testFallbacks: Partial<Record<"SNAPTRADE_CLIENT_ID" | "SNAPTRADE_CONSUMER_KEY", string>> = isTestEnvironment
  ? {
      SNAPTRADE_CLIENT_ID: "snaptrade-test-client-id",
      SNAPTRADE_CONSUMER_KEY: "snaptrade-test-consumer-key"
    }
  : {};

/**
 * Strongly-typed wrapper around process.env. Downstream modules import `env`
 * instead of reading directly from the environment.
 */
export const env = envSchema.parse({
  SNAPTRADE_CLIENT_ID: process.env.SNAPTRADE_CLIENT_ID ?? testFallbacks.SNAPTRADE_CLIENT_ID,
  SNAPTRADE_CONSUMER_KEY: process.env.SNAPTRADE_CONSUMER_KEY ?? testFallbacks.SNAPTRADE_CONSUMER_KEY,
  SNAPTRADE_BASE_URL: process.env.SNAPTRADE_BASE_URL,
  COINAGE_TS_SHARED_SECRET: process.env.COINAGE_TS_SHARED_SECRET
});
