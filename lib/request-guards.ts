type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

const runtimeState = globalThis as typeof globalThis & {
  __zeroprepRateLimits?: Map<string, RateLimitEntry>;
};

const rateLimits =
  runtimeState.__zeroprepRateLimits ??
  (runtimeState.__zeroprepRateLimits = new Map<string, RateLimitEntry>());

function clientAddress(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function checkRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const key = `${scope}:${clientAddress(request)}`;
  const current = rateLimits.get(key);

  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - 1),
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  current.count += 1;
  rateLimits.set(key, current);
  return {
    allowed: current.count <= limit,
    limit,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

export function rateLimitResponse(result: RateLimitResult) {
  return Response.json(
    { error: "Too many requests. Please wait a moment and try again." },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function effectivePort(url: URL) {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/**
 * Reject genuinely cross-origin requests while still allowing the spellings of
 * "this machine" to be mixed. Next.js reports the request URL using the host it
 * was configured with (localhost) even when the browser used 127.0.0.1, so
 * treating the loopback aliases as one host is required for local development.
 * Protocol and port are still compared exactly.
 */
export function hasMismatchedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    if (originUrl.protocol !== requestUrl.protocol) return true;
    if (effectivePort(originUrl) !== effectivePort(requestUrl)) return true;
    if (originUrl.hostname === requestUrl.hostname) return false;
    return !(LOOPBACK_HOSTS.has(originUrl.hostname) && LOOPBACK_HOSTS.has(requestUrl.hostname));
  } catch {
    return true;
  }
}
