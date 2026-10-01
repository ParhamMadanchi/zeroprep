/**
 * Shared settings shapes.
 *
 * Kept separate from `lib/settings.ts` because that module reads and writes the
 * settings file with `node:fs`, and the browser needs these types too.
 */

export type ImageryProvider = "comfyui" | "gemini" | "openai";
export type DirectorProvider = "local" | "custom";
export type TranscriberProvider = "local" | "custom";
export type VoicePipeline = "local" | "cloud";

export type Settings = {
  version: 1;
  voice: {
    /** "local" runs the offline pipeline; "cloud" uses OpenAI Realtime over WebRTC. */
    pipeline: VoicePipeline;
  };
  director: {
    provider: DirectorProvider;
    baseUrl: string;
    model: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
  };
  transcriber: {
    provider: TranscriberProvider;
    baseUrl: string;
    model: string;
    apiKey: string;
    language: string;
  };
  imagery: {
    enabled: boolean;
    provider: ImageryProvider;
    baseUrl: string;
    model: string;
    apiKey: string;
    width: number;
    height: number;
    steps: number;
    cfg: number;
  };
  cloud: {
    openaiApiKey: string;
  };
};

export type PublicSettings = {
  version: 1;
  voice: Settings["voice"];
  director: Omit<Settings["director"], "apiKey"> & { apiKeySet: boolean };
  transcriber: Omit<Settings["transcriber"], "apiKey"> & { apiKeySet: boolean };
  imagery: Omit<Settings["imagery"], "apiKey"> & { apiKeySet: boolean };
  cloud: { openaiApiKeySet: boolean };
  /** Fields an environment variable owns; the panel shows them as managed. */
  envLocked: string[];
};

export const IMAGERY_PROVIDER_LABELS: Record<ImageryProvider, string> = {
  comfyui: "Local ComfyUI (Stable Diffusion)",
  gemini: "Google Gemini",
  openai: "Custom OpenAI-compatible image API",
};

export const DIRECTOR_PROVIDER_LABELS: Record<DirectorProvider, string> = {
  local: "Local model server (LM Studio, Ollama, llama.cpp)",
  custom: "Custom OpenAI-compatible chat API",
};

export const TRANSCRIBER_PROVIDER_LABELS: Record<TranscriberProvider, string> = {
  local: "Local Whisper service",
  custom: "Custom OpenAI-compatible transcription API",
};

export const DEFAULT_ENDPOINTS = {
  comfyui: "http://127.0.0.1:8188",
  gemini: "https://generativelanguage.googleapis.com",
  openai: "https://api.openai.com/v1",
} as const;
