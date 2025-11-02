import { Snaptrade } from "snaptrade-typescript-sdk";
import { env } from "./env";

/**
 * Single shared instance of the SnapTrade SDK client. The SDK is lightweight,
 * so we build it once and reuse it for all requests routed through Hono.
 */
export const snaptrade = new Snaptrade({
  clientId: env.SNAPTRADE_CLIENT_ID,
  consumerKey: env.SNAPTRADE_CONSUMER_KEY,
  basePath: env.SNAPTRADE_BASE_URL
});

// Uncomment if Bun ever requires a fetch-based adapter for Axios:
// const { default: fetchAdapter } = await import("@shiroyasha9/axios-fetch-adapter");
// snaptrade.axios.defaults.adapter = fetchAdapter;
