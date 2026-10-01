import local from "@/config/local.json";
import { probeLocalBackends } from "@/lib/local-backends";
import { publicSettings, resolveSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tells the browser which voice pipeline to use and whether every backend that
 * pipeline needs is awake. The client reads this on load to decide between the
 * offline loop and the OpenAI Realtime session, and to explain a missing
 * backend in the UI.
 */
export async function GET() {
  const settings = resolveSettings();
  const probes = await probeLocalBackends();
  // Imagery is optional, so it never blocks starting a presentation.
  const required =
    settings.voice.pipeline === "local"
      ? probes.filter((probe) => probe.id !== "imagery")
      : probes.filter((probe) => probe.id === "voice");

  return Response.json(
    {
      mode: settings.voice.pipeline === "local" ? "local" : "cloud",
      ready: required.every((probe) => probe.ok),
      director: { model: settings.director.model, provider: settings.director.provider },
      transcriber: { provider: settings.transcriber.provider },
      imagery: {
        enabled: settings.imagery.enabled,
        provider: settings.imagery.provider,
        model: settings.imagery.model,
      },
      voice: local.voice,
      probes,
      settings: publicSettings(settings),
      checked_at: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
