#!/usr/bin/env python3
"""Measure a ComfyUI text-to-image run against the local server.

Usage:
  python3 local/comfy_smoke.py --ckpt juggernautXL_v8Rundiffusion.safetensors \
      --width 1344 --height 768 --steps 28 --label sdxl
"""
import argparse
import json
import time
import urllib.parse
import urllib.request

SERVER = "http://127.0.0.1:8188"


def post(path, payload):
    request = urllib.request.Request(
        SERVER + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def get(path):
    with urllib.request.urlopen(SERVER + path, timeout=120) as response:
        return json.load(response)


def gpu_memory():
    try:
        with open("/proc/driver/nvidia/gpus/0000:01:00.0/information") as handle:
            handle.read()
    except OSError:
        pass
    return ""


def build(ckpt, positive, negative, width, height, steps, cfg, sampler, scheduler, seed):
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["4", 1]}},
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": cfg,
            "sampler_name": sampler, "scheduler": scheduler, "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "zeroprep-smoke", "images": ["8", 0]}},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ckpt", default="juggernautXL_v8Rundiffusion.safetensors")
    parser.add_argument("--prompt", default=(
        "sophisticated 16:9 editorial presentation background, three engineers collaborating "
        "in a bright modern studio, warm ivory and deep black palette with acid lime accents, "
        "cinematic lighting, tactile mixed-media collage energy, no text"))
    parser.add_argument("--negative", default="text, words, letters, watermark, caption, slide, ui, chart labels")
    parser.add_argument("--width", type=int, default=1344)
    parser.add_argument("--height", type=int, default=768)
    parser.add_argument("--steps", type=int, default=28)
    parser.add_argument("--cfg", type=float, default=6.0)
    parser.add_argument("--sampler", default="dpmpp_2m")
    parser.add_argument("--scheduler", default="karras")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--label", default="run")
    args = parser.parse_args()

    graph = build(args.ckpt, args.prompt, args.negative, args.width, args.height,
                  args.steps, args.cfg, args.sampler, args.scheduler, args.seed)
    started = time.time()
    result = post("/prompt", {"prompt": graph, "client_id": "zeroprep-smoke"})
    prompt_id = result["prompt_id"]
    print(f"[{args.label}] queued {prompt_id}")

    image = None
    while time.time() - started < 900:
        history = get(f"/history/{prompt_id}")
        entry = history.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error" or not status.get("completed", True):
                print(f"[{args.label}] ERROR: {json.dumps(status)[:600]}")
                return 1
            outputs = entry.get("outputs", {})
            for node in outputs.values():
                if node.get("images"):
                    image = node["images"][0]
                    break
            if image:
                break
        time.sleep(0.25)

    if not image:
        print(f"[{args.label}] timed out")
        return 1

    query = urllib.parse.urlencode({
        "filename": image["filename"],
        "subfolder": image.get("subfolder", ""),
        "type": image.get("type", "output"),
    })
    with urllib.request.urlopen(f"{SERVER}/view?{query}", timeout=60) as response:
        data = response.read()
    out = f"/tmp/zeroprep-{args.label}.png"
    with open(out, "wb") as handle:
        handle.write(data)
    print(f"[{args.label}] {time.time() - started:.1f}s, {len(data) // 1024} KiB -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
