import brand from "../../../config/brand.json";
import v7 from "../../../config/v7.json";
import {
  DIRECTOR_INSTRUCTIONS,
  assetInstructions,
  parseAssetCatalog,
  stageTool,
} from "../../../lib/director";
import { DEFAULT_REALTIME_MODEL, isRealtimeModel } from "../../../lib/realtime-models";
import { checkRateLimit, rateLimitResponse } from "../../../lib/request-guards";
import { resolveSettings } from "../../../lib/settings";

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(
    request,
    "realtime-session",
    v7.security.realtime_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  const apiKey = resolveSettings().cloud.openaiApiKey || process.env.OPENAI_API_KEY;
  const requestedModel = request.headers.get("X-ZeroPrep-Realtime-Model");
  const assetCatalog = parseAssetCatalog(request.headers.get("X-ZeroPrep-Asset-Catalog"));
  const assetIds = assetCatalog.map((asset) => asset.id);
  const realtimeModel = isRealtimeModel(requestedModel)
    ? requestedModel
    : DEFAULT_REALTIME_MODEL;

  if (!apiKey) {
    return new Response(
      "Live voice needs OPENAI_API_KEY in the server environment. The local demo and typed-line composer are ready now.",
      { status: 503 },
    );
  }

  const sdp = await request.text();
  if (!sdp || sdp.length > 100_000) {
    return new Response("A valid WebRTC offer is required.", { status: 400 });
  }

  const session = {
    type: "realtime",
    model: realtimeModel,
    instructions: `${DIRECTOR_INSTRUCTIONS}${assetInstructions(assetCatalog)}`,
    output_modalities: v7.realtime.output_modalities,
    max_output_tokens: v7.realtime.max_output_tokens,
    audio: {
      input: {
        transcription: { model: v7.realtime.transcription_model },
        noise_reduction: { type: v7.realtime.noise_reduction },
        turn_detection: v7.realtime.turn_detection,
      },
      output: { voice: v7.realtime.voice },
    },
    tools: [stageTool(assetIds)],
    tool_choice: v7.realtime.tool_choice,
  };

  // The Realtime endpoint expects named multipart fields, not file uploads.
  // Native FormData serializes Blob values with a filename, so construct the
  // two text parts explicitly to preserve their required content types.
  const boundary = `${brand.slug}-realtime-${crypto.randomUUID()}`;
  const multipartBody = new TextEncoder().encode(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="sdp"',
      "Content-Type: application/sdp",
      "",
      sdp,
      `--${boundary}`,
      'Content-Disposition: form-data; name="session"',
      "Content-Type: application/json",
      "",
      JSON.stringify(session),
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );

  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });
    const answer = await upstream.text();

    if (!upstream.ok) {
      return new Response(`OpenAI Realtime could not start: ${answer}`, {
        status: upstream.status,
      });
    }

    return new Response(answer, {
      status: 201,
      headers: {
        "Content-Type": "application/sdp",
        "Cache-Control": "no-store",
        "X-ZeroPrep-Realtime-Model": realtimeModel,
      },
    });
  } catch {
    return new Response("Could not reach the OpenAI Realtime API.", { status: 502 });
  }
}
