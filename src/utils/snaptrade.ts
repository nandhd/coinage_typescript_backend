import type { Context } from "hono";
import type { ZodError } from "zod";

/**
 * Shapes returned by the SnapTrade SDK vary between raw response payloads and
 * objects that include `data` and `headers`. This helper normalises both so our
 * route handlers can treat them uniformly.
 */
export function unwrapSnaptradeResponse<T>(
  result: PossibleResponse<T>
): { data: T; requestId?: string; headers?: HeadersLike } {
  if (result && typeof result === "object" && "data" in result) {
    const maybeHeaders = (result as { headers?: HeadersLike }).headers;
    return {
      data: (result as { data: T }).data,
      requestId: extractRequestId(maybeHeaders),
      headers: maybeHeaders
    };
  }

  return { data: result as T, requestId: undefined };
}

/**
 * Converts a Zod validation failure into an HTTP 400 response, matching the
 * error shape the Java backend already expects (`issues` mirrors Zod's flatten).
 */
export function validationError(c: Context, error: ZodError) {
  return c.json(
    {
      error: "validation_error",
      message: "Validation failed",
      issues: error.flatten()
    },
    400
  );
}

/**
 * Standardised error bridge between this service and SnapTrade. We surface the
 * upstream status code when available, include the partner-facing request id,
 * and log unexpected failures for further triage.
 */
export function handleSnaptradeError(c: Context, error: unknown) {
  /**
   * IMPORTANT CONTEXT (why this function exists):
   *
   * This TypeScript service is a "bridge" that calls SnapTrade using the TS SDK and returns the
   * result to the Java backend. The Java backend then maps SnapTrade errors using `SnaptradeErrorMapper`,
   * which expects SnapTrade's *native* error JSON (shape like `{ code, detail, raw_error }`).
   *
   * If we accidentally:
   * - change the HTTP status code (e.g., turn a 400 into 500), or
   * - wrap the error body in our own `{ error: ... }` envelope, or
   * - drop the partner request id header (`x-request-id`),
   *
   * then the Java backend can no longer extract:
   * - nested broker error codes (e.g., `raw_error.body.error_code`), and
   * - remediation URLs (e.g., Webull agreement link),
   *
   * which directly breaks user-facing flows like the "Action needed: sign Webull agreement" email.
   *
   * A key nuance: SnapTrade's TS SDK errors are not always "Axios-like". In production we observed
   * the SDK throwing a `SnaptradeError` instance that carries fields like:
   *   - `status` / `statusCode`
   *   - `headers`
   *   - `responseBody`
   *
   * Our prior implementation only handled Axios-shaped errors (`error.response.status`, etc.).
   * When the SDK threw `SnaptradeError`, we fell through to the generic 500 path and logged
   * "Unhandled SnapTrade error", which caused the Java service to see a synthetic 500 and lose the
   * original SnapTrade error payload and headers.
   *
   * The logic below therefore handles BOTH shapes:
   * 1) Axios-like errors (legacy / some adapters),
   * 2) SnapTrade SDK `SnaptradeError`-like errors (non-Axios), by returning the original
   *    status + raw error JSON unmodified.
   */
  if (isAxiosLikeError(error)) {
    const status = error.response?.status ?? 502;
    const requestId = readHeaderValue(error.response?.headers, "x-request-id");

    if (requestId) {
      c.header("X-SnapTrade-Request-ID", String(requestId));
      // The Java backend expects `X-Request-ID` when mapping SnapTrade SDK errors (it uses this
      // header name for both SDK and TS-bridge calls). Set both so logs/errors can correlate.
      c.header("X-Request-ID", String(requestId));
    }

    const rateLimit = pickRateLimitHeaders(error.response?.headers);
    if (rateLimit.limit) {
      c.header("X-SnapTrade-RateLimit-Limit", rateLimit.limit);
    }
    if (rateLimit.remaining) {
      c.header("X-SnapTrade-RateLimit-Remaining", rateLimit.remaining);
    }
    if (rateLimit.reset) {
      c.header("X-SnapTrade-RateLimit-Reset", rateLimit.reset);
    }
    const retryAfter = readHeaderValue(error.response?.headers, "retry-after");
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
    }

    const data = error.response?.data;
    // Important: the Java backend's SnaptradeErrorMapper expects SnapTrade's native error JSON
    // shape (e.g., `{ code, detail, raw_error }`). Do not wrap object payloads, otherwise the
    // mapper can't extract nested broker error codes and remediation URLs.
    if (data && typeof data === "object") {
      return c.json(data, status);
    }
    if (typeof data === "string") {
      const trimmed = data.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") {
            return c.json(parsed, status);
          }
        } catch {
          // fall through to synthetic error payload
        }
      }
      return c.json({ code: "SNAPTRADE_ERROR", detail: data }, status);
    }
    return c.json({ code: "SNAPTRADE_ERROR", detail: error.message }, status);
  }

  // Handle SnapTrade TS SDK errors that are *not* Axios-like.
  //
  // Why we need this branch:
  // - The SnapTrade TS SDK (snaptrade-typescript-sdk) can throw a custom `SnaptradeError` class.
  // - That class does NOT have `error.response`, so it bypasses the Axios branch above.
  // - However, it still contains everything we need to preserve correctness:
  //   - the upstream HTTP status code (often 400/401/403/429/etc),
  //   - the SnapTrade request id header (x-request-id),
  //   - rate limit headers (x-ratelimit-*),
  //   - and most importantly the raw SnapTrade JSON body (code/detail/raw_error).
  //
  // If we fail to recognise it, we incorrectly return 500 here, and the Java backend can no longer
  // map Webull agreement gates (because it never sees `raw_error.body.error_code`).
  if (isSnaptradeSdkError(error)) {
    // The SDK uses `status` in some versions and `statusCode` in others. Prefer `statusCode` if present.
    const status =
      (typeof error.statusCode === "number" && error.statusCode > 0 ? error.statusCode : undefined) ??
      (typeof error.status === "number" && error.status > 0 ? error.status : undefined) ??
      502;

    // Header propagation: SnapTrade support/debug workflows rely heavily on x-request-id.
    // We set BOTH X-SnapTrade-Request-ID and X-Request-ID because the Java bridge client reads
    // X-Request-ID for correlation and mapping.
    const requestId = readHeaderValue(error.headers, "x-request-id");
    if (requestId) {
      c.header("X-SnapTrade-Request-ID", String(requestId));
      c.header("X-Request-ID", String(requestId));
    }

    // Propagate rate limit headers so the Java backend can observe/record remaining budget.
    const rateLimit = pickRateLimitHeaders(error.headers);
    if (rateLimit.limit) c.header("X-SnapTrade-RateLimit-Limit", rateLimit.limit);
    if (rateLimit.remaining) c.header("X-SnapTrade-RateLimit-Remaining", rateLimit.remaining);
    if (rateLimit.reset) c.header("X-SnapTrade-RateLimit-Reset", rateLimit.reset);

    // Propagate Retry-After when present (important for 429 and backoff behaviour).
    const retryAfter = readHeaderValue(error.headers, "retry-after");
    if (retryAfter) c.header("Retry-After", String(retryAfter));

    // SnapTrade's error payload may be an object or a JSON string. We must return it *as-is* (object),
    // not wrapped, so the Java `SnaptradeErrorMapper` can parse:
    // - `code` (often numeric string like "1119"),
    // - `detail` (often includes remediation URL), and
    // - `raw_error.body.error_code` (the real actionable broker code).
    const body = error.responseBody;
    if (body && typeof body === "object") {
      return c.json(body, status);
    }
    if (typeof body === "string") {
      const trimmed = body.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") {
            return c.json(parsed, status);
          }
        } catch {
          // fall through to string wrapper below
        }
      }
      // If we received a non-JSON string, return it as `detail` so callers at least see the reason.
      return c.json({ code: "SNAPTRADE_ERROR", detail: body }, status);
    }

    // Last resort: preserve status code, but use the error message as detail.
    return c.json({ code: "SNAPTRADE_ERROR", detail: error.message }, status);
  }

  // Any other unknown error shape: log and return a synthetic 500.
  // This path should be rare; if it becomes common we should expand the type guards above.
  console.error("Unhandled SnapTrade error", error);
  return c.json(
    {
      error: "internal_error",
      message: "Failed to process SnapTrade request"
    },
    500
  );
}

/**
 * Extracts the SnapTrade request id from the varied header shapes provided by
 * the SDK (fetch adapter, Axios adapter, plain objects).
 */
export function extractRequestId(headers: HeadersLike | undefined): string | undefined {
  return readHeaderValue(headers, "x-request-id") ?? undefined;
}

export function pickRateLimitHeaders(
  headers: HeadersLike | undefined
): { limit?: string; remaining?: string; reset?: string } {
  // SnapTrade includes the partner-level rate limit counters in standard
  // headers. Surface them so callers can observe their remaining budget.
  return {
    limit: readHeaderValue(headers, "x-ratelimit-limit"),
    remaining: readHeaderValue(headers, "x-ratelimit-remaining"),
    reset: readHeaderValue(headers, "x-ratelimit-reset")
  };
}

/**
 * Minimal Axios-esque type guard so we can safely read `response` off errors.
 */
function isAxiosLikeError(
  error: unknown
): error is {
  message: string;
  response?: {
    status?: number;
    data?: unknown;
    headers?: unknown;
  };
} {
  return Boolean(error && typeof error === "object" && "message" in error && "response" in (error as any));
}

/**
 * Type guard for SnapTrade TS SDK errors (e.g., `SnaptradeError`).
 *
 * We intentionally avoid importing the SDK's error class here because:
 * - it would force this utility to be coupled to the SDK runtime module system, and
 * - error classes can be duplicated across bundlers, making `instanceof` unreliable.
 *
 * Instead we detect by "shape":
 * - `message` is present (string),
 * - a numeric `status` or `statusCode` exists,
 * - and `responseBody` exists (string or object) OR `headers` exists (for request-id propagation).
 */
function isSnaptradeSdkError(
  error: unknown
): error is {
  message: string;
  status?: number;
  statusCode?: number;
  responseBody?: unknown;
  headers?: unknown;
} {
  if (!error || typeof error !== "object") return false;

  const e = error as any;
  const hasMessage = typeof e.message === "string";
  const hasStatus = typeof e.status === "number" || typeof e.statusCode === "number";
  const hasBodyOrHeaders = "responseBody" in e || "headers" in e;
  return hasMessage && hasStatus && hasBodyOrHeaders;
}

/**
 * Header lookup that works across `Headers`, Axios response objects, and plain
 * key/value records. SnapTrade is case-insensitive, so we normalise keys before
 * returning the first matching value.
 */
/**
 * SnapTrade responses surface headers through several shapes (Fetch Headers,
 * Axios plain objects, or custom structures). This utility tries every shape
 * in order of precision while trapping parsing issues so we can diagnose future
 * SDK changes by inspecting structured logs rather than crashing the handler.
 */
export function readHeaderValue(headers: unknown, headerName: string): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const lowerCaseName = headerName.toLowerCase();

  try {
    const headersWithGet = headers as { get?: (key: string) => unknown };
    if (typeof headersWithGet.get === "function") {
      const candidateWithGet =
        headersWithGet.get.call(headers, headerName) ?? headersWithGet.get.call(headers, lowerCaseName);
      if (typeof candidateWithGet === "string") {
        return candidateWithGet;
      }
      if (candidateWithGet !== undefined && candidateWithGet !== null) {
        return String(candidateWithGet);
      }
    }

    if (typeof (headers as { forEach?: (cb: (value: unknown, key: string) => void) => void }).forEach === "function") {
      let match: string | undefined;
      (headers as { forEach: (cb: (value: unknown, key: string) => void) => void }).forEach((value, key) => {
        if (key.toLowerCase() === lowerCaseName && match === undefined) {
          match = typeof value === "string" ? value : String(value);
        }
      });
      if (match) {
        return match;
      }
    }

    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === lowerCaseName) {
        return typeof value === "string" ? value : String(value);
      }
    }
  } catch (error) {
    logHeaderParsingError(headerName, headers, error);
  }

  return undefined;
}

function logHeaderParsingError(headerName: string, headers: unknown, error: unknown) {
  try {
    // Preserve as much context as possible—raw headers often contain nested
    // structures, so we JSON.stringify but fall back to `toString` if that fails.
    console.warn(
      JSON.stringify({
        event: "snaptrade.headers.parse_error",
        headerName,
        headersSnapshot: safeSerialize(headers),
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      })
    );
  } catch {
    console.warn("snaptrade.headers.parse_error", { headerName, error });
  }
}

function safeSerialize(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    // Fall back to the default object tag instead of throwing inside logging.
    return typeof value === "string" ? value : Object.prototype.toString.call(value);
  }
}

/**
 * Forward useful SnapTrade response metadata to our caller.
 */
export function propagateRateLimitHeaders(c: Context, headers?: HeadersLike) {
  if (!headers) {
    return;
  }

  const limit = readHeaderValue(headers, "x-ratelimit-limit");
  const remaining = readHeaderValue(headers, "x-ratelimit-remaining");
  const reset = readHeaderValue(headers, "x-ratelimit-reset");

  if (limit) {
    c.header("X-SnapTrade-RateLimit-Limit", String(limit));
  }
  if (remaining) {
    c.header("X-SnapTrade-RateLimit-Remaining", String(remaining));
  }
  if (reset) {
    c.header("X-SnapTrade-RateLimit-Reset", String(reset));
  }
}

type PossibleResponse<T> =
  | T
  | {
      data: T;
      headers?: HeadersLike;
    };

type HeadersLike =
  | Record<string, unknown>
  | {
      get(name: string): unknown;
      forEach(callback: (value: unknown, key: string) => void): void;
    };
