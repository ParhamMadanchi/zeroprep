import local from "@/config/local.json";
import {
  COMFY_CHECKPOINT,
  DIRECTOR_MODEL,
  LOCAL_MODE_ENABLED,
  probeLocalBackends,
} from "@/lib/local-backends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tells the browser whether this deployment is running on local models, and
 * which parts of the local stack are actually awake. The client uses this to
 * choose the local voice loop and to explain a missing backend in the UI.
 */
export async function GET() {
  const probes = LOCAL_MODE_ENABLED ? await probeLocalBackends() : [];
  return Response.json(
    {
      mode: LOCAL_MODE_ENABLED ? "local" : "cloud",
      ready: LOCAL_MODE_ENABLED && probes.every((probe) => probe.ok),
      director: { model: DIRECTOR_MODEL },
      imagery: { checkpoint: COMFY_CHECKPOINT, provider: local.imagery.provider },
      voice: local.voice,
      probes,
      checked_at: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
