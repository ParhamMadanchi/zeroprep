import { GoogleGenAI } from "@google/genai";
import v7 from "@/config/v7.json";
import { imageryConfig } from "@/lib/local-backends";
import { generateLocalImage, buildLocalPrompt, type LocalImageryScene } from "@/lib/local-imagery";
import {
  checkRateLimit,
  hasMismatchedOrigin,
  rateLimitResponse,
} from "@/lib/request-guards";

export const runtime = "nodejs";
export const maxDuration = 300;

type ImageryRequest = {
  sceneId?: unknown;
  kind?: unknown;
  eyebrow?: unknown;
  title?: unknown;
  subtitle?: unknown;
  metric?: unknown;
  metricLabel?: unknown;
  quote?: unknown;
  cards?: unknown;
  accent?: unknown;
  referenceAssets?: unknown;
  exactAssetKinds?: unknown;
};

type ImageryReference = {
  id: string;
  name: string;
  kind: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
};

const SCENE_KINDS = new Set(["hero", "cards", "metric", "quote"]);
const ACCENT_DESCRIPTIONS: Record<string, string> = {
  ember: "electric orange-red",
  lime: "acid lime green",
  sky: "clear cyan blue",
  violet: "luminous violet",
};

function cleanText(value: unknown, limit: number) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function cardSummary(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value
    .slice(0, 4)
    .map((card) => {
      if (!card || typeof card !== "object") return "";
      const item = card as Record<string, unknown>;
      return [cleanText(item.title, 80), cleanText(item.body, 180)]
        .filter(Boolean)
        .join(": ");
    })
    .filter(Boolean)
    .join("; ")
    .slice(0, 700);
}

/**
 * Any OpenAI-compatible image endpoint (`POST /images/generations`).
 * Providers differ on aspect ratio names, so the configured size is mapped to
 * the closest supported one and the response is accepted as either base64 or a
 * URL, which covers OpenAI, Azure-style gateways, and local shims.
 */
async function generateRemoteImage(
  imagery: ReturnType<typeof imageryConfig>,
  scene: LocalImageryScene,
  signal: AbortSignal,
) {
  const size =
    imagery.width === imagery.height
      ? "1024x1024"
      : imagery.width >= imagery.height
        ? "1536x1024"
        : "1024x1536";

  const response = await fetch(`${imagery.url}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${imagery.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: imagery.model,
      prompt: buildLocalPrompt(scene),
      n: 1,
      size,
    }),
  });

  if (!response.ok) {
    return { ok: false as const, error: `Image API failed: ${(await response.text()).slice(0, 300)}` };
  }

  const payload = (await response.json()) as {
    data?: { b64_json?: string; url?: string }[];
  };
  const first = payload.data?.[0];
  if (first?.b64_json) {
    return { ok: true as const, bytes: Buffer.from(first.b64_json, "base64"), mimeType: "image/png" };
  }
  if (first?.url) {
    const file = await fetch(first.url, { signal });
    if (!file.ok) return { ok: false as const, error: "Image API returned an unreachable URL." };
    return {
      ok: true as const,
      bytes: Buffer.from(await file.arrayBuffer()),
      mimeType: file.headers.get("content-type") || "image/png",
    };
  }
  return { ok: false as const, error: "Image API returned no image." };
}

function localCards(value: unknown): { title: string; body: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 4)
    .map((card) => {
      if (!card || typeof card !== "object") return { title: "", body: "" };
      const item = card as Record<string, unknown>;
      return { title: cleanText(item.title, 80), body: cleanText(item.body, 180) };
    })
    .filter((card) => card.title || card.body);
}

function exactAssetKinds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 24)).filter(Boolean))].slice(0, 4);
}

function referenceAssets(value: unknown): ImageryReference[] {
  if (!Array.isArray(value)) return [];
  let totalBytes = 0;
  const references: ImageryReference[] = [];

  for (const rawReference of value.slice(0, v7.imagery.max_reference_assets)) {
    if (!rawReference || typeof rawReference !== "object") continue;
    const reference = rawReference as Record<string, unknown>;
    const dataUrl = typeof reference.dataUrl === "string" ? reference.dataUrl : "";
    if (dataUrl.length > v7.imagery.max_reference_bytes * 1.5 + 100) continue;
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=]+)$/);
    if (!match) continue;
    const bytes = Buffer.byteLength(match[2], "base64");
    if (!bytes || bytes > v7.imagery.max_reference_bytes) continue;
    totalBytes += bytes;
    if (totalBytes > v7.imagery.max_reference_bytes * v7.imagery.max_reference_assets) break;
    references.push({
      id: cleanText(reference.id, 80),
      name: cleanText(reference.name, 80),
      kind: cleanText(reference.kind, 24),
      mimeType: match[1] as ImageryReference["mimeType"],
      data: match[2],
    });
  }

  return references.filter((reference) => reference.id && reference.name);
}

function compositionDirection(kind: string) {
  if (kind === "hero") {
    return "Create one unmistakable visual subject near the center. It must remain clear when the wide image is center-cropped into a tall right-side panel.";
  }
  if (kind === "cards") {
    return "Create a strong, wide establishing image with a clear center of interest. This will appear as a dedicated landscape panel above a row of information cards.";
  }
  if (kind === "metric") {
    return "Create one bold real-world visual metaphor for the metric, centered and easy to read inside a dedicated right-side image panel, without drawing a literal chart or any numbers.";
  }
  return "Create an atmospheric, emotionally resonant image with one clear subject that works inside a dedicated right-side panel.";
}

function buildPrompt(body: ImageryRequest, references: ImageryReference[]) {
  const kind = cleanText(body.kind, 16);
  const title = cleanText(body.title, 180);
  const subtitle = cleanText(body.subtitle, 500);
  const quote = cleanText(body.quote, 500);
  const metric = cleanText(body.metric, 80);
  const metricLabel = cleanText(body.metricLabel, 120);
  const cards = cardSummary(body.cards);
  const exactKinds = exactAssetKinds(body.exactAssetKinds);
  const accent = ACCENT_DESCRIPTIONS[cleanText(body.accent, 16)] || "vivid lime green";
  const subject = [
    title && `Main idea: ${title}`,
    subtitle && `Context: ${subtitle}`,
    quote && `Emotional theme: ${quote}`,
    metric && `Metric concept: ${metric} ${metricLabel}`,
    cards && `Related ideas: ${cards}`,
  ]
    .filter(Boolean)
    .join("\n");
  const referenceDirection = references.length
    ? `\nReference assets are attached after this instruction: ${references
        .map((reference, index) => `Reference ${index + 1} is ${reference.name} (${reference.kind})`)
        .join("; ")}.
- Use each reference only when it strengthens the main idea. Preserve recognizable identity, product shape, colors, and existing brand marks.
- Compose a new surrounding scene rather than placing the reference inside a fake slide or frame.
- Do not invent, rewrite, or distort logos or text from a reference. Leave identity-critical marks visually faithful.`
    : "";
  const exactAssetDirection = exactKinds.length
    ? `\nOriginal ${exactKinds.join(", ")} asset${exactKinds.length === 1 ? " is" : "s are"} overlaid separately in a reserved right-side panel. Create a restrained complementary environment behind the layout. Do not depict, imitate, redraw, or duplicate those assets, people, faces, logos, products, interfaces, charts, or their text.`
    : "";

  return `Create one sophisticated 16:9 editorial presentation background image.

${subject}

Visual direction:
- Translate the idea into concrete, relevant imagery rather than generic abstract shapes.
- Contemporary editorial photography or tactile mixed-media collage, energetic and premium, with a subtle motion-graphics feeling.
- Warm ivory, deep black, and ${accent} may guide the palette.
- ${compositionDirection(kind)}
- ${references.length
    ? "The attached references are intentional creative inputs; integrate them naturally while keeping their identity faithful."
    : "Avoid identifiable public figures and branded products."}
- The image will be shown unobstructed inside its own reserved presentation panel; make the subject bold, clear, and visually rich. No text will be placed over it, so do not reserve empty copy space.
- No new words, letters, numbers, captions, watermarks, presentation frames, charts with labels, app interfaces, or decorative fake text.
- Do not render a slide. Produce only the underlying cinematic imagery.
${referenceDirection}
${exactAssetDirection}
`;
}

export async function POST(request: Request) {
  if (hasMismatchedOrigin(request)) {
    return Response.json({ error: "Cross-origin imagery requests are not allowed." }, { status: 403 });
  }

  const rateLimit = checkRateLimit(
    request,
    "gemini-imagery",
    v7.security.imagery_requests_per_window,
    v7.security.rate_limit_window_ms,
  );
  if (!rateLimit.allowed) return rateLimitResponse(rateLimit);

  let body: ImageryRequest;
  try {
    body = (await request.json()) as ImageryRequest;
  } catch {
    return Response.json({ error: "A valid scene description is required." }, { status: 400 });
  }

  const sceneId = cleanText(body.sceneId, 120);
  const kind = cleanText(body.kind, 16);
  const title = cleanText(body.title, 180);
  const references = referenceAssets(body.referenceAssets);
  if (!sceneId || !SCENE_KINDS.has(kind) || !title) {
    return Response.json({ error: "The scene is incomplete." }, { status: 400 });
  }

  const imagery = imageryConfig();

  if (!imagery.enabled) {
    return Response.json(
      { error: "Image generation is turned off in settings." },
      { status: 409 },
    );
  }

  const scene: LocalImageryScene = {
    sceneId,
    kind,
    eyebrow: cleanText(body.eyebrow, 120),
    title,
    subtitle: cleanText(body.subtitle, 500),
    metric: cleanText(body.metric, 80),
    metricLabel: cleanText(body.metricLabel, 120),
    quote: cleanText(body.quote, 500),
    cards: localCards(body.cards),
    accent: cleanText(body.accent, 16),
    referenceCount: references.length,
  };

  if (imagery.provider === "comfyui") {
    const rendered = await generateLocalImage(scene, request.signal);
    if (!rendered.ok) {
      if ("aborted" in rendered || request.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      return Response.json({ error: rendered.error }, { status: 502 });
    }
    return new Response(rendered.bytes, {
      status: 200,
      headers: {
        "Content-Type": rendered.mimeType,
        "Cache-Control": "private, no-store, max-age=0",
        "X-ZeroPrep-Scene": sceneId,
        "X-ZeroPrep-Image-Model": `comfyui:${imagery.model}`,
        "X-ZeroPrep-Render-Ms": String(rendered.elapsedMs),
      },
    });
  }

  if (imagery.provider === "openai") {
    if (!imagery.apiKey) {
      return Response.json(
        { error: "The image API needs an API key. Add one in settings." },
        { status: 503 },
      );
    }
    try {
      const generated = await generateRemoteImage(imagery, scene, request.signal);
      if (!generated.ok) {
        return Response.json({ error: generated.error }, { status: 502 });
      }
      return new Response(generated.bytes, {
        status: 200,
        headers: {
          "Content-Type": generated.mimeType,
          "Cache-Control": "private, no-store, max-age=0",
          "X-ZeroPrep-Scene": sceneId,
          "X-ZeroPrep-Image-Model": `openai:${imagery.model}`,
        },
      });
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      const message = error instanceof Error ? error.message : "The image API request failed.";
      return Response.json({ error: message }, { status: 502 });
    }
  }

  const apiKey = imagery.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Generated imagery needs GEMINI_API_KEY in the server environment." },
      { status: 503 },
    );
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = references.length ? v7.imagery.reference_model : v7.imagery.model;
    const input = references.length
      ? [
          { type: "text" as const, text: buildPrompt(body, references) },
          ...references.map((reference) => ({
            type: "image" as const,
            mime_type: reference.mimeType,
            data: reference.data,
          })),
        ]
      : buildPrompt(body, references);
    const interaction = await ai.interactions.create(
      {
        model,
        input,
        store: false,
        response_format: {
          type: "image",
          mime_type: v7.imagery.mime_type,
          aspect_ratio: v7.imagery.aspect_ratio,
          image_size: v7.imagery.image_size,
        },
      },
      {
        timeout: v7.imagery.timeout_ms,
        maxRetries: 0,
        fetchOptions: { signal: request.signal },
      },
    );

    const generated = interaction.output_image;
    if (!generated?.data) {
      return Response.json(
        { error: "Gemini did not return an image for this scene." },
        { status: 502 },
      );
    }

    const mimeType = generated.mime_type || v7.imagery.mime_type;
    return new Response(Buffer.from(generated.data, "base64"), {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "private, no-store, max-age=0",
        "X-ZeroPrep-Scene": sceneId,
        "X-ZeroPrep-Image-Model": model,
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    const message = error instanceof Error ? error.message : "Gemini imagery could not be generated.";
    return Response.json({ error: message }, { status: 502 });
  }
}
