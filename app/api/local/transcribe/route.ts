import local from "@/config/local.json";
import { ASR_LANGUAGE, ASR_TIMEOUT_MS, ASR_URL, LOCAL_MODE_ENABLED } from "@/lib/local-backends";
import { checkRateLimit, hasMismatchedOrigin, rateLimitResponse } from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/**
 * Proxies one recorded utterance to the local faster-whisper service.
 * The browser only ever talks to this origin, so no CORS surface is added and
 * the audio never leaves the machine.
 */
export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin transcription requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "local-transcribe",
    local.security.transcribe_requests_per_window,
    local.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  if (!LOCAL_MODE_ENABLED) {
    return Response.json({ error: "Local mode is disabled (ZEROPREP_LOCAL=0)." }, { status: 503 });
  }

  const audio = await request.arrayBuffer();
  if (!audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) {
    return Response.json({ error: "A short WAV recording is required." }, { status: 400 });
  }

  const url = new URL(request.url);
  const partial = url.searchParams.get("partial") === "1";
  const language = url.searchParams.get("language") || ASR_LANGUAGE;

  const query = new URLSearchParams();
  if (language) query.set("language", language);
  if (partial) query.set("partial", "1");
  const target = `${ASR_URL}/transcribe${query.size ? `?${query.toString()}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASR_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: audio,
      signal: controller.signal,
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The local transcription service is unreachable.";
    return Response.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
