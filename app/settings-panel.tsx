"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_ENDPOINTS,
  DIRECTOR_PROVIDER_LABELS,
  IMAGERY_PROVIDER_LABELS,
  TRANSCRIBER_PROVIDER_LABELS,
  type DirectorProvider,
  type ImageryProvider,
  type PublicSettings,
  type TranscriberProvider,
  type VoicePipeline,
} from "@/lib/settings-types";

/**
 * Settings for every model backend ZeroPrep talks to.
 *
 * The panel edits a draft and sends one patch on save, so a half-typed endpoint
 * never reaches a running session. Secrets are write-only: the server only says
 * whether a key is set, and `""` is the explicit way to clear one.
 *
 * Field values are captured as arguments to `update()` rather than read from the
 * event inside the state updater, because React may invoke an updater more than
 * once and a lazily read DOM value would not be stable.
 */

type KeyDraft = { director: string; transcriber: string; imagery: string; cloud: string };
type KeyClear = { director: boolean; transcriber: boolean; imagery: boolean; cloud: boolean };

const EMPTY_KEYS: KeyDraft = { director: "", transcriber: "", imagery: "", cloud: "" };
const EMPTY_CLEARS: KeyClear = { director: false, transcriber: false, imagery: false, cloud: false };

const MODEL_HINTS: Record<ImageryProvider, string> = {
  comfyui: "Checkpoint file name inside ComfyUI",
  gemini: "gemini-3.1-flash-lite-image",
  openai: "gpt-image-1",
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function ApiKeyField({
  value,
  isSet,
  placeholder,
  onChange,
  onClear,
  cleared,
}: {
  value: string;
  isSet: boolean;
  placeholder: string;
  onChange: (next: string) => void;
  onClear: () => void;
  cleared: boolean;
}) {
  return (
    <Field label="API key">
      <div className="settings-key-row">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={
            cleared ? "will be cleared on save" : isSet ? "•••••• saved — type to replace" : placeholder
          }
          onChange={(event) => onChange(event.target.value)}
        />
        {isSet && !cleared && (
          <button type="button" className="settings-mini-button" onClick={onClear}>
            Clear
          </button>
        )}
        {cleared && (
          <button type="button" className="settings-mini-button" onClick={() => onChange("")}>
            Undo
          </button>
        )}
      </div>
    </Field>
  );
}

export default function BackendSettingsPanel({
  onSaved,
  disabled,
}: {
  onSaved: (settings: PublicSettings) => void;
  disabled: boolean;
}) {
  const [loaded, setLoaded] = useState<PublicSettings | null>(null);
  const [draft, setDraft] = useState<PublicSettings | null>(null);
  const [keys, setKeys] = useState<KeyDraft>(EMPTY_KEYS);
  const [clears, setClears] = useState<KeyClear>(EMPTY_CLEARS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Held in a ref so a parent re-render cannot change `apply`'s identity. If it
  // could, the load effect below would re-run, re-fetch, and wipe a draft the
  // presenter is still editing.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const apply = useCallback((settings: PublicSettings) => {
    setLoaded(settings);
    setDraft(settings);
    setKeys(EMPTY_KEYS);
    setClears(EMPTY_CLEARS);
    onSavedRef.current(settings);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/settings", { cache: "no-store" });
        if (!response.ok || cancelled) return;
        apply((await response.json()) as PublicSettings);
      } catch {
        // The panel stays empty when the settings route is unavailable.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  /** `value` is captured here, so re-running the updater cannot change the result. */
  const update = useCallback(
    <T,>(value: T, mutate: (next: PublicSettings, value: T) => void) => {
      setDraft((current) => {
        if (!current) return current;
        const next = structuredClone(current);
        mutate(next, value);
        return next;
      });
      setMessage("");
      setError("");
    },
    [],
  );

  const keyPatch = (name: keyof KeyDraft) => {
    if (clears[name]) return { apiKey: "" };
    if (keys[name]) return { apiKey: keys[name] };
    return {};
  };

  const isDirty =
    Boolean(draft && loaded && JSON.stringify(draft) !== JSON.stringify(loaded)) ||
    Object.values(keys).some(Boolean) ||
    Object.values(clears).some(Boolean);

  const submit = async (method: "POST" | "DELETE", body?: unknown, success = "Saved.") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings", {
        method,
        ...(body
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      const payload = (await response.json()) as PublicSettings & { error?: string };
      if (!response.ok) throw new Error(payload.error || "The settings could not be saved.");
      apply(payload);
      setMessage(success);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!draft) return;
    return submit(
      "POST",
      {
        voice: { pipeline: draft.voice.pipeline },
        director: {
          provider: draft.director.provider,
          baseUrl: draft.director.baseUrl,
          model: draft.director.model,
          temperature: draft.director.temperature,
          maxTokens: draft.director.maxTokens,
          ...keyPatch("director"),
        },
        transcriber: {
          provider: draft.transcriber.provider,
          baseUrl: draft.transcriber.baseUrl,
          model: draft.transcriber.model,
          language: draft.transcriber.language,
          ...keyPatch("transcriber"),
        },
        imagery: {
          enabled: draft.imagery.enabled,
          provider: draft.imagery.provider,
          baseUrl: draft.imagery.baseUrl,
          model: draft.imagery.model,
          width: draft.imagery.width,
          height: draft.imagery.height,
          steps: draft.imagery.steps,
          cfg: draft.imagery.cfg,
          ...keyPatch("imagery"),
        },
        cloud: keyPatch("cloud"),
      },
      "Saved. They apply to the next session.",
    );
  };

  if (!draft) {
    return <div className="backend-settings is-loading">Loading settings…</div>;
  }

  const locked = (field: string) => draft.envLocked.includes(field);

  return (
    <div className="backend-settings">
      <div className="settings-group">
        <div className="settings-group-heading">
          <span>VOICE PIPELINE</span>
          <strong>How speech becomes scenes</strong>
        </div>
        <div className="model-options" role="radiogroup" aria-label="Voice pipeline">
          {(
            [
              { id: "local", label: "Local machine (offline)", description: "Local speech + local director" },
              { id: "cloud", label: "OpenAI Realtime (cloud)", description: "Needs an OpenAI key below" },
            ] as { id: VoicePipeline; label: string; description: string }[]
          ).map((option) => {
            const isSelected = draft.voice.pipeline === option.id;
            return (
              <button
                key={option.id}
                className={isSelected ? "is-selected" : ""}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() =>
                  update(option.id, (next, value) => {
                    next.voice.pipeline = value;
                  })
                }
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <i>{option.id === "local" ? "OFFLINE" : "CLOUD"}</i>
              </button>
            );
          })}
        </div>
      </div>

      <div className={`settings-group ${draft.imagery.enabled ? "" : "is-off"}`}>
        <div className="settings-group-heading">
          <span>IMAGE GENERATION</span>
          <label className="settings-switch">
            <input
              type="checkbox"
              checked={draft.imagery.enabled}
              onChange={(event) =>
                update(event.target.checked, (next, value) => {
                  next.imagery.enabled = value;
                })
              }
            />
            <span>{draft.imagery.enabled ? "ON" : "OFF"}</span>
          </label>
        </div>
        {draft.imagery.enabled ? (
          <>
            <Field label="Provider">
              <select
                value={draft.imagery.provider}
                onChange={(event) =>
                  update(event.target.value as ImageryProvider, (next, provider) => {
                    const previousDefault = DEFAULT_ENDPOINTS[next.imagery.provider];
                    if (!next.imagery.baseUrl || next.imagery.baseUrl === previousDefault) {
                      next.imagery.baseUrl = DEFAULT_ENDPOINTS[provider];
                    }
                    next.imagery.provider = provider;
                    if (provider === "openai" && next.imagery.model.includes("safetensors")) {
                      next.imagery.model = "gpt-image-1";
                    }
                  })
                }
              >
                {(Object.keys(IMAGERY_PROVIDER_LABELS) as ImageryProvider[]).map((provider) => (
                  <option key={provider} value={provider}>
                    {IMAGERY_PROVIDER_LABELS[provider]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Endpoint">
              <input
                type="url"
                value={draft.imagery.baseUrl}
                placeholder={DEFAULT_ENDPOINTS[draft.imagery.provider]}
                onChange={(event) =>
                  update(event.target.value, (next, value) => {
                    next.imagery.baseUrl = value;
                  })
                }
              />
            </Field>
            <Field
              label={draft.imagery.provider === "comfyui" ? "Checkpoint" : "Model"}
              hint={MODEL_HINTS[draft.imagery.provider]}
            >
              <input
                type="text"
                value={draft.imagery.model}
                disabled={locked("imagery.model")}
                onChange={(event) =>
                  update(event.target.value, (next, value) => {
                    next.imagery.model = value;
                  })
                }
              />
            </Field>
            {draft.imagery.provider !== "comfyui" && (
              <ApiKeyField
                value={keys.imagery}
                isSet={draft.imagery.apiKeySet}
                cleared={clears.imagery}
                placeholder={draft.imagery.provider === "gemini" ? "Google AI Studio key" : "sk-…"}
                onChange={(next) => {
                  setKeys((current) => ({ ...current, imagery: next }));
                  setMessage("");
                }}
                onClear={() => setClears((current) => ({ ...current, imagery: true }))}
              />
            )}
            {draft.imagery.provider === "comfyui" && (
              <div className="settings-row">
                <Field label="Width">
                  <input
                    type="number"
                    min={256}
                    max={2048}
                    step={64}
                    value={draft.imagery.width}
                    onChange={(event) =>
                      update(Number(event.target.value), (next, value) => {
                        next.imagery.width = value;
                      })
                    }
                  />
                </Field>
                <Field label="Height">
                  <input
                    type="number"
                    min={256}
                    max={2048}
                    step={64}
                    value={draft.imagery.height}
                    onChange={(event) =>
                      update(Number(event.target.value), (next, value) => {
                        next.imagery.height = value;
                      })
                    }
                  />
                </Field>
                <Field label="Steps">
                  <input
                    type="number"
                    min={1}
                    max={150}
                    value={draft.imagery.steps}
                    onChange={(event) =>
                      update(Number(event.target.value), (next, value) => {
                        next.imagery.steps = value;
                      })
                    }
                  />
                </Field>
              </div>
            )}
          </>
        ) : (
          <p className="settings-note">
            Scenes build with text, icons, motion, and layout only. Images you upload and place
            yourself still appear.
          </p>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-heading">
          <span>DIRECTOR LLM</span>
          <strong>Turns speech into scenes</strong>
        </div>
        <Field label="Provider">
          <select
            value={draft.director.provider}
            onChange={(event) =>
              update(event.target.value as DirectorProvider, (next, value) => {
                next.director.provider = value;
              })
            }
          >
            {(Object.keys(DIRECTOR_PROVIDER_LABELS) as DirectorProvider[]).map((provider) => (
              <option key={provider} value={provider}>
                {DIRECTOR_PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Endpoint">
          <input
            type="url"
            value={draft.director.baseUrl}
            placeholder="http://127.0.0.1:1234/v1"
            disabled={locked("director.baseUrl")}
            onChange={(event) =>
              update(event.target.value, (next, value) => {
                next.director.baseUrl = value;
              })
            }
          />
        </Field>
        <Field label="Model">
          <input
            type="text"
            value={draft.director.model}
            disabled={locked("director.model")}
            onChange={(event) =>
              update(event.target.value, (next, value) => {
                next.director.model = value;
              })
            }
          />
        </Field>
        <ApiKeyField
          value={keys.director}
          isSet={draft.director.apiKeySet}
          cleared={clears.director}
          placeholder="sk-… (leave empty for a local server)"
          onChange={(next) => {
            setKeys((current) => ({ ...current, director: next }));
            setMessage("");
          }}
          onClear={() => setClears((current) => ({ ...current, director: true }))}
        />
        <Field label="Temperature">
          <input
            type="number"
            min={0}
            max={2}
            step={0.05}
            value={draft.director.temperature}
            onChange={(event) =>
              update(Number(event.target.value), (next, value) => {
                next.director.temperature = value;
              })
            }
          />
        </Field>
      </div>

      <div className="settings-group">
        <div className="settings-group-heading">
          <span>SPEECH TO TEXT</span>
          <strong>Hears the presenter</strong>
        </div>
        <Field label="Provider">
          <select
            value={draft.transcriber.provider}
            onChange={(event) =>
              update(event.target.value as TranscriberProvider, (next, value) => {
                next.transcriber.provider = value;
              })
            }
          >
            {(Object.keys(TRANSCRIBER_PROVIDER_LABELS) as TranscriberProvider[]).map((provider) => (
              <option key={provider} value={provider}>
                {TRANSCRIBER_PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Endpoint"
          hint={
            draft.transcriber.provider === "local"
              ? "The local Whisper service"
              : "Base URL only; /audio/transcriptions is appended"
          }
        >
          <input
            type="url"
            value={draft.transcriber.baseUrl}
            placeholder="http://127.0.0.1:8099"
            disabled={locked("transcriber.baseUrl")}
            onChange={(event) =>
              update(event.target.value, (next, value) => {
                next.transcriber.baseUrl = value;
              })
            }
          />
        </Field>
        {draft.transcriber.provider === "custom" && (
          <>
            <Field label="Model" hint="whisper-1 for OpenAI">
              <input
                type="text"
                value={draft.transcriber.model}
                disabled={locked("transcriber.model")}
                onChange={(event) =>
                  update(event.target.value, (next, value) => {
                    next.transcriber.model = value;
                  })
                }
              />
            </Field>
            <ApiKeyField
              value={keys.transcriber}
              isSet={draft.transcriber.apiKeySet}
              cleared={clears.transcriber}
              placeholder="sk-…"
              onChange={(next) => {
                setKeys((current) => ({ ...current, transcriber: next }));
                setMessage("");
              }}
              onClear={() => setClears((current) => ({ ...current, transcriber: true }))}
            />
          </>
        )}
        <Field label="Language" hint="Leave empty to auto-detect">
          <input
            type="text"
            value={draft.transcriber.language}
            placeholder="en, fa, …"
            onChange={(event) =>
              update(event.target.value, (next, value) => {
                next.transcriber.language = value;
              })
            }
          />
        </Field>
      </div>

      <div className="settings-group">
        <div className="settings-group-heading">
          <span>CLOUD KEY</span>
          <strong>Only for the OpenAI Realtime pipeline</strong>
        </div>
        <ApiKeyField
          value={keys.cloud}
          isSet={draft.cloud.openaiApiKeySet}
          cleared={clears.cloud}
          placeholder="sk-…"
          onChange={(next) => {
            setKeys((current) => ({ ...current, cloud: next }));
            setMessage("");
          }}
          onClear={() => setClears((current) => ({ ...current, cloud: true }))}
        />
      </div>

      <div className="settings-actions">
        <button type="button" onClick={() => void save()} disabled={busy || disabled || !isDirty}>
          {busy ? "Saving…" : "Save settings"}
        </button>
        <button
          type="button"
          className="settings-secondary"
          onClick={() => void submit("DELETE", undefined, "Back to the local defaults.")}
          disabled={busy || disabled}
        >
          Restore local defaults
        </button>
      </div>
      {disabled && <p className="settings-note">Stop the presentation to change settings.</p>}
      {message && <p className="settings-saved">{message}</p>}
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}
