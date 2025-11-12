import app from "./app";

/**
 * Bun-native server bootstrap. We read PORT/HOST so the process can be wired
 * up behind Fly.io's process groups without additional code changes.
 */
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const privateIp = process.env.FLY_PRIVATE_IP;
const hostname = process.env.HOST ?? (privateIp ?? "::");

const server = Bun.serve({
  fetch: app.fetch,
  port,
  hostname
});

const printableHost = hostname === "::" || hostname === "0.0.0.0" ? "localhost" : hostname;

console.log(`coinage TypeScript backend listening on http://${printableHost}:${server.port}`);
