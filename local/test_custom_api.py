#!/usr/bin/env python3
"""Verify that ZeroPrep can drive custom HTTP APIs instead of the local stack.

Starts a stand-in OpenAI-compatible server, points every backend at it through
the settings API (with an API key), and checks that each route really calls it:

  director    POST /v1/chat/completions
  imagery     POST /v1/images/generations
  speech      POST /v1/audio/transcriptions

The point is to prove the "use our own API" path end to end, including auth.
"""
from __future__ import annotations

import base64
import json
import struct
import sys
import threading
import time
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"
PORT = 8899
API_KEY = "test-key-123"

COMMAND = {
    "action": "replace",
    "assetIds": [],
    "scene": {
        "kind": "hero",
        "title": "Served By Your Own API",
        "icon": "satellite",
        "accent": "sky",
    },
}

received: list[tuple[str, str, str]] = []


def png_bytes(width: int = 8, height: int = 8) -> bytes:
    """A tiny valid PNG so the route has real image bytes to return."""
    raw = b"".join(b"\x00" + bytes([40, 90, 200] * width) for _ in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record(self, path: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        received.append((self.command, path, self.headers.get("Authorization") or ""))

    def do_GET(self):  # noqa: N802
        if self.path.endswith("/models"):
            received.append(("GET", self.path, self.headers.get("Authorization") or ""))
            self._send(200, {"data": [{"id": "fake-director"}, {"id": "fake-images"}]})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        self._record(self.path)
        if self.path.endswith("/chat/completions"):
            self._send(200, {
                "choices": [{"message": {"content": json.dumps(COMMAND)}}],
                "usage": {"completion_tokens": 42},
            })
            return
        if self.path.endswith("/images/generations"):
            self._send(200, {"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}]})
            return
        if self.path.endswith("/audio/transcriptions"):
            self._send(200, {"text": "spoken through a custom api"})
            return
        self._send(404, {"error": "not found"})


def api(path: str, method: str = "GET", payload=None):
    request = urllib.request.Request(
        f"{APP}{path}",
        method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"} if payload is not None else {},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.status, json.load(response)


def log(message: str) -> None:
    print(f"[custom-api] {message}", flush=True)


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.3)

    failures: list[str] = []
    base = f"http://127.0.0.1:{PORT}/v1"
    try:
        # One patch configures every backend to point at the stand-in API.
        api("/api/settings", "POST", {
            "director": {"provider": "custom", "baseUrl": base, "model": "fake-director", "apiKey": API_KEY},
            "transcriber": {"provider": "custom", "baseUrl": base, "model": "whisper-1", "apiKey": API_KEY},
            "imagery": {"enabled": True, "provider": "openai", "baseUrl": base, "model": "fake-images", "apiKey": API_KEY},
        })
        _, settings = api("/api/settings")
        log(f"director -> {settings['director']['provider']} {settings['director']['baseUrl']} keySet={settings['director']['apiKeySet']}")
        log(f"imagery  -> {settings['imagery']['provider']} {settings['imagery']['baseUrl']} keySet={settings['imagery']['apiKeySet']}")
        if settings["director"]["apiKeySet"] is not True:
            failures.append("the director API key was not stored")
        if settings["imagery"]["apiKeySet"] is not True:
            failures.append("the imagery API key was not stored")

        # Director
        _, director = api("/api/local/director", "POST", {"transcript": "hello from the test"})
        log(f"director replied: {director.get('command', {}).get('scene', {}).get('title')!r}")
        if director.get("command", {}).get("scene", {}).get("title") != COMMAND["scene"]["title"]:
            failures.append("the director did not use the custom chat API")

        # Imagery
        request = urllib.request.Request(
            f"{APP}/api/imagery",
            data=json.dumps({"sceneId": "custom-api", "kind": "hero", "title": "Custom API scene"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            image = response.read()
            model_header = response.headers.get("X-ZeroPrep-Image-Model", "")
        log(f"imagery returned {len(image)} bytes via {model_header}")
        if not image.startswith(b"\x89PNG"):
            failures.append("the imagery route did not return the image from the custom API")
        if "openai" not in model_header:
            failures.append("the imagery route did not report the custom provider")

        # Speech (any small WAV body; the stand-in ignores the audio)
        wav = b"RIFF" + struct.pack("<I", 36) + b"WAVEfmt " + struct.pack("<I", 16) + \
              struct.pack("<HHIIHH", 1, 1, 16000, 32000, 2, 16) + b"data" + struct.pack("<I", 0)
        request = urllib.request.Request(
            f"{APP}/api/local/transcribe",
            data=wav,
            headers={"Content-Type": "audio/wav"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            transcript = json.load(response)
        log(f"transcript: {transcript.get('text')!r}")
        if transcript.get("text") != "spoken through a custom api":
            failures.append("the transcribe route did not use the custom speech API")

        # Auth must travel with every call.
        unauthenticated = [entry for entry in received if entry[2] != f"Bearer {API_KEY}"]
        log(f"calls received: {len(received)}")
        for method, path, auth in received:
            log(f"  {method} {path} auth={'yes' if auth else 'no'}")
        if unauthenticated:
            failures.append(f"{len(unauthenticated)} call(s) arrived without the API key")
        if len(received) < 3:
            failures.append("not every backend called the custom API")
    finally:
        server.shutdown()
        api("/api/settings", "DELETE")

    if failures:
        for failure in failures:
            log(f"FAIL: {failure}")
        return 1
    log("PASS: director, imagery, and speech all served by a custom API")
    return 0


if __name__ == "__main__":
    sys.exit(main())
