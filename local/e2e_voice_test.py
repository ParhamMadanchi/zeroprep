#!/usr/bin/env python3
"""End-to-end test of the fully local ZeroPrep voice loop.

Drives real Firefox (headless, through geckodriver) against the running app and
replaces the microphone with a real speech recording, so the browser path is
exercised exactly as a presenter would:

    AudioWorklet capture -> energy VAD -> /api/local/transcribe (Whisper)
    -> /api/local/director (local LLM) -> scene staged on the canvas

Usage:
    python3 local/e2e_voice_test.py [--keep-artifacts] [--app http://127.0.0.1:3000]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

GECKO_PORT = 4444
AUDIO_PORT = 8799

UTTERANCES = [
    "Hi everyone, today I want to talk about how small teams ship faster with AI.",
    "We ran an experiment. Three engineers shipped a working product in nine days.",
    "Adoption went from twelve percent to seventy four percent in one quarter.",
]


def log(message: str) -> None:
    print(f"[e2e] {message}", flush=True)


class WebDriver:
    def __init__(self, port: int = GECKO_PORT) -> None:
        self.base = f"http://127.0.0.1:{port}"
        self.session = None

    def _call(self, method: str, path: str, payload=None, timeout: float = 120):
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)

    def start(self, headless: bool = True, width: int = 1440, height: int = 900):
        args = ["-headless"] if headless else []
        created = self._call("POST", "/session", {
            "capabilities": {"alwaysMatch": {
                "browserName": "firefox",
                "moz:firefoxOptions": {
                    "args": args + [f"--width={width}", f"--height={height}"],
                    "prefs": {
                        "media.navigator.permission.disabled": True,
                        "media.autoplay.default": 0,
                        "media.autoplay.blocking_policy": 0,
                        "dom.security.https_only_mode": False,
                    },
                },
            }},
        })
        self.session = created["value"]["sessionId"]
        return self.session

    def quit(self):
        if not self.session:
            return
        try:
            self._call("DELETE", f"/session/{self.session}")
        except Exception:  # noqa: BLE001
            pass
        self.session = None

    def get(self, url: str):
        return self._call("POST", f"/session/{self.session}/url", {"url": url})

    def _check(self, result):
        value = result.get("value")
        if isinstance(value, dict) and "error" in value:
            raise RuntimeError(value["error"])
        return value

    def execute(self, script: str, args=None, timeout: float = 120):
        return self._check(self._call(
            "POST", f"/session/{self.session}/execute/sync",
            {"script": script, "args": args or []}, timeout=timeout,
        ))

    def execute_async(self, script: str, args=None, timeout: float = 180):
        return self._check(self._call(
            "POST", f"/session/{self.session}/execute/async",
            {"script": script, "args": args or []}, timeout=timeout,
        ))

    def find(self, selector: str):
        result = self._call("POST", f"/session/{self.session}/element", {"using": "css selector", "value": selector})
        return result["value"]["element-6066-11e4-a52e-4f735466cecf"]

    def click(self, element_id: str):
        return self._call("POST", f"/session/{self.session}/element/{element_id}/click", {})

    def screenshot(self, path: str):
        data = self._call("GET", f"/session/{self.session}/screenshot")["value"]
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(data))

    def console_errors(self):
        return self.execute("return window.__zeroprepErrors || [];")


class QuietHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass


def start_audio_server(directory: str) -> ThreadingHTTPServer:
    def handler(*args, **kwargs):
        return QuietHandler(*args, directory=directory, **kwargs)

    server = ThreadingHTTPServer(("127.0.0.1", AUDIO_PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def build_speech_track(directory: str) -> str:
    """Concatenate flite utterances with silence gaps so the VAD sees turns."""
    parts = []
    for index, text in enumerate(UTTERANCES):
        path = os.path.join(directory, f"utt{index}.wav")
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
             "-i", f"flite=text='{text}'", "-ar", "16000", "-ac", "1", "-y", path],
            check=True,
        )
        parts.append(path)

    silence = os.path.join(directory, "silence.wav")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
         "-i", "anullsrc=r=16000:cl=mono", "-t", "1.4", "-y", silence],
        check=True,
    )

    concat_file = os.path.join(directory, "concat.txt")
    with open(concat_file, "w") as handle:
        handle.write(f"file '{silence}'\n")
        for index, path in enumerate(parts):
            handle.write(f"file '{path}'\n")
            if index < len(parts) - 1:
                handle.write(f"file '{silence}'\n")
        handle.write(f"file '{silence}'\n")

    track = os.path.join(directory, "presenter.wav")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", concat_file, "-ar", "16000", "-ac", "1", "-y", track],
        check=True,
    )
    return track


PATCH_MIC = r"""
const done = arguments[arguments.length - 1];
const url = arguments[0];
(async () => {
  try {
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(bytes);
    const destination = ctx.createMediaStreamDestination();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.start();
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints && constraints.audio) return destination.stream;
      return original(constraints);
    };
    const resume = () => ctx.resume().then(() => { window.__zeroprepE2E.state = ctx.state; });
    const info = { seconds: buffer.duration, patched: true, state: ctx.state, ctx, resume,
                   destination, tracks: destination.stream.getAudioTracks().length };
    window.__zeroprepE2E = info;
    document.addEventListener('click', resume, { once: true });
    document.addEventListener('keydown', resume, { once: true });
    // Record every AudioContext the app creates so its state can be inspected.
    window.__zeroprepContexts = [];
    const OriginalAudioContext = window.AudioContext;
    window.AudioContext = class extends OriginalAudioContext {
      constructor(...rest) {
        super(...rest);
        window.__zeroprepContexts.push(this);
      }
    };
    await resume();
    done({ seconds: info.seconds, patched: true, state: ctx.state, tracks: info.tracks });
  } catch (error) {
    done({ error: String(error) });
  }
})();
"""

MEASURE_LEVEL = r"""
const done = arguments[arguments.length - 1];
(async () => {
  try {
    const info = window.__zeroprepE2E || {};
    if (info.resume) await info.resume();

    // Independently measure the audio the page thinks the microphone is.
    const probe = new AudioContext();
    const analyser = probe.createAnalyser();
    analyser.fftSize = 2048;
    const source = probe.createMediaStreamSource(info.destination.stream);
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let peak = 0;
    let frames = 0;
    const started = performance.now();
    while (performance.now() - started < 700) {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      peak = Math.max(peak, Math.sqrt(sum / data.length));
      frames += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await probe.close();

    done({
      streamRms: Number(peak.toFixed(5)),
      samples: frames,
      contexts: (window.__zeroprepContexts || []).map((ctx) => ({
        state: ctx.state,
        rate: ctx.sampleRate,
        time: Number(ctx.currentTime.toFixed(2)),
      })),
    });
  } catch (error) {
    done({ error: String(error) });
  }
})();
"""


def wait_for(driver: WebDriver, script: str, timeout: float, label: str, interval: float = 1.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = driver.execute(script)
        except Exception as error:  # noqa: BLE001
            last = f"error: {error}"
        if last:
            log(f"{label}: {last}")
            return last
        time.sleep(interval)
    log(f"{label}: TIMED OUT after {timeout:.0f}s (last={last!r})")
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default="http://127.0.0.1:3000")
    parser.add_argument("--timeout", type=float, default=150)
    parser.add_argument("--keep-artifacts", action="store_true")
    args = parser.parse_args()

    workdir = tempfile.mkdtemp(prefix="zeroprep-e2e-")
    gecko = None
    driver = WebDriver()
    failures: list[str] = []

    try:
        log("building presenter audio")
        track = build_speech_track(workdir)
        duration = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
             "default=nw=1:nk=1", track],
            capture_output=True, text=True, check=True).stdout.strip())
        log(f"presenter track is {duration:.1f}s of speech")

        start_audio_server(workdir)
        gecko = subprocess.Popen(
            ["geckodriver", "--port", str(GECKO_PORT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid,
        )
        time.sleep(2)
        driver.start()

        log(f"opening {args.app}")
        driver.get(args.app)
        driver.execute(
            "window.__zeroprepErrors = [];"
            "window.addEventListener('error', (e) => window.__zeroprepErrors.push(String(e.message)));"
            "window.addEventListener('unhandledrejection', (e) => window.__zeroprepErrors.push('rejection: ' + String(e.reason)));"
        )

        chip = wait_for(
            driver,
            "const el = document.querySelector('.local-chip'); return el ? el.textContent : '';",
            25, "local chip",
        )
        if not chip:
            failures.append("the LOCAL MACHINE badge never rendered (is the app in local mode?)")

        patched = driver.execute_async(PATCH_MIC, [f"http://127.0.0.1:{AUDIO_PORT}/presenter.wav"])
        log(f"microphone patched: {patched}")
        if patched.get("error"):
            failures.append(f"could not patch the microphone: {patched['error']}")

        button = driver.find(".mic-button:not(.stop-button)")
        driver.click(button)
        log("clicked Start live presentation")

        time.sleep(2)
        log(f"audio context after click: {driver.execute_async(MEASURE_LEVEL)}")

        live = wait_for(
            driver,
            "return !!document.querySelector('.mic-button.stop-button');",
            30, "session live",
        )
        if not live:
            failures.append("the session never reached the live state")

        first_turn = wait_for(
            driver,
            """
            const meta = (document.querySelector('.listening-meta') || {}).innerText || '';
            const transcript = (document.querySelector('.listening-card p') || {}).innerText || '';
            const staged = /COMPOSED A NEW SCENE|UPDATED CARDS|FOCUSED CURRENT SCENE/.test(meta);
            return staged ? JSON.stringify({ meta: meta.replace(/\\n/g, ' | '), transcript: transcript.slice(0, 160) }) : '';
            """,
            args.timeout, "first directed scene", interval=2.0,
        )
        if not first_turn:
            failures.append("no scene was staged from the spoken audio")

        time.sleep(16)  # let the remaining utterances produce more scenes

        summary = driver.execute(
            """
            const titles = [...document.querySelectorAll('.stage-canvas h1, .stage-canvas h2')]
              .map((node) => node.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
            const seen = [...document.querySelectorAll('[data-export-slide]')].length;
            return JSON.stringify({
              titles: [...new Set(titles)].slice(0, 6),
              exportSlides: seen,
              transcript: (document.querySelector('.listening-card p') || {}).innerText || '',
              meta: ((document.querySelector('.listening-meta') || {}).innerText || '').replace(/\\n/g, ' | '),
              errors: window.__zeroprepErrors || [],
            });
            """
        )
        log(f"page summary: {summary}")

        shot = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "e2e-scene.png")
        os.makedirs(os.path.dirname(shot), exist_ok=True)
        driver.screenshot(shot)
        log(f"screenshot written to {shot}")

        parsed = json.loads(summary)
        if parsed.get("errors"):
            failures.append(f"browser reported errors: {parsed['errors']}")
        if not parsed.get("titles"):
            failures.append("no scene titles were found in the DOM")

        log("transcript: " + (parsed.get("transcript") or "").replace("\n", " ")[:200])
    finally:
        driver.quit()
        if gecko:
            os.killpg(os.getpgid(gecko.pid), signal.SIGTERM)
        if not args.keep_artifacts:
            shutil.rmtree(workdir, ignore_errors=True)
        else:
            log(f"artifacts kept in {workdir}")

    if failures:
        print()
        for failure in failures:
            log(f"FAIL: {failure}")
        return 1
    log("PASS: local voice loop directed scenes from real speech")
    return 0


if __name__ == "__main__":
    sys.exit(main())
