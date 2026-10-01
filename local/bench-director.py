#!/usr/bin/env python3
"""Benchmark a local OpenAI-compatible model as the ZeroPrep live director.

Compares native tool-calling against a strict JSON-schema response contract so we
can pick a director model that is both fast and reliably parseable on local GPUs.

Usage: python3 local/bench-director.py [model-identifier] [--url http://127.0.0.1:1234/v1]
"""
import json
import sys
import time
import urllib.error
import urllib.request

ICONS = [
    "sparkles", "message", "rocket", "chart", "users", "lightbulb", "target",
    "shield", "globe", "zap", "book", "heart", "cpu", "leaf", "coins",
]

SYSTEM = """You are ZeroPrep, a live presentation director that turns natural speech into a polished presentation with zero preparation. After every completed speaker turn you must return exactly one stage_visuals command.

Decision policy:
- The presentation starts on a welcome cover. The first substantive turn must use replace with a complete scene.
- Use hero for a strong new thesis, cards for 2 to 4 sibling ideas, metric for a number that deserves focus, and quote for a memorable line.
- Use focus or merge_cards when the speaker refines the current idea; use hold only for noise.
- Titles are 3 to 8 words. Subtitles are at most 22 words. Card titles are 2 to 5 words and card bodies 8 to 20 words.
- Every scene picks one semantic icon. Every card picks a distinct semantic icon.
- Always include assetIds, even when it is empty. Never narrate; return only the command."""

SCENE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "enum": ["hero", "cards", "metric", "quote"]},
        "eyebrow": {"type": "string"},
        "title": {"type": "string"},
        "subtitle": {"type": "string"},
        "icon": {"type": "string", "enum": ICONS},
        "accent": {"type": "string", "enum": ["ember", "lime", "sky", "violet"]},
        "metric": {"type": "string"},
        "metricLabel": {"type": "string"},
        "quote": {"type": "string"},
        "attribution": {"type": "string"},
        "cards": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "tag": {"type": "string"},
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                    "icon": {"type": "string", "enum": ICONS},
                },
                "required": ["title", "body", "icon"],
            },
        },
    },
    "required": ["kind", "title", "icon"],
}

COMMAND_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {"type": "string", "enum": ["replace", "merge_cards", "focus", "hold"]},
        "assetIds": {"type": "array", "items": {"type": "string"}},
        "caption": {"type": "string"},
        "scene": SCENE_SCHEMA,
        "cards": SCENE_SCHEMA["properties"]["cards"],
    },
    "required": ["action", "assetIds"],
}

TURNS = [
    "Hi everyone, today I want to talk about how small teams ship faster with AI.",
    "We ran an experiment: three engineers shipped a working product in nine days.",
    "The first lesson is context. The second is iteration speed. The third is testing in public.",
    "Adoption went from 12 percent to 74 percent in one quarter.",
    "And that is why I believe speed is a strategy, not a tactic.",
]


def tool_payload():
    return [{
        "type": "function",
        "function": {
            "name": "stage_visuals",
            "description": "Hold, replace, or update the current presentation scene.",
            "parameters": COMMAND_SCHEMA,
        },
    }]


def post(url, payload, timeout=180):
    request = urllib.request.Request(
        f"{url}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def extract_json(text):
    """Tolerantly pull one JSON object out of model prose or tool markup."""
    if not text:
        return None
    text = text.replace("<tool_call>", " ").replace("</tool_call>", " ")
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escaped = False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:index + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None


def run_mode(url, model, mode):
    print(f"\n=== {model} :: {mode} ===")
    transcript = []
    total = 0.0
    ok = 0
    for line in TURNS:
        messages = [{"role": "system", "content": SYSTEM}]
        for said, command in transcript[-6:]:
            messages.append({"role": "user", "content": said})
            messages.append({"role": "assistant", "content": json.dumps(command)})
        messages.append({"role": "user", "content": line})

        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.35,
            "max_tokens": 700,
        }
        if mode == "tools":
            payload["tools"] = tool_payload()
            payload["tool_choice"] = "required"
        else:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "stage_visuals", "strict": True, "schema": COMMAND_SCHEMA},
            }

        started = time.time()
        try:
            result = post(url, payload)
        except urllib.error.HTTPError as error:
            print(f"  HTTP {error.code}: {error.read()[:300]!r}")
            return
        except Exception as error:  # noqa: BLE001
            print(f"  request failed: {error}")
            return
        elapsed = time.time() - started
        total += elapsed

        message = result["choices"][0]["message"]
        usage = result.get("usage", {})
        command = None
        source = ""
        if message.get("tool_calls"):
            command = extract_json(message["tool_calls"][0]["function"]["arguments"])
            source = "tool_calls"
        if command is None and message.get("content"):
            command = extract_json(message["content"])
            source = source or "content"
        if command is None and message.get("reasoning_content"):
            command = extract_json(message["reasoning_content"])
            source = source or "reasoning"

        if command and command.get("action"):
            ok += 1
            scene = command.get("scene") or {}
            cards = scene.get("cards") or command.get("cards") or []
            print(f"  {elapsed:5.1f}s {usage.get('completion_tokens', '?'):>4}tok [{source:9}] "
                  f"{command['action']:11} {scene.get('kind', '-'):6} "
                  f"{str(scene.get('title') or scene.get('quote') or scene.get('metric'))[:44]!r}"
                  f"{' cards=' + str(len(cards)) if cards else ''}")
            transcript.append((line, command))
        else:
            print(f"  {elapsed:5.1f}s {usage.get('completion_tokens', '?'):>4}tok PARSE FAIL "
                  f"finish={result['choices'][0].get('finish_reason')}")
            sample = message.get("content") or message.get("reasoning_content") or ""
            print(f"      raw: {str(sample)[:200]!r}")
    if ok:
        print(f"  -> {ok}/{len(TURNS)} parsed, avg {total / len(TURNS):.1f}s/turn")


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "zeroprep-director"
    base = "http://127.0.0.1:1234/v1"
    if "--url" in sys.argv:
        base = sys.argv[sys.argv.index("--url") + 1]
    modes = ["json", "tools"]
    if "--mode" in sys.argv:
        modes = [sys.argv[sys.argv.index("--mode") + 1]]
    for m in modes:
        run_mode(base, target, m)
