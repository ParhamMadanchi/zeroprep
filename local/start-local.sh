#!/usr/bin/env bash
#
# Bring up the whole ZeroPrep local stack and wait until it is healthy.
#
#   ./local/start-local.sh              # start everything that is not running
#   ./local/start-local.sh --app-only   # only the Next.js app (backends already up)
#   ./local/start-local.sh --stop       # stop everything this script started
#
# Everything runs on this machine: the director LLM, speech recognition, image
# generation and the web app itself. No API keys are required.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/local/run"
LOG_DIR="$ROOT/local/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

APP_PORT="${ZEROPREP_APP_PORT:-3000}"
DIRECTOR_PORT="${ZEROPREP_DIRECTOR_PORT:-1234}"
COMFY_PORT="${ZEROPREP_COMFY_PORT:-8188}"
ASR_PORT="${ZEROPREP_ASR_PORT:-8099}"

LMSTUDIO_BIN="${ZEROPREP_LMSTUDIO_BIN:-$HOME/.lmstudio/bin/lms}"
DIRECTOR_MODEL="${ZEROPREP_DIRECTOR_MODEL:-zeroprep-director}"
COMFY_DIR="${ZEROPREP_COMFY_DIR:-/media/parhamhard/D-Drive/Parham/projects/AI/ComfyUI}"
COMFY_PYTHON="${ZEROPREP_COMFY_PYTHON:-$COMFY_DIR/.venv/bin/python}"
ASR_PYTHON="${ZEROPREP_ASR_PYTHON:-$(command -v python3)}"
ASR_MODEL="${ZEROPREP_ASR_MODEL:-large-v3}"

APP_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --app-only) APP_ONLY=1 ;;
    --stop) STOP=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
  esac
done

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0 || return 1; }

wait_for_port() {
  local port="$1" label="$2" tries="${3:-90}"
  for ((i = 0; i < tries; i++)); do
    if port_open "$port"; then printf '  %-16s ready on :%s\n' "$label" "$port"; return 0; fi
    sleep 1
  done
  printf '  %-16s DID NOT START on :%s (see %s)\n' "$label" "$port" "$LOG_DIR" >&2
  return 1
}

spawn() { # spawn <name> <logfile> <command...>
  local name="$1" log="$2"; shift 2
  if [ -f "$RUN_DIR/$name.pid" ] && kill -0 "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null; then
    printf '  %-16s already running (pid %s)\n' "$name" "$(cat "$RUN_DIR/$name.pid")"
    return 0
  fi
  ( "$@" >"$log" 2>&1 & echo $! >"$RUN_DIR/$name.pid" )
  printf '  %-16s starting (log: %s)\n' "$name" "${log#$ROOT/}"
}

stop_all() {
  for pidfile in "$RUN_DIR"/*.pid; do
    [ -e "$pidfile" ] || continue
    name="$(basename "$pidfile" .pid)"
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      printf '  stopped %s (pid %s)\n' "$name" "$pid"
    fi
    rm -f "$pidfile"
  done
  exit 0
}

[ "${STOP:-0}" = "1" ] && { echo "Stopping ZeroPrep local stack"; stop_all; }

echo "ZeroPrep local stack"

if [ "$APP_ONLY" = "0" ]; then
  # 1. Director LLM: the already-installed LM Studio runtime, serving a GGUF
  #    that was already on this machine. Nothing is downloaded.
  if [ -x "$LMSTUDIO_BIN" ]; then
    if ! port_open "$DIRECTOR_PORT"; then
      spawn lmstudio "$LOG_DIR/lmstudio.log" "$LMSTUDIO_BIN" server start
      wait_for_port "$DIRECTOR_PORT" "director server" 60 || true
    fi
    if ! "$LMSTUDIO_BIN" ps 2>/dev/null | grep -q "$DIRECTOR_MODEL"; then
      printf '  %-16s loading %s\n' "director model" "$DIRECTOR_MODEL"
      "$LMSTUDIO_BIN" load "$DIRECTOR_MODEL" --gpu max -c 8192 \
        --identifier "$DIRECTOR_MODEL" --ttl 7200 -y >"$LOG_DIR/director-load.log" 2>&1 \
        || printf '  %-16s FAILED — run: %s load %s\n' "director model" "$LMSTUDIO_BIN" "$DIRECTOR_MODEL" >&2
    else
      printf '  %-16s %s loaded\n' "director model" "$DIRECTOR_MODEL"
    fi
  else
    printf '  %-16s not found at %s\n' "lm studio" "$LMSTUDIO_BIN" >&2
  fi

  # 2. Local image generation through the existing ComfyUI checkout.
  if [ -x "$COMFY_PYTHON" ]; then
    if ! port_open "$COMFY_PORT"; then
      spawn comfyui "$LOG_DIR/comfyui.log" bash -c \
        "cd '$COMFY_DIR' && exec '$COMFY_PYTHON' main.py --listen 127.0.0.1 --port $COMFY_PORT"
      wait_for_port "$COMFY_PORT" "comfyui" 120 || true
    else
      printf '  %-16s already up on :%s\n' "comfyui" "$COMFY_PORT"
    fi
  else
    printf '  %-16s not found at %s\n' "comfyui" "$COMFY_PYTHON" >&2
  fi

  # 3. Speech to text on the GPU.
  if ! port_open "$ASR_PORT"; then
    spawn asr "$LOG_DIR/asr.log" env ZEROPREP_ASR_MODEL="$ASR_MODEL" ZEROPREP_ASR_PORT="$ASR_PORT" \
      "$ASR_PYTHON" "$ROOT/local/asr_server.py"
    wait_for_port "$ASR_PORT" "speech to text" 180 || true
  else
    printf '  %-16s already up on :%s\n' "speech to text" "$ASR_PORT"
  fi
fi

# 4. The web app.
if ! port_open "$APP_PORT"; then
  spawn web "$LOG_DIR/web.log" bash -c "cd '$ROOT' && exec npx next dev --port $APP_PORT"
  wait_for_port "$APP_PORT" "web app" 60 || true
else
  printf '  %-16s already up on :%s\n' "web app" "$APP_PORT"
fi

echo
for ((i = 0; i < 60; i++)); do
  status="$(curl -fsS -m 5 "http://127.0.0.1:$APP_PORT/api/local/status" 2>/dev/null || true)"
  if [ -n "$status" ] && printf '%s' "$status" | grep -q '"ready": *true'; then
    break
  fi
  sleep 1
done

if printf '%s' "${status:-}" | grep -q '"ready": *true'; then
  echo "All local backends are ready."
else
  echo "Stack is up, but not every backend answered. Current status:"
  printf '%s\n' "${status:-<no response from the web app>}" | head -c 1200
  echo
fi

cat <<EOF

Open  http://127.0.0.1:$APP_PORT
  director  http://127.0.0.1:$DIRECTOR_PORT/v1   ($DIRECTOR_MODEL)
  imagery   http://127.0.0.1:$COMFY_PORT
  speech    http://127.0.0.1:$ASR_PORT
  logs      ${LOG_DIR#$ROOT/}
  stop      ./local/start-local.sh --stop
EOF
