import { rmSync } from "node:fs";
import { publicSettings, resolveSettings, saveSettings, settingsFilePath } from "@/lib/settings";
import { checkRateLimit, hasMismatchedOrigin, rateLimitResponse } from "@/lib/request-guards";
import local from "@/config/local.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The settings panel reads the effective configuration (secrets masked). */
export async function GET() {
  return Response.json(publicSettings(resolveSettings()), {
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Saves a partial patch. Only the keys present in the body change, so the panel
 * can send one field at a time; sending "" clears a text field such as a key.
 */
export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin settings requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "settings",
    local.security.director_requests_per_window,
    local.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  let patch: unknown;
  try {
    patch = await request.json();
  } catch {
    return Response.json({ error: "A JSON settings patch is required." }, { status: 400 });
  }

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return Response.json({ error: "A JSON settings object is required." }, { status: 400 });
  }

  try {
    const saved = saveSettings(patch);
    return Response.json(publicSettings(saved), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The settings could not be saved.";
    return Response.json({ error: `Could not write the settings file: ${message}` }, { status: 500 });
  }
}

/** Drops the saved file so the shipped local defaults apply again. */
export async function DELETE(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin settings requests are not allowed." }, { status: 403 });
  }

  try {
    rmSync(settingsFilePath(), { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The settings file could not be removed.";
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json(publicSettings(resolveSettings()), {
    headers: { "Cache-Control": "no-store" },
  });
}
