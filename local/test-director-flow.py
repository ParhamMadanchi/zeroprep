#!/usr/bin/env python3
"""Drive a whole presentation through the local ZeroPrep API.

Exercises the same path the browser uses: transcript -> /api/local/director,
with the scene history fed back so multi-turn behaviour can be judged.

  python3 local/test-director-flow.py [base-url]
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"

TURNS = [
    "Hi everyone, today I want to talk about how small teams ship faster with AI.",
    "We ran an experiment: three engineers shipped a working product in nine days.",
    "The first lesson is context. The second is iteration speed. The third is testing in public.",
    "Adoption went from 12 percent to 74 percent in one quarter.",
    "Imagine a world where a single presenter can build a whole deck by talking.",
    "And that is why I believe speed is a strategy, not a tactic.",
]


def post(path, payload, headers=None):
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def describe(command):
    scene = command.get("scene") or {}
    cards = scene.get("cards") or command.get("cards") or []
    summary = [
        f"action={command.get('action')}",
        f"kind={scene.get('kind')}",
        f"accent={scene.get('accent')}",
        f"icon={scene.get('icon')}",
        f"assets={command.get('assetIds')}",
    ]
    title = scene.get("title") or scene.get("quote") or scene.get("metric") or ""
    if title:
        summary.append(f"title={title!r}")
    if scene.get("subtitle"):
        summary.append(f"subtitle={scene['subtitle']!r}")
    if scene.get("metric"):
        summary.append(f"metric={scene['metric']!r}/{scene.get('metricLabel')!r}")
    if cards:
        summary.append("cards=" + json.dumps([
            {"t": card.get("title"), "i": card.get("icon"), "a": card.get("assetId")} for card in cards
        ]))
    return "  ".join(summary)


def main():
    history = []
    total = 0.0
    failures = 0
    for index, line in enumerate(TURNS, start=1):
        started = time.time()
        try:
            result = post("/api/local/director", {"transcript": line, "history": history})
        except urllib.error.HTTPError as error:
            print(f"[{index}] HTTP {error.code}: {error.read()[:200]!r}")
            failures += 1
            continue
        except Exception as error:  # noqa: BLE001
            print(f"[{index}] {type(error).__name__}: {error}")
            failures += 1
            continue
        elapsed = time.time() - started
        total += elapsed
        command = result["command"]
        history.append({"transcript": line, "command": command})
        print(f"[{index}] {elapsed:4.1f}s {result.get('completion_tokens', '?'):>4}tok  {describe(command)}")
        print(f"      said: {line}")

    print(f"\n{len(TURNS) - failures}/{len(TURNS)} turns directed, avg {total / max(len(TURNS), 1):.2f}s/turn")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
