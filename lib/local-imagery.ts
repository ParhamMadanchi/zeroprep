import local from "@/config/local.json";
import { imageryConfig } from "@/lib/local-backends";

/**
 * Local scene imagery through ComfyUI.
 *
 * The cloud path uses Gemini, which accepts a paragraph and an attached
 * reference image. A local Stable Diffusion checkpoint needs a different
 * contract: a comma-separated visual description, a negative prompt, and an
 * explicit "do not draw text" instruction. The scene semantics handed to both
 * backends stay the same.
 */

export type LocalImageryScene = {
  sceneId: string;
  kind: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  metric: string;
  metricLabel: string;
  quote: string;
  cards: { title: string; body: string }[];
  accent: string;
  referenceCount: number;
};

const ACCENT_DESCRIPTIONS: Record<string, string> = {
  ember: "electric orange red",
  lime: "acid lime green",
  sky: "clear cyan blue",
  violet: "luminous violet",
};

function compositionDirection(kind: string) {
  if (kind === "hero") {
    return "one unmistakable hero subject placed slightly off center, clean negative space on the right";
  }
  if (kind === "cards") {
    return "wide establishing scene, clear single center of interest, layered depth";
  }
  if (kind === "metric") {
    return "one bold real world visual metaphor for the idea, centered, simple and graphic";
  }
  return "atmospheric emotionally resonant scene with one clear subject";
}

/** Build a Stable Diffusion friendly prompt from a scene. */
export function buildLocalPrompt(scene: LocalImageryScene) {
  const accent = ACCENT_DESCRIPTIONS[scene.accent] || "acid lime green";
  const subject = [
    scene.title && `main idea: ${scene.title}`,
    scene.subtitle && `context: ${scene.subtitle}`,
    scene.quote && `theme: ${scene.quote}`,
    scene.metric && `concept: ${scene.metric} ${scene.metricLabel}`.trim(),
    scene.cards.length
      ? `related ideas: ${scene.cards.map((card) => [card.title, card.body].filter(Boolean).join(" ")).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");

  const referenceNote = scene.referenceCount
    ? "abstract complementary environment only, no people, no logos, no products"
    : "no logos, no branded products, no identifiable public figures";

  return [
    "editorial presentation background photograph",
    subject,
    "contemporary magazine photography, cinematic still, real three dimensional scene",
    "warm ivory and deep black palette with",
    accent,
    "accents, soft directional lighting, shallow depth of field, rich texture, premium and energetic",
    compositionDirection(scene.kind),
    "16:9 wide composition",
    referenceNote,
    "no text, no words, no letters, no numbers, no captions, no watermarks, no user interface",
  ]
    .filter(Boolean)
    .join(", ");
}

export type LocalPromptScene = LocalImageryScene;

type ComfyImage = { filename: string; subfolder?: string; type?: string };

function txt2imgGraph(options: {
  checkpoint: string;
  positive: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
  seed: number;
}) {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: options.checkpoint } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: options.width, height: options.height, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: options.positive, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: options.negative, clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: options.seed,
        steps: options.steps,
        cfg: options.cfg,
        sampler_name: options.samplerName,
        scheduler: options.scheduler,
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: `zeroprep/${options.seed}`, images: ["8", 0] },
    },
  };
}

function seedFromScene(sceneId: string) {
  let hash = 2166136261;
  for (let index = 0; index < sceneId.length; index += 1) {
    hash ^= sceneId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 2_147_483_647;
}

async function cancelRun(baseUrl: string, promptId: string | null) {
  try {
    if (promptId) {
      await fetch(`${baseUrl}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
      });
    }
    await fetch(`${baseUrl}/interrupt`, { method: "POST" });
  } catch {
    // Cancellation is best effort; a stale image is simply never shown.
  }
}

/**
 * Queue one text-to-image run on the local ComfyUI server and wait for the PNG.
 * The newest scene always wins: an aborted request interrupts its own run.
 */
export async function generateLocalImage(scene: LocalImageryScene, signal: AbortSignal) {
  const config = imageryConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  let promptId: string | null = null;
  const started = Date.now();
  try {
    const graph = txt2imgGraph({
      checkpoint: config.model,
      positive: buildLocalPrompt(scene),
      negative: local.imagery.negative_prompt,
      width: config.width,
      height: config.height,
      steps: config.steps,
      cfg: config.cfg,
      samplerName: local.imagery.sampler_name,
      scheduler: local.imagery.scheduler,
      seed: seedFromScene(scene.sceneId),
    });

    const queued = await fetch(`${config.url}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ prompt: graph, client_id: "zeroprep-local" }),
    });
    if (!queued.ok) {
      return { ok: false as const, error: `ComfyUI rejected the workflow: ${(await queued.text()).slice(0, 300)}` };
    }
    const queuedBody = (await queued.json()) as { prompt_id?: string };
    promptId = queuedBody.prompt_id ?? null;
    if (!promptId) {
      return { ok: false as const, error: "ComfyUI did not return a prompt id." };
    }

    let image: ComfyImage | null = null;
    while (Date.now() - started < config.timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const historyResponse = await fetch(`${config.url}/history/${promptId}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!historyResponse.ok) continue;
      const history = (await historyResponse.json()) as Record<
        string,
        { outputs?: Record<string, { images?: ComfyImage[] }>; status?: { status_str?: string } }
      >;
      const entry = history[promptId];
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        return { ok: false as const, error: "ComfyUI reported an error while rendering this scene." };
      }
      for (const output of Object.values(entry.outputs ?? {})) {
        if (output.images?.length) {
          image = output.images[0];
          break;
        }
      }
      if (image) break;
    }

    if (!image) {
      return { ok: false as const, error: "Local image generation timed out." };
    }

    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? "",
      type: image.type ?? "output",
    });
    const fileResponse = await fetch(`${config.url}/view?${query.toString()}`, {
      signal: controller.signal,
    });
    if (!fileResponse.ok) {
      return { ok: false as const, error: "ComfyUI could not return the rendered image." };
    }

    return {
      ok: true as const,
      bytes: Buffer.from(await fileResponse.arrayBuffer()),
      mimeType: "image/png",
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    if (signal.aborted) {
      await cancelRun(config.url, promptId);
      return { ok: false as const, aborted: true as const, error: "cancelled" };
    }
    const message = error instanceof Error ? error.message : "ComfyUI is unreachable.";
    return { ok: false as const, error: `Local image generation failed: ${message}` };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
