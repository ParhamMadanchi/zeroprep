import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import local from "@/config/local.json";
import type { PublicSettings, Settings } from "@/lib/settings-types";

export type {
  DirectorProvider,
  ImageryProvider,
  PublicSettings,
  Settings,
  TranscriberProvider,
  VoicePipeline,
} from "@/lib/settings-types";

/**
 * Runtime settings for every model backend the app can talk to.
 *
 * Resolution order, weakest first:
 *   1. `config/local.json` — the shipped defaults, which point at this machine.
 *   2. environment variables — how `local/start-local.sh` and deployments
 *      override a single value without touching files.
 *   3. `config/settings.local.json` — what the presenter saved in the settings
 *      panel. This wins, because it is the most recent and most explicit choice.
 *
 * The file is gitignored and lives only on this machine.
 */

const SETTINGS_PATH = join(process.cwd(), "config", "settings.local.json");

function envText(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function defaultSettings(): Settings {
  return {
    version: 1,
    voice: {
      pipeline: process.env.ZEROPREP_LOCAL === "0" ? "cloud" : "local",
    },
    director: {
      provider: "local",
      baseUrl: envText("ZEROPREP_DIRECTOR_URL") || local.director.url,
      model: envText("ZEROPREP_DIRECTOR_MODEL") || local.director.model,
      apiKey: "",
      temperature: local.director.temperature,
      maxTokens: local.director.max_tokens,
    },
    transcriber: {
      provider: "local",
      baseUrl: envText("ZEROPREP_ASR_URL") || local.asr.url,
      model: envText("ZEROPREP_ASR_MODEL"),
      apiKey: "",
      language: envText("ZEROPREP_ASR_LANGUAGE") || local.asr.language,
    },
    imagery: {
      enabled: true,
      provider: "comfyui",
      baseUrl: envText("ZEROPREP_COMFY_URL") || local.imagery.url,
      model: envText("ZEROPREP_COMFY_CHECKPOINT") || local.imagery.checkpoint,
      apiKey: "",
      width: local.imagery.width,
      height: local.imagery.height,
      steps: local.imagery.steps,
      cfg: local.imagery.cfg,
    },
    cloud: {
      openaiApiKey: envText("OPENAI_API_KEY"),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(patch)) return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in result)) continue;
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

export function cleanText(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function httpUrl(value: unknown, fallback: string) {
  const text = cleanText(value, 300).replace(/\/+$/, "");
  if (!text) return fallback;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : fallback;
  } catch {
    return fallback;
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function choice<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/** Coerce whatever is on disk or on the wire into a usable settings object. */
export function normalizeSettings(input: unknown): Settings {
  const defaults = defaultSettings();
  const merged = deepMerge(defaults, input);

  return {
    version: 1,
    voice: {
      pipeline: choice(merged.voice.pipeline, ["local", "cloud"] as const, defaults.voice.pipeline),
    },
    director: {
      provider: choice(merged.director.provider, ["local", "custom"] as const, defaults.director.provider),
      baseUrl: httpUrl(merged.director.baseUrl, defaults.director.baseUrl),
      model: cleanText(merged.director.model, 200) || defaults.director.model,
      apiKey: cleanText(merged.director.apiKey, 400),
      temperature: boundedNumber(merged.director.temperature, defaults.director.temperature, 0, 2),
      maxTokens: Math.round(boundedNumber(merged.director.maxTokens, defaults.director.maxTokens, 64, 8192)),
    },
    transcriber: {
      provider: choice(merged.transcriber.provider, ["local", "custom"] as const, defaults.transcriber.provider),
      baseUrl: httpUrl(merged.transcriber.baseUrl, defaults.transcriber.baseUrl),
      model: cleanText(merged.transcriber.model, 200),
      apiKey: cleanText(merged.transcriber.apiKey, 400),
      language: cleanText(merged.transcriber.language, 16),
    },
    imagery: {
      enabled: merged.imagery.enabled !== false,
      provider: choice(merged.imagery.provider, ["comfyui", "gemini", "openai"] as const, defaults.imagery.provider),
      baseUrl: httpUrl(merged.imagery.baseUrl, defaults.imagery.baseUrl),
      model: cleanText(merged.imagery.model, 200) || defaults.imagery.model,
      apiKey: cleanText(merged.imagery.apiKey, 400),
      width: Math.round(boundedNumber(merged.imagery.width, defaults.imagery.width, 256, 2048)),
      height: Math.round(boundedNumber(merged.imagery.height, defaults.imagery.height, 256, 2048)),
      steps: Math.round(boundedNumber(merged.imagery.steps, defaults.imagery.steps, 1, 150)),
      cfg: boundedNumber(merged.imagery.cfg, defaults.imagery.cfg, 0, 30),
    },
    cloud: {
      openaiApiKey: cleanText(merged.cloud.openaiApiKey, 400) || envText("OPENAI_API_KEY"),
    },
  };
}

let cache: { key: string; settings: Settings } | null = null;

function fileMtime(): number | null {
  try {
    return statSync(SETTINGS_PATH).mtimeMs;
  } catch {
    return null;
  }
}

function cacheKey(mtime: number | null) {
  return mtime === null ? "defaults" : String(mtime);
}

function readStored(): unknown {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** Effective settings for a request; re-read whenever the file changes. */
export function resolveSettings(): Settings {
  const mtime = fileMtime();
  const key = cacheKey(mtime);
  if (cache && cache.key === key) return cache.settings;
  const settings = mtime === null ? normalizeSettings(null) : normalizeSettings(readStored());
  cache = { key, settings };
  return settings;
}

/**
 * Merge a patch from the settings panel and persist it.
 * An omitted key keeps its current value; `""` clears text fields.
 */
export function saveSettings(patch: unknown): Settings {
  const merged = normalizeSettings(deepMerge(resolveSettings(), patch));
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  cache = { key: cacheKey(fileMtime()), settings: merged };
  return merged;
}

/** Secrets never leave the server; the panel only learns whether one is set. */
export function publicSettings(settings: Settings): PublicSettings {
  return {
    version: settings.version,
    voice: settings.voice,
    director: {
      provider: settings.director.provider,
      baseUrl: settings.director.baseUrl,
      model: settings.director.model,
      temperature: settings.director.temperature,
      maxTokens: settings.director.maxTokens,
      apiKeySet: Boolean(settings.director.apiKey),
    },
    transcriber: {
      provider: settings.transcriber.provider,
      baseUrl: settings.transcriber.baseUrl,
      model: settings.transcriber.model,
      language: settings.transcriber.language,
      apiKeySet: Boolean(settings.transcriber.apiKey),
    },
    imagery: {
      enabled: settings.imagery.enabled,
      provider: settings.imagery.provider,
      baseUrl: settings.imagery.baseUrl,
      model: settings.imagery.model,
      width: settings.imagery.width,
      height: settings.imagery.height,
      steps: settings.imagery.steps,
      cfg: settings.imagery.cfg,
      apiKeySet: Boolean(settings.imagery.apiKey),
    },
    cloud: { openaiApiKeySet: Boolean(settings.cloud.openaiApiKey) },
    envLocked: [
      envText("ZEROPREP_DIRECTOR_URL") && "director.baseUrl",
      envText("ZEROPREP_DIRECTOR_MODEL") && "director.model",
      envText("ZEROPREP_ASR_URL") && "transcriber.baseUrl",
      envText("ZEROPREP_ASR_MODEL") && "transcriber.model",
      envText("ZEROPREP_COMFY_URL") && "imagery.baseUrl",
      envText("ZEROPREP_COMFY_CHECKPOINT") && "imagery.model",
    ].filter((entry): entry is string => Boolean(entry)),
  };
}

/** The API key a backend should use, falling back to the usual environment names. */
export function imageryApiKey(settings: Settings) {
  if (settings.imagery.apiKey) return settings.imagery.apiKey;
  if (settings.imagery.provider === "gemini") {
    return envText("GEMINI_API_KEY") || envText("GOOGLE_API_KEY");
  }
  if (settings.imagery.provider === "openai") return settings.cloud.openaiApiKey;
  return "";
}

export function settingsFilePath() {
  return SETTINGS_PATH;
}
