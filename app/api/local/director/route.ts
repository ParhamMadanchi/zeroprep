import local from "@/config/local.json";
import { parseAssetCatalog } from "@/lib/director";
import { cleanText, runLocalDirector } from "@/lib/local-director";
import { checkRateLimit, hasMismatchedOrigin, rateLimitResponse } from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin director requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "local-director",
    local.security.director_requests_per_window,
    local.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  let body: { transcript?: unknown; history?: unknown };
  try {
    body = (await request.json()) as { transcript?: unknown; history?: unknown };
  } catch {
    return Response.json({ error: "A transcript is required." }, { status: 400 });
  }

  const transcript = cleanText(body.transcript, 1200);
  if (!transcript) {
    return Response.json({ error: "A transcript is required." }, { status: 400 });
  }

  const result = await runLocalDirector({
    transcript,
    history: body.history,
    catalog: parseAssetCatalog(request.headers.get("X-ZeroPrep-Asset-Catalog")),
    signal: request.signal,
  });

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({
    command: result.command,
    model: result.model,
    elapsed_ms: result.elapsedMs,
    completion_tokens: result.completionTokens,
  });
}
