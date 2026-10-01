import local from "@/config/local.json";
import { transcriberConfig } from "@/lib/local-backends";
import { checkRateLimit, hasMismatchedOrigin, rateLimitResponse } from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/**
 * Proxies one recorded utterance to whichever speech backend is configured.
 *
 * The browser only ever talks to this origin, so audio never goes anywhere the
 * presenter did not choose, and the credential for a custom API never reaches
 * the browser. Two shapes are supported:
 *   - the local faster-whisper service (`/transcribe`, raw WAV)
 *   - any OpenAI-compatible endpoint (`/audio/transcriptions`, multipart)
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

  const audio = await request.arrayBuffer();
  if (!audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) {
    return Response.json({ error: "A short WAV recording is required." }, { status: 400 });
  }

  const config = transcriberConfig();
  const url = new URL(request.url);
  const partial = url.searchParams.get("partial") === "1";
  const language = url.searchParams.get("language") || config.language;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response =
      config.provider === "local"
        ? await transcribeLocally(config.url, audio, language, partial, controller.signal)
        : await transcribeRemotely(config, audio, language, controller.signal);

    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The speech backend is unreachable.";
    return Response.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

function transcribeLocally(
  baseUrl: string,
  audio: ArrayBuffer,
  language: string,
  partial: boolean,
  signal: AbortSignal,
) {
  const query = new URLSearchParams();
  if (language) query.set("language", language);
  if (partial) query.set("partial", "1");
  return fetch(`${baseUrl}/transcribe${query.size ? `?${query.toString()}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: audio,
    signal,
  });
}

/** OpenAI-compatible: POST /audio/transcriptions with a multipart WAV upload. */
async function transcribeRemotely(
  config: ReturnType<typeof transcriberConfig>,
  audio: ArrayBuffer,
  language: string,
  signal: AbortSignal,
) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "utterance.wav");
  form.append("model", config.model || "whisper-1");
  form.append("response_format", "json");
  if (language) form.append("language", language);

  const upstream = await fetch(`${config.url}/audio/transcriptions`, {
    method: "POST",
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
    body: form,
    signal,
  });

  if (!upstream.ok) return upstream;

  // Normalise to the { text } shape the local service already returns.
  const payload = (await upstream.json()) as { text?: string; transcript?: string };
  return Response.json(
    { text: String(payload.text ?? payload.transcript ?? "").trim(), language },
    { status: 200 },
  );
}
