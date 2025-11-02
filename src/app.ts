import { Hono } from "hono";
import { ZodError } from "zod";
import { registerCryptoRoutes } from "./routes/crypto";
import { validationError } from "./utils/snaptrade";

/**
 * Primary HTTP application for the Bun service. Route registration is
 * delegated to feature-specific modules to keep this file light and focused on
 * application wiring.
 */
const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok" }));

registerCryptoRoutes(app);

/**
 * Catch-all error handler. Most validation errors are handled in the routes,
 * but this ensures any uncaught Zod failures still bubble up cleanly.
 */
app.onError((err, c) => {
  if (err instanceof ZodError) {
    return validationError(c, err);
  }

  console.error("Unexpected error", err);
  return c.json(
    {
      error: "internal_error",
      message: "An unexpected error occurred."
    },
    500
  );
});

export default app;
