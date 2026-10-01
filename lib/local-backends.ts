import local from "@/config/local.json";

/**
 * Configuration and health probes for the fully local ZeroPrep stack.
 *
 * Local mode replaces the two cloud calls the product normally makes:
 *   - OpenAI Realtime (speech in, director decisions out) -> local ASR + local LLM
 *   - Gemini image generation                            -> local ComfyUI
 *
 * Every value has an environment override so the same build can point at a
 * different machine (a second GPU box, a bigger model server) without edits.
 */

function envString(name: string, fallback: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Local mode is on unless ZEROPREP_LOCAL=0, so a cloned checkout just works. */
export const LOCAL_MODE_ENABLED =
  process.env.ZEROPREP_LOCAL !== "0" && local.enabled_by_default !== false;

export const DIRECTOR_URL = envString("ZEROPREP_DIRECTOR_URL", local.director.url).replace(/\/+$/, "");
export const DIRECTOR_MODEL = envString("ZEROPREP_DIRECTOR_MODEL", local.director.model);
export const DIRECTOR_TIMEOUT_MS = envNumber("ZEROPREP_DIRECTOR_TIMEOUT_MS", local.director.timeout_ms);

export const ASR_URL = envString("ZEROPREP_ASR_URL", local.asr.url).replace(/\/+$/, "");
export const ASR_LANGUAGE = envString("ZEROPREP_ASR_LANGUAGE", local.asr.language);
export const ASR_TIMEOUT_MS = envNumber("ZEROPREP_ASR_TIMEOUT_MS", local.asr.timeout_ms);

export const COMFY_URL = envString("ZEROPREP_COMFY_URL", local.imagery.url).replace(/\/+$/, "");
export const COMFY_CHECKPOINT = envString("ZEROPREP_COMFY_CHECKPOINT", local.imagery.checkpoint);
export const COMFY_TIMEOUT_MS = envNumber("ZEROPREP_COMFY_TIMEOUT_MS", local.imagery.timeout_ms);

export type LocalProbe = {
  id: "director" | "asr" | "imagery";
  label: string;
  url: string;
  ok: boolean;
  detail: string;
};

async function probeJson(url: string, timeoutMs: number): Promise<{ ok: boolean; body: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Leave the raw text in place; some endpoints answer with plain text.
    }
    return { ok: response.ok, body };
  } catch (error) {
    return { ok: false, body: null, error: error instanceof Error ? error.message : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every local backend so the UI can explain exactly what is missing. */
export async function probeLocalBackends(timeoutMs = 2500): Promise<LocalProbe[]> {
  const [director, asr, imagery] = await Promise.all([
    probeJson(`${DIRECTOR_URL}/models`, timeoutMs),
    probeJson(`${ASR_URL}/health`, timeoutMs),
    probeJson(`${COMFY_URL}/system_stats`, timeoutMs),
  ]);

  const directorIds = Array.isArray((director.body as { data?: unknown })?.data)
    ? ((director.body as { data: { id?: string }[] }).data.map((model) => model.id).filter(Boolean) as string[])
    : [];
  const directorReady = director.ok && (directorIds.length === 0 || directorIds.includes(DIRECTOR_MODEL));

  const asrBody = (asr.body ?? {}) as { ok?: boolean; model?: string; device?: string; error?: string };
  const imageryStats = (imagery.body ?? {}) as { system?: { comfyui_version?: string } };

  return [
    {
      id: "director",
      label: "Director LLM",
      url: DIRECTOR_URL,
      ok: directorReady,
      detail: directorReady
        ? `${DIRECTOR_MODEL}${directorIds.length ? "" : " (server up, load a model)"}`
        : director.error || `model ${DIRECTOR_MODEL} is not loaded`,
    },
    {
      id: "asr",
      label: "Speech to text",
      url: ASR_URL,
      ok: Boolean(asr.ok && asrBody.ok),
      detail: asrBody.ok
        ? `${asrBody.model} on ${asrBody.device}`
        : asrBody.error || asr.error || "transcription service is not ready",
    },
    {
      id: "imagery",
      label: "Image generation",
      url: COMFY_URL,
      ok: Boolean(imagery.ok),
      detail: imagery.ok
        ? `ComfyUI ${imageryStats.system?.comfyui_version ?? ""} · ${COMFY_CHECKPOINT}`.trim()
        : imagery.error || "ComfyUI is not reachable",
    },
  ];
}
