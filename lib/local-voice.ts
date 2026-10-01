/**
 * Browser-side capture for fully local voice sessions.
 *
 * The cloud path streams the microphone to OpenAI over WebRTC. In local mode
 * the same job is done on this machine, so the browser only has to:
 *
 *   1. capture 16 kHz mono PCM with an AudioWorklet,
 *   2. run an energy VAD to find where a spoken turn ends,
 *   3. POST the utterance to /api/local/transcribe (faster-whisper),
 *   4. POST the transcript to /api/local/director (local LLM),
 *   5. emit the same event objects the Realtime data channel would have sent.
 *
 * Because the emitted events mirror the OpenAI Realtime event names, the page
 * re-uses its existing director handling, scene staging, and UI state.
 */

export type LocalVoiceConfig = {
  sample_rate: number;
  silence_ms: number;
  min_speech_ms: number;
  max_utterance_ms: number;
  partial_interval_ms: number;
  energy_threshold: number;
  noise_floor_ratio: number;
};

export type LocalVoiceEvent =
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | { type: "conversation.item.input_audio_transcription.delta"; delta: string }
  | { type: "conversation.item.input_audio_transcription.completed"; transcript: string }
  | { type: "response.function_call_arguments.done"; call_id: string; arguments: string }
  | { type: "error"; error: { message: string } };

export type LocalVoiceSession = {
  stop: () => void;
  isActive: () => boolean;
};

const WORKLET_SOURCE = `
class ZeroPrepCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("zeroprep-capture", ZeroPrepCapture);
`;

function encodeWav(frames: Float32Array[], sampleRate: number) {
  const sampleCount = frames.reduce((total, frame) => total + frame.length, 0);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let offset = 44;
  for (const frame of frames) {
    for (let index = 0; index < frame.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, frame[index]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

function rootMeanSquare(frame: Float32Array) {
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) sum += frame[index] * frame[index];
  return Math.sqrt(sum / frame.length);
}

export type StartLocalVoiceOptions = {
  microphoneId?: string;
  config: LocalVoiceConfig;
  assetCatalogHeader: () => string;
  onEvent: (event: LocalVoiceEvent) => void;
};

export async function startLocalVoiceSession(
  options: StartLocalVoiceOptions,
): Promise<LocalVoiceSession> {
  const { config, onEvent, assetCatalogHeader } = options;
  const sampleRate = config.sample_rate || 16000;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(options.microphoneId ? { deviceId: { exact: options.microphoneId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const context = new AudioContext({ sampleRate });
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  let node: AudioWorkletNode;
  try {
    await context.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(context, "zeroprep-capture");
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const source = context.createMediaStreamSource(stream);
  source.connect(node);
  // The worklet only measures; a muted sink keeps the graph pulling frames.
  const sink = context.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(context.destination);

  const frameMs = 1000 / (sampleRate / 128);
  const prerollFrames: Float32Array[] = [];
  const prerollLimit = Math.ceil(400 / frameMs);
  let utterance: Float32Array[] = [];
  let speaking = false;
  let voicedMs = 0;
  let silenceMs = 0;
  let noiseFloor = 0.004;
  let lastPartialAt = 0;
  let lastPartialText = "";
  let partialInFlight = false;
  let finalizing = false;
  let stopped = false;
  const history: { transcript: string; command: unknown }[] = [];
  let callCounter = 0;

  const post = async (path: string, body: Blob | string, headers: Record<string, string>) => {
    const response = await fetch(path, { method: "POST", headers, body });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: string }).error || message;
      } catch {
        // keep the raw text
      }
      throw new Error(message);
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  const transcribe = async (frames: Float32Array[], partial: boolean) => {
    const blob = encodeWav(frames, sampleRate);
    if (blob.size < 44 + sampleRate) return "";
    const result = await post(
      `/api/local/transcribe${partial ? "?partial=1" : ""}`,
      blob,
      { "Content-Type": "audio/wav" },
    );
    return String(result.text || "").trim();
  };

  const runDirector = async (transcript: string) => {
    const result = await post(
      "/api/local/director",
      JSON.stringify({ transcript, history: history.slice(-6) }),
      { "Content-Type": "application/json", "X-ZeroPrep-Asset-Catalog": assetCatalogHeader() },
    );
    const command = result.command as Record<string, unknown> | undefined;
    if (!command) throw new Error("The local director returned no scene command.");
    history.push({ transcript, command });
    callCounter += 1;
    onEvent({
      type: "response.function_call_arguments.done",
      call_id: `local-turn-${Date.now()}-${callCounter}`,
      arguments: JSON.stringify(command),
    });
  };

  const finalize = async () => {
    if (finalizing) return;
    finalizing = true;
    const frames = utterance;
    utterance = [];
    speaking = false;
    silenceMs = 0;
    voicedMs = 0;
    lastPartialText = "";
    onEvent({ type: "input_audio_buffer.speech_stopped" });

    try {
      const transcript = await transcribe(frames, false);
      if (stopped) return;
      if (!transcript) {
        return;
      }
      onEvent({ type: "conversation.item.input_audio_transcription.completed", transcript });
      await runDirector(transcript);
    } catch (error) {
      if (stopped) return;
      onEvent({
        type: "error",
        error: {
          message:
            error instanceof Error
              ? error.message
              : "The local voice pipeline could not complete this turn.",
        },
      });
    } finally {
      finalizing = false;
    }
  };

  const handleFrame = (frame: Float32Array) => {
    if (stopped) return;
    const level = rootMeanSquare(frame);
    // The noise floor only tracks quiet frames. Letting it follow every frame
    // would let a presenter who speaks without pausing raise the threshold
    // above their own voice, and the turn would never be detected.
    const ceiling = config.energy_threshold * config.noise_floor_ratio;
    const threshold = Math.max(
      config.energy_threshold,
      Math.min(noiseFloor, ceiling) * config.noise_floor_ratio,
    );
    if (level <= threshold) {
      noiseFloor = noiseFloor * 0.95 + level * 0.05;
    } else if (level < threshold * 1.5) {
      noiseFloor = noiseFloor * 0.999 + level * 0.001;
    }

    if (!speaking) {
      prerollFrames.push(frame);
      if (prerollFrames.length > prerollLimit) prerollFrames.shift();

      if (level > threshold) {
        voicedMs += frameMs;
        if (voicedMs >= config.min_speech_ms) {
          speaking = true;
          silenceMs = 0;
          utterance = [...prerollFrames];
          prerollFrames.length = 0;
          lastPartialAt = performance.now();
          onEvent({ type: "input_audio_buffer.speech_started" });
        }
      } else {
        voicedMs = 0;
      }
      return;
    }

    utterance.push(frame);
    if (level > threshold) silenceMs = 0;
    else silenceMs += frameMs;

    const durationMs = utterance.length * frameMs;
    if (silenceMs >= config.silence_ms || durationMs >= config.max_utterance_ms) {
      void finalize();
      return;
    }

    // Live partial transcript while the presenter is still talking.
    const now = performance.now();
    if (
      !partialInFlight &&
      config.partial_interval_ms > 0 &&
      now - lastPartialAt >= config.partial_interval_ms &&
      durationMs > 900
    ) {
      lastPartialAt = now;
      partialInFlight = true;
      const snapshot = utterance.slice();
      void transcribe(snapshot, true)
        .then((partial) => {
          if (stopped || !partial || partial === lastPartialText) return;
          const delta = partial.startsWith(lastPartialText)
            ? partial.slice(lastPartialText.length)
            : partial;
          lastPartialText = partial;
          if (delta.trim()) {
            onEvent({ type: "conversation.item.input_audio_transcription.delta", delta });
          }
        })
        .catch(() => {
          // Partials are best effort and never interrupt the session.
        })
        .finally(() => {
          partialInFlight = false;
        });
    }
  };

  // Firefox does not deliver AudioWorklet port messages through `onmessage`;
  // an explicit listener plus start() is reliable in both Firefox and Chrome.
  const onFrame = (event: MessageEvent<Float32Array>) => handleFrame(event.data);
  node.port.addEventListener("message", onFrame);
  node.port.start();
  await context.resume();

  return {
    isActive: () => !stopped,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (speaking && utterance.length) {
        // Flush a turn that was already in progress when the presenter stopped.
        const frames = utterance;
        utterance = [];
        speaking = false;
        void transcribe(frames, false)
          .then((transcript) => {
            if (transcript) {
              onEvent({ type: "conversation.item.input_audio_transcription.completed", transcript });
            }
          })
          .catch(() => undefined);
      }
      node.port.removeEventListener("message", onFrame);
      try {
        source.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {
        // Graph may already be torn down.
      }
      void context.close();
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
