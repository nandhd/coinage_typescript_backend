import app from "./app";

/**
 * Bun-native server bootstrap. We read PORT/HOST so the process can be wired
 * up behind Fly.io's process groups without additional code changes.
 */
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOST ?? "0.0.0.0";

const server = Bun.serve({
  fetch: app.fetch,
  port,
  hostname
});

console.log(
  `coinage TypeScript backend listening on http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${
    server.port
  }`
);
