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
  if (isAxiosLikeError(error)) {
    const status = error.response?.status ?? 502;
    const requestId = readHeaderValue(error.response?.headers, "x-request-id");

    if (requestId) {
      c.header("X-SnapTrade-Request-ID", String(requestId));
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

    return c.json(
      {
        error: "snaptrade_error",
        message:
          typeof error.response?.data === "string" ? error.response?.data : error.message,
        details: typeof error.response?.data === "object" ? error.response?.data : undefined,
        status
      },
      status
    );
  }

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
 * Header lookup that works across `Headers`, Axios response objects, and plain
 * key/value records. SnapTrade is case-insensitive, so we normalise keys before
 * returning the first matching value.
 */
export function readHeaderValue(headers: unknown, headerName: string): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const lowerCaseName = headerName.toLowerCase();
  const getter = (headers as { get?: (key: string) => unknown }).get;
  const candidateWithGet = getter?.(headerName) ?? getter?.(lowerCaseName);
  if (typeof candidateWithGet === "string") {
    return candidateWithGet;
  }
  if (candidateWithGet !== undefined && candidateWithGet !== null) {
    return String(candidateWithGet);
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

  return undefined;
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
