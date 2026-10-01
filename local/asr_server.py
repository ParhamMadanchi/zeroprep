#!/usr/bin/env python3
"""ZeroPrep local speech-to-text service.

Runs faster-whisper on the local GPU and exposes a tiny HTTP API that the
Next.js app proxies to. Everything stays on this machine: no audio leaves the
box, and the model is loaded from the local Hugging Face cache when present.

    POST /transcribe?language=en&partial=0   body: 16-bit PCM WAV
    GET  /health                             backend + model status
    python3 local/asr_server.py --file clip.wav    one-shot CLI check

The server is intentionally built on the standard library only, so the shared
project virtualenv cannot break it with a dependency upgrade.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DEFAULT_MODEL = os.environ.get("ZEROPREP_ASR_MODEL", "large-v3")
DEFAULT_DEVICE = os.environ.get("ZEROPREP_ASR_DEVICE", "cuda")
DEFAULT_COMPUTE = os.environ.get("ZEROPREP_ASR_COMPUTE", "int8_float16")
MAX_UPLOAD_BYTES = 24 * 1024 * 1024

# Whisper happily invents these when handed silence or noise.
HALLUCINATIONS = {
    "thank you.", "thanks for watching!", "thank you for watching.", "you",
    "bye.", "bye bye.", "please subscribe.", "subtitles by the amara.org community",
    "subscribe to my channel.", "thank you very much.", ".", "..", "...",
    "okay.", "yeah.", "hmm", "mm-hmm.", "[music]", "[applause]", "[silence]",
    "thank you for watching", "thanks for watching",
}


def log(message: str) -> None:
    print(f"[asr] {message}", flush=True)


def clean_transcript(text: str) -> str:
    collapsed = re.sub(r"\s+", " ", text or "").strip()
    if not collapsed:
        return ""
    if collapsed.lower().strip(" .!?") in {item.strip(" .!?") for item in HALLUCINATIONS}:
        return ""
    if sum(char.isalnum() for char in collapsed) < 2:
        return ""
    return collapsed


def wav_to_float32(payload: bytes):
    import numpy as np

    with wave.open(io.BytesIO(payload), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError(f"expected 16-bit PCM, received {width * 8}-bit")
    audio = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        audio = resample(audio, rate, 16000)
    return audio


def resample(audio, source_rate: int, target_rate: int):
    """Linear resample; the browser already sends 16 kHz, this is a safety net."""
    import numpy as np

    if source_rate == target_rate or audio.size == 0:
        return audio
    duration = audio.size / float(source_rate)
    target_length = max(1, int(round(duration * target_rate)))
    source_positions = np.linspace(0.0, duration, num=audio.size, endpoint=False)
    target_positions = np.linspace(0.0, duration, num=target_length, endpoint=False)
    return np.interp(target_positions, source_positions, audio).astype("float32")


class Transcriber:
    """Serialises GPU access; faster-whisper is not safe for parallel calls."""

    def __init__(self, model_name: str, device: str, compute_type: str) -> None:
        from faster_whisper import WhisperModel

        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.lock = threading.Lock()
        started = time.time()
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)
        self.load_seconds = time.time() - started
        log(f"loaded {model_name} on {device}/{compute_type} in {self.load_seconds:.1f}s")

    def transcribe(self, audio, language: str | None, partial: bool, prompt: str | None):
        segments, info = self.model.transcribe(
            audio,
            language=language or None,
            beam_size=1 if partial else 5,
            best_of=1,
            temperature=0.0,
            vad_filter=not partial,
            vad_parameters={"min_silence_duration_ms": 300} if not partial else None,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            initial_prompt=prompt or None,
        )
        text = clean_transcript(" ".join(segment.text for segment in segments))
        return text, info


TRANSCRIBER: Transcriber | None = None
TRANSCRIBER_ERROR: str | None = None


def handle_transcribe(query: dict, payload: bytes) -> tuple[int, dict]:
    if TRANSCRIBER is None:
        return 503, {"error": TRANSCRIBER_ERROR or "ASR model is still loading."}
    if not payload:
        return 400, {"error": "Empty audio payload."}
    language = (query.get("language") or [None])[0]
    partial = (query.get("partial") or ["0"])[0] in {"1", "true", "yes"}
    prompt = (query.get("prompt") or [None])[0]
    try:
        audio = wav_to_float32(payload)
    except Exception as error:  # noqa: BLE001
        return 400, {"error": f"Unreadable WAV audio: {error}"}
    if audio.size < 1600:  # under 100 ms
        return 200, {"text": "", "duration": round(audio.size / 16000.0, 3), "elapsed": 0.0}

    started = time.time()
    with TRANSCRIBER.lock:
        text, info = TRANSCRIBER.transcribe(audio, language, partial, prompt)
    elapsed = time.time() - started
    return 200, {
        "text": text,
        "language": getattr(info, "language", language),
        "language_probability": round(float(getattr(info, "language_probability", 0.0)), 3),
        "duration": round(audio.size / 16000.0, 3),
        "elapsed": round(elapsed, 3),
        "realtime_factor": round(elapsed / max(audio.size / 16000.0, 0.001), 3),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ZeroPrepASR/1.0"

    def log_message(self, fmt, *args):  # keep the console readable
        if os.environ.get("ZEROPREP_ASR_VERBOSE"):
            log(fmt % args)

    def _send(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            ready = TRANSCRIBER is not None
            self._send(200, {
                "ok": ready,
                "error": TRANSCRIBER_ERROR,
                "model": TRANSCRIBER.model_name if ready else DEFAULT_MODEL,
                "device": TRANSCRIBER.device if ready else DEFAULT_DEVICE,
                "compute_type": TRANSCRIBER.compute_type if ready else DEFAULT_COMPUTE,
                "load_seconds": round(TRANSCRIBER.load_seconds, 2) if ready else None,
            })
            return
        self._send(404, {"error": "Not found."})

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/transcribe":
            self._send(404, {"error": "Not found."})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self._send(413, {"error": "Audio payload is missing or too large."})
            return
        payload = self.rfile.read(length)
        try:
            status, body = handle_transcribe(parse_qs(parsed.query), payload)
        except Exception as error:  # noqa: BLE001
            log(f"transcription failed: {type(error).__name__}: {error}")
            status, body = 500, {"error": f"Transcription failed: {error}"}
        self._send(status, body)


def preload(model: str, device: str, compute: str) -> None:
    global TRANSCRIBER, TRANSCRIBER_ERROR
    try:
        TRANSCRIBER = Transcriber(model, device, compute)
    except Exception as error:  # noqa: BLE001
        TRANSCRIBER_ERROR = f"{type(error).__name__}: {error}"
        log(f"model load failed: {TRANSCRIBER_ERROR}")
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="ZeroPrep local ASR service")
    parser.add_argument("--file", help="Transcribe one WAV file and exit")
    parser.add_argument("--language", default=None)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default=DEFAULT_DEVICE)
    parser.add_argument("--compute", default=DEFAULT_COMPUTE)
    parser.add_argument("--host", default=os.environ.get("ZEROPREP_ASR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZEROPREP_ASR_PORT", "8099")))
    args = parser.parse_args()

    preload(args.model, args.device, args.compute)

    if args.file:
        with open(args.file, "rb") as handle:
            audio = wav_to_float32(handle.read())
        started = time.time()
        text, info = TRANSCRIBER.transcribe(audio, args.language, False, None)
        print(json.dumps({
            "text": text,
            "language": getattr(info, "language", None),
            "audio_seconds": round(audio.size / 16000.0, 2),
            "elapsed": round(time.time() - started, 2),
        }, indent=2))
        return 0

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    log(f"serving on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    return 0


if __name__ == "__main__":
    sys.exit(main())
