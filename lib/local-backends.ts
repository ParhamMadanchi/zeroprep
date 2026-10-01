import local from "@/config/local.json";
import { imageryApiKey, resolveSettings, type Settings } from "@/lib/settings";

/**
 * Resolves runtime settings into concrete backend clients and health probes.
 *
 * Every backend can either be the local process that ships with this repo or a
 * custom HTTP API the presenter configured, so nothing here assumes "local".
 */

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function directorConfig(settings: Settings = resolveSettings()) {
  return {
    provider: settings.director.provider,
    url: settings.director.baseUrl.replace(/\/+$/, ""),
    model: settings.director.model,
    apiKey: settings.director.apiKey || settings.cloud.openaiApiKey,
    temperature: settings.director.temperature,
    maxTokens: settings.director.maxTokens,
    timeoutMs: envNumber("ZEROPREP_DIRECTOR_TIMEOUT_MS", local.director.timeout_ms),
    historyTurns: local.director.history_turns,
  };
}

export function transcriberConfig(settings: Settings = resolveSettings()) {
  return {
    provider: settings.transcriber.provider,
    url: settings.transcriber.baseUrl.replace(/\/+$/, ""),
    model: settings.transcriber.model,
    apiKey: settings.transcriber.apiKey || settings.cloud.openaiApiKey,
    language: settings.transcriber.language,
    timeoutMs: envNumber("ZEROPREP_ASR_TIMEOUT_MS", local.asr.timeout_ms),
  };
}

export function imageryConfig(settings: Settings = resolveSettings()) {
  return {
    enabled: settings.imagery.enabled,
    provider: settings.imagery.provider,
    url: settings.imagery.baseUrl.replace(/\/+$/, ""),
    model: settings.imagery.model,
    apiKey: imageryApiKey(settings),
    width: settings.imagery.width,
    height: settings.imagery.height,
    steps: settings.imagery.steps,
    cfg: settings.imagery.cfg,
    timeoutMs: envNumber("ZEROPREP_COMFY_TIMEOUT_MS", local.imagery.timeout_ms),
  };
}

export type LocalProbe = {
  id: "voice" | "director" | "asr" | "imagery";
  label: string;
  url: string;
  ok: boolean;
  detail: string;
};

type ProbeResult = { ok: boolean; body: unknown; error?: string };

async function probeJson(
  url: string,
  timeoutMs: number,
  apiKey = "",
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Some endpoints answer with plain text; keep it.
    }
    return { ok: response.ok, body };
  } catch (error) {
    return { ok: false, body: null, error: error instanceof Error ? error.message : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every configured backend so the UI can explain exactly what is missing. */
export async function probeLocalBackends(timeoutMs = 2500): Promise<LocalProbe[]> {
  const settings = resolveSettings();
  const director = directorConfig(settings);
  const transcriber = transcriberConfig(settings);
  const imagery = imageryConfig(settings);

  const [directorProbe, asrProbe, imageryProbe] = await Promise.all([
    probeJson(`${director.url}/models`, timeoutMs, director.apiKey),
    transcriber.provider === "local"
      ? probeJson(`${transcriber.url}/health`, timeoutMs)
      : probeJson(`${transcriber.url}/models`, timeoutMs, transcriber.apiKey),
    imagery.enabled && imagery.provider === "comfyui"
      ? probeJson(`${imagery.url}/system_stats`, timeoutMs)
      : Promise.resolve<ProbeResult>({ ok: true, body: null }),
  ]);

  const directorIds = Array.isArray((directorProbe.body as { data?: unknown })?.data)
    ? ((directorProbe.body as { data: { id?: string }[] }).data
        .map((model) => model.id)
        .filter(Boolean) as string[])
    : [];
  const directorReady =
    directorProbe.ok && (directorIds.length === 0 || directorIds.includes(director.model));

  const asrBody = (asrProbe.body ?? {}) as {
    ok?: boolean;
    model?: string;
    device?: string;
    error?: string;
  };
  const asrReady = transcriber.provider === "local" ? Boolean(asrProbe.ok && asrBody.ok) : asrProbe.ok;

  const imageryStats = (imageryProbe.body ?? {}) as { system?: { comfyui_version?: string } };
  const imageryReady = !imagery.enabled
    ? true
    : imagery.provider === "comfyui"
      ? Boolean(imageryProbe.ok)
      : Boolean(imagery.apiKey);

  return [
    {
      id: "voice",
      label: "Voice pipeline",
      url: "",
      ok: true,
      detail:
        settings.voice.pipeline === "local"
          ? "offline: local speech + local director"
          : "cloud: OpenAI Realtime over WebRTC",
    },
    {
      id: "director",
      label: "Director LLM",
      url: director.url,
      ok: directorReady,
      detail: directorReady
        ? `${director.model}${directorIds.length ? "" : " (server up, no model list)"}`
        : directorProbe.error || `model ${director.model} is not available`,
    },
    {
      id: "asr",
      label: "Speech to text",
      url: transcriber.url,
      ok: asrReady,
      detail:
        transcriber.provider === "local"
          ? asrBody.ok
            ? `${asrBody.model ?? "whisper"} on ${asrBody.device ?? "cpu"}`
            : asrBody.error || asrProbe.error || "transcription service is not ready"
          : asrProbe.ok
            ? `custom API ready${transcriber.model ? ` · ${transcriber.model}` : ""}`
            : asrProbe.error || "custom transcription API is unreachable",
    },
    {
      id: "imagery",
      label: "Image generation",
      url: imagery.enabled ? imagery.url : "",
      ok: imageryReady,
      detail: !imagery.enabled
        ? "disabled in settings"
        : imagery.provider === "comfyui"
          ? imageryProbe.ok
            ? `ComfyUI ${imageryStats.system?.comfyui_version ?? ""} · ${imagery.model}`.trim()
            : imageryProbe.error || "ComfyUI is not reachable"
          : imagery.apiKey
            ? `${imagery.provider} · ${imagery.model}`
            : `${imagery.provider} needs an API key`,
    },
  ];
}
