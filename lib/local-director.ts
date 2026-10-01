import local from "@/config/local.json";
import {
  DIRECTOR_MODEL,
  DIRECTOR_TIMEOUT_MS,
  DIRECTOR_URL,
  LOCAL_MODE_ENABLED,
} from "@/lib/local-backends";
import { DIRECTOR_INSTRUCTIONS, assetInstructions, stageTool } from "@/lib/director";
import type { PresentationAssetCatalogEntry } from "@/lib/presentation-assets";

/**
 * The fully local replacement for an OpenAI Realtime director turn.
 *
 * Local models are not all created equal: some answer through the native tool
 * channel, some through `content`, and some (the Qwen3 family) through
 * `reasoning_content`. Every candidate is parsed with the same tolerant
 * extractor, so the client receives one identical `stage_visuals` command
 * regardless of which local model is serving.
 */

export type DirectorHistoryEntry = { transcript: string; command: unknown };

export type DirectorResult =
  | { ok: true; command: Record<string, unknown>; model: string; elapsedMs: number; completionTokens: number | null }
  | { ok: false; status: number; error: string };

export function cleanText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

/**
 * The shared schema marks `assetIds` with `maxItems: 0` when the presenter has
 * uploaded nothing. Cloud providers accept that; LM Studio's grammar builder
 * rejects it outright ("failed to parse grammar"). Local mode drops the
 * zero bound and enforces it by filtering the answer against the catalog.
 */
export function toLocalGrammarSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toLocalGrammarSchema);
  if (!node || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "maxItems" && typeof value === "number" && value <= 0) continue;
    if (key === "minItems" && typeof value === "number" && value <= 0) continue;
    result[key] = toLocalGrammarSchema(value);
  }
  return result;
}

/** Keep only asset ids the presenter actually uploaded. */
export function sanitizeCommand(
  command: Record<string, unknown>,
  allowedIds: string[],
): Record<string, unknown> {
  const allowed = new Set(allowedIds);
  const pickIds = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && allowed.has(item)).slice(0, 3)
      : [];

  const cleanCards = (value: unknown) => {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const card = { ...(entry as Record<string, unknown>) };
      if ("assetId" in card && (typeof card.assetId !== "string" || !allowed.has(card.assetId))) {
        delete card.assetId;
      }
      return card;
    });
  };

  const next: Record<string, unknown> = {
    ...command,
    assetIds: pickIds(command.assetIds),
  };
  if (next.scene && typeof next.scene === "object") {
    const scene = { ...(next.scene as Record<string, unknown>) };
    if ("cards" in scene) scene.cards = cleanCards(scene.cards);
    if ("assetIds" in scene) scene.assetIds = pickIds(scene.assetIds);
    next.scene = scene;
  }
  if ("cards" in next) next.cards = cleanCards(next.cards);
  return next;
}

const ACCENT_ROTATION = ["lime", "sky", "violet", "ember"] as const;

/**
 * Local models tend to omit `accent`, which would leave every scene wearing the
 * cover's colour. Rotate the palette per directed scene when the model has no
 * opinion, and leave its choice alone when it does.
 */
export function applyAccentRotation(
  command: Record<string, unknown>,
  sceneIndex: number,
): Record<string, unknown> {
  const scene = command.scene;
  if (!scene || typeof scene !== "object") return command;
  const typedScene = scene as Record<string, unknown>;
  if (typeof typedScene.accent === "string" && typedScene.accent) return command;
  return {
    ...command,
    scene: { ...typedScene, accent: ACCENT_ROTATION[sceneIndex % ACCENT_ROTATION.length] },
  };
}

/** Pull the first balanced JSON object out of prose, reasoning, or tool markup. */
export function extractCommand(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const text = raw.replace(/<\/?tool_call>/g, " ");
  let start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>;
            if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
              return parsed;
            }
          } catch {
            // Keep scanning; the model may have emitted a partial object first.
          }
          break;
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}

function historyMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const rawEntry of value.slice(-local.director.history_turns)) {
    const entry = (rawEntry ?? {}) as Partial<DirectorHistoryEntry>;
    const transcript = cleanText(entry.transcript, 600);
    if (!transcript || !entry.command) continue;
    messages.push({ role: "user", content: transcript });
    messages.push({ role: "assistant", content: JSON.stringify(entry.command) });
  }
  return messages;
}

export async function runLocalDirector(options: {
  transcript: string;
  history: unknown;
  catalog: PresentationAssetCatalogEntry[];
  signal?: AbortSignal;
}): Promise<DirectorResult> {
  const { transcript, history, catalog, signal } = options;
  if (!LOCAL_MODE_ENABLED) {
    return { ok: false, status: 503, error: "Local mode is disabled (ZEROPREP_LOCAL=0)." };
  }

  const assetIds = catalog.map((asset) => asset.id);
  const schema = toLocalGrammarSchema(stageTool(assetIds).parameters);
  const messages = [
    {
      role: "system" as const,
      content: `${DIRECTOR_INSTRUCTIONS}${assetInstructions(catalog)}

You are running fully offline on this machine. Answer with one JSON object that matches the supplied schema and nothing else.`,
    },
    ...historyMessages(history),
    { role: "user" as const, content: transcript },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECTOR_TIMEOUT_MS);
  const started = Date.now();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetch(`${DIRECTOR_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: DIRECTOR_MODEL,
        messages,
        temperature: local.director.temperature,
        max_tokens: local.director.max_tokens,
        response_format: {
          type: "json_schema",
          json_schema: { name: "stage_visuals", strict: true, schema },
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return {
        ok: false,
        status: 502,
        error: `Local director model failed: ${detail.slice(0, 400)}`,
      };
    }

    const payload = (await response.json()) as {
      choices?: {
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: { function?: { arguments?: string } }[];
        };
      }[];
      usage?: { completion_tokens?: number };
    };

    const message = payload.choices?.[0]?.message ?? {};
    const candidates = [
      message.tool_calls?.[0]?.function?.arguments,
      message.content,
      message.reasoning_content,
    ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

    for (const candidate of candidates) {
      const command = extractCommand(candidate);
      if (command) {
        const sceneIndex = Array.isArray(history) ? history.length : 0;
        return {
          ok: true,
          command: applyAccentRotation(sanitizeCommand(command, assetIds), sceneIndex),
          model: DIRECTOR_MODEL,
          elapsedMs: Date.now() - started,
          completionTokens: payload.usage?.completion_tokens ?? null,
        };
      }
    }

    return {
      ok: false,
      status: 502,
      error: "The local director model did not return a usable scene command.",
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error:
        error instanceof Error
          ? `Local director model is unreachable: ${error.message}`
          : "The local director model is unreachable.",
    };
  } finally {
    clearTimeout(timer);
  }
}
