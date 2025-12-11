import { Hono } from "hono";
import { ZodError } from "zod";
import { registerCryptoRoutes } from "./routes/crypto";
import { registerOrderRoutes } from "./routes/orders";
import { registerEquityRoutes } from "./routes/equity";
import { validationError } from "./utils/snaptrade";

/**
 * Primary HTTP application for the Bun service. Route registration is
 * delegated to feature-specific modules to keep this file light and focused on
 * application wiring.
 */
const app = new Hono();

// Fly health checks expect a simple 200 response.
app.get("/healthz", (c) => c.text("ok"));

registerCryptoRoutes(app);
registerOrderRoutes(app);
registerEquityRoutes(app);

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
