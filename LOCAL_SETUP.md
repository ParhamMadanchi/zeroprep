# Running ZeroPrep fully locally

ZeroPrep normally talks to two cloud services: OpenAI Realtime for the voice
director and Gemini for scene imagery. This document replaces both with models
that already live on this machine, so a presentation never leaves the box.

| Cloud piece | Local replacement | Where it runs |
| --- | --- | --- |
| OpenAI Realtime (speech in, director decisions out) | faster-whisper `large-v3` + a local instruct LLM | `local/asr_server.py`, LM Studio |
| Gemini image generation | ComfyUI with a local Stable Diffusion checkpoint | ComfyUI HTTP API |
| OpenAI Realtime transport (WebRTC) | browser AudioWorklet + energy VAD + `/api/local/*` | `lib/local-voice.ts` |

The director prompt, the `stage_visuals` schema, and the icon vocabulary are
shared with the cloud path (`lib/director.ts`), so scenes behave the same
whichever backend produced them.

## Run it

```bash
./local/start-local.sh          # everything: models, images, speech, web app
./local/start-local.sh --stop   # stop what the script started
```

Then open <http://127.0.0.1:3000> and press **Start live presentation**.

The header shows a green `LOCAL MACHINE · <model>` badge once every backend has
answered. `http://127.0.0.1:3000/api/local/status` returns the same health check
as JSON.

## What the script starts

| Service | Default port | Notes |
| --- | --- | --- |
| Next.js app | 3000 | `next dev` |
| Director LLM | 1234 | LM Studio headless server, model `zeroprep-director` |
| Image generation | 8188 | the ComfyUI checkout at `ZEROPREP_COMFY_DIR` |
| Speech to text | 8099 | `local/asr_server.py`, faster-whisper on the GPU |

Every path and port is an environment override, so a different machine or a
different ComfyUI checkout works without editing code:

```bash
ZEROPREP_COMFY_DIR=/path/to/ComfyUI \
ZEROPREP_DIRECTOR_MODEL=my-model \
ZEROPREP_ASR_MODEL=medium \
./local/start-local.sh
```

## Configuration

Everything is editable from the **gear button** next to the microphone picker and
saved server-side to `config/settings.local.json` (gitignored):

| Section | What you can change |
| --- | --- |
| Voice pipeline | Local machine (offline) or OpenAI Realtime (cloud) |
| Image generation | **on/off switch**, provider (local ComfyUI / Gemini / any OpenAI-compatible image API), endpoint, model or checkpoint, API key, size, steps |
| Director LLM | Local model server or a custom OpenAI-compatible chat API: endpoint, model, key, temperature |
| Speech to text | Local Whisper service or a custom `/audio/transcriptions` API: endpoint, model, key, language |
| Cloud key | OpenAI key, used only by the cloud pipeline |

Turning **image generation off** stops background generation entirely: scenes are
built from text, icons, motion, and layout, and images you upload yourself still
appear. The header badge shows `IMAGES OFF` so the state is never ambiguous.

API keys are write-only: the server reports only whether one is set, and **Clear**
is the explicit way to remove it. *Restore local defaults* deletes the saved file
and returns to the shipped configuration.

Precedence, weakest first: `config/local.json` → environment variables →
`config/settings.local.json`. The saved file wins because it is the most recent
and most explicit choice; a field an environment variable owns is shown disabled.

What each custom provider expects:

- **Director** — `POST {baseUrl}/chat/completions`, OpenAI-compatible, with
  `Authorization: Bearer <key>`. Works with OpenAI, Groq, OpenRouter, vLLM,
  Ollama (`http://127.0.0.1:11434/v1`), and LM Studio.
- **Speech** — `POST {baseUrl}/audio/transcriptions`, multipart, so OpenAI, Groq,
  and self-hosted Whisper servers all work.
- **Imagery** — `POST {baseUrl}/images/generations`; the response may carry
  `b64_json` or a URL. The configured width/height is mapped to the closest
  supported size (`1536x1024`, `1024x1536`, or `1024x1024`).

`config/local.json` still holds the shipped defaults and the non-editable tuning
(VAD thresholds, negative prompt, sampler). Environment variables override it
(`ZEROPREP_DIRECTOR_URL`, `ZEROPREP_DIRECTOR_MODEL`, `ZEROPREP_ASR_URL`,
`ZEROPREP_ASR_MODEL`, `ZEROPREP_COMFY_URL`, `ZEROPREP_COMFY_CHECKPOINT`,
`ZEROPREP_LOCAL`, `ZEROPREP_LOCAL_IMAGERY`).

Set `ZEROPREP_LOCAL=0` to fall back to the original cloud behaviour, or pick
"OpenAI Realtime (cloud)" in the panel.

### Voice turn detection

The browser captures 16 kHz mono PCM through an AudioWorklet and decides where a
spoken turn ends. `config/local.json → voice` controls it:

- `energy_threshold` (0.012) — absolute level above which a frame counts as speech.
- `noise_floor_ratio` (3) — how far above the measured room noise speech must sit.
  The noise floor only tracks frames below the current threshold; a presenter who
  speaks without pausing can no longer raise the threshold above their own voice.
- `silence_ms` (700) — trailing silence that ends a turn.
- `min_speech_ms` (250) — shortest burst that counts as speech, to reject clicks.
- `max_utterance_ms` (20000) — hard cap so one turn cannot grow without bound.
- `partial_interval_ms` (2000) — how often a partial transcript is requested.

## Hardware notes

The stack is sized for a single 12 GB card and it stays inside it:

| Component | VRAM |
| --- | --- |
| Director LLM (Qwen3.5-9B coder, IQ4_XS) | ~5.0 GiB |
| faster-whisper large-v3 (int8_float16) | ~1.5 GiB |
| ComfyUI SDXL (Juggernaut XL, 1344×768, 28 steps) | ~7 GiB, partially offloaded while the LLM is resident |

Measured on an RTX 4070 Ti: director turns take ~1 s, transcription runs at a
realtime factor of ~0.09, and a scene background renders in ~10–15 s. Imagery is
asynchronous and never blocks the presentation; if ComfyUI is unavailable the
client falls back to the original text, icons, and motion.

To trade quality for speed, drop `steps`, lower `width`/`height`, or point
`ZEROPREP_COMFY_CHECKPOINT` at a lighter SD1.5 checkpoint.

## Director model choice

LM Studio's native tool-call parsing does not round-trip the `stage_visuals`
schema reliably, and its grammar builder rejects `maxItems: 0`, which the shared
schema uses when no assets are uploaded. The local director therefore uses
`response_format: json_schema` with a grammar-safe copy of the schema, and any
asset IDs the model invents are filtered against the real catalog before they
reach the browser (`lib/local-director.ts`).

Any OpenAI-compatible chat endpoint can serve it. To use Ollama instead of
LM Studio:

```bash
ollama serve
ollama pull qwen2.5-coder:14b
ZEROPREP_DIRECTOR_URL=http://127.0.0.1:11434/v1 \
ZEROPREP_DIRECTOR_MODEL=qwen2.5-coder:14b ./local/start-local.sh --app-only
```

Note that Docker cannot see the GPU on this host (no `nvidia-container-toolkit`),
so a native runtime is required for GPU inference.

## Verifying it

```bash
python3 local/test-director-flow.py     # transcript -> scene commands, no browser
python3 local/e2e_voice_test.py         # real Firefox, real speech, full loop
python3 local/e2e_settings_test.py      # the settings panel, through a real browser
python3 local/test_custom_api.py        # every backend pointed at a stand-in API
python3 local/bench-director.py         # compare director models and modes
python3 local/comfy_smoke.py --label sdxl   # one image, with timing
python3 local/asr_server.py --file clip.wav # one transcription
npm test                                # project test suite
```

`local/e2e_voice_test.py` drives headless Firefox through geckodriver, replaces
the microphone with a generated speech recording, and asserts that scenes are
staged; it writes a screenshot to `local/logs/e2e-scene.png`. It needs
`geckodriver` and `ffmpeg` on `PATH`.

## Troubleshooting

**The badge says the local stack is degraded.** Hover it, or read
`/api/local/status`; each probe reports its own URL and error.

**`failed to parse grammar` from the director.** The model server rejected the
JSON schema. `toLocalGrammarSchema()` strips the keywords LM Studio cannot
compile (`maxItems: 0`); if you add schema keywords, keep that in mind.

**A settings change seems to do nothing.** Saving writes
`config/settings.local.json`; the panel reloads itself from it. If a custom
endpoint fails, hover the header badge or open `/api/local/status` — each probe
reports its own URL and error.

**Open the app on `localhost` and `127.0.0.1` interchangeably.** Next.js reports
the request host it was configured with, so `lib/request-guards.ts` treats the
loopback spellings as one host while still comparing protocol and port exactly.
`next.config.ts` also lists them under `allowedDevOrigins`.

**No turns are detected.** Check `local/logs/asr.log` and the browser console. A
very noisy room can keep the noise floor high; lower `voice.energy_threshold` or
raise `voice.noise_floor_ratio`.

**Firefox reports no microphone.** The AudioWorklet port uses an explicit
`addEventListener` + `start()` because Firefox does not deliver worklet port
messages through `onmessage`.
