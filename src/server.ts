import app from "./app";

/**
 * Bun-native server bootstrap. We read PORT/HOST so the process can be wired
 * up behind Fly.io's process groups without additional code changes.
 */
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
// Prefer Fly’s 6PN interface only when a private address is actually provisioned.
const hasSixPn = Boolean(process.env.FLY_PRIVATE_IP);
let hostname = process.env.HOST ?? (hasSixPn ? "fly-local-6pn" : "::");

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    fetch: app.fetch,
    port,
    hostname
  });
} catch (error) {
  // If we attempted to bind to the 6PN interface and it isn't available, fall back to IPv6 ANY.
  if (!process.env.HOST && hasSixPn && String(error).includes("EADDRNOTAVAIL")) {
    hostname = "::";
    server = Bun.serve({
      fetch: app.fetch,
      port,
      hostname
    });
  } else {
    throw error;
  }
}

const displayHost =
  hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
console.log(
  `coinage TypeScript backend listening on http://${displayHost}:${server.port}`
);

// Graceful shutdown so Fly can cycle the process without dropping in-flight requests.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`received ${sig}, shutting down`);
    server.stop(true);
  });
}
