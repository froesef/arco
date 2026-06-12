#!/bin/bash
set -euo pipefail

# Start a local DiffusionGemma server for the recommender's `vllm` provider.
#
# DiffusionGemma is Google's diffusion-based (non-autoregressive) Gemma. Ollama
# and llama.cpp cannot run it — it needs MLX or vLLM. Both expose an
# OpenAI-compatible /v1/chat/completions endpoint, which the worker's existing
# `vllm` provider already speaks, so no new provider code is needed.
#
# This server only matters under `wrangler dev` (npm run dev): a *deployed*
# Cloudflare Worker runs on CF's edge and cannot reach localhost.
#
# Usage:
#   ./start-diffusion-gemma.sh                 # auto: MLX on macOS, vLLM elsewhere
#   ./start-diffusion-gemma.sh --backend mlx   # force MLX (Apple Silicon)
#   ./start-diffusion-gemma.sh --backend vllm  # force vLLM (CUDA / Linux box)
#   ./start-diffusion-gemma.sh --model <id> --port 8000 --install
#
# Flags / env:
#   --backend  mlx|vllm   (env BACKEND)   default: mlx on darwin, vllm otherwise
#   --model    <hf-id>    (env MODEL)     default per backend (see below)
#   --port     <n>        (env PORT)      default 8000
#   --host     <addr>     (env HOST)      default 127.0.0.1
#   --install             (env INSTALL=1) pip-install the backend if missing

BACKEND="${BACKEND:-}"
MODEL="${MODEL:-}"
PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"
INSTALL="${INSTALL:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --backend) BACKEND="$2"; shift 2 ;;
    --model)   MODEL="$2";   shift 2 ;;
    --port)    PORT="$2";    shift 2 ;;
    --host)    HOST="$2";    shift 2 ;;
    --install) INSTALL=1;    shift ;;
    -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Default backend: MLX is the native Apple-Silicon path; vLLM is CUDA-oriented.
if [ -z "$BACKEND" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then BACKEND="mlx"; else BACKEND="vllm"; fi
fi

# Default model per backend. These are starting points — override with --model.
# MLX needs an mlx-community quant; vLLM loads the upstream HF weights.
# NOTE: confirm the exact published id on Hugging Face — quant names change.
if [ -z "$MODEL" ]; then
  case "$BACKEND" in
    mlx)  MODEL="mlx-community/diffusiongemma-26B-A4B-it-4bit" ;;
    vllm) MODEL="google/diffusiongemma-26B-A4B-it" ;;
  esac
fi

BASE_URL="http://localhost:${PORT}/v1"

echo "Backend : $BACKEND"
echo "Model   : $MODEL"
echo "Endpoint: $BASE_URL  (OpenAI-compatible /chat/completions)"
echo ""

case "$BACKEND" in
  mlx)
    # DiffusionGemma is multimodal (DiffusionGemmaForBlockDiffusion). Its MLX
    # support lives in mlx-vlm (>=0.6.3), not plain mlx-lm — mlx-vlm.server still
    # exposes an OpenAI-compatible /v1/chat/completions endpoint for text.
    if ! python3 -c 'import mlx_vlm' 2>/dev/null; then
      if [ "$INSTALL" = "1" ]; then
        echo "Installing mlx-vlm..."
        python3 -m pip install -U mlx-vlm
      else
        echo "Error: mlx-vlm is not installed. Run with --install, or:" >&2
        echo "  python3 -m pip install -U mlx-vlm" >&2
        echo "(Apple Silicon Mac required; ~17GB download + ~24GB unified memory for the 26B 4-bit build.)" >&2
        exit 1
      fi
    fi
    echo "Starting MLX (mlx-vlm) server (Ctrl-C to stop)..."
    echo "First start downloads the model (~17GB) into ~/.cache/huggingface."
    echo ""
    exec python3 -m mlx_vlm.server --model "$MODEL" --host "$HOST" --port "$PORT"
    ;;

  vllm)
    if ! command -v vllm >/dev/null 2>&1; then
      if [ "$INSTALL" = "1" ]; then
        echo "Installing vllm..."
        python3 -m pip install -U vllm
      else
        echo "Error: vllm is not installed. Run with --install, or:" >&2
        echo "  python3 -m pip install -U vllm" >&2
        echo "(DiffusionGemma support requires a recent vLLM; an NVIDIA GPU is expected.)" >&2
        exit 1
      fi
    fi
    echo "Starting vLLM server (Ctrl-C to stop)..."
    echo ""
    exec vllm serve "$MODEL" --host "$HOST" --port "$PORT"
    ;;

  *)
    echo "Error: unknown backend '$BACKEND' (expected mlx or vllm)." >&2
    exit 1
    ;;
esac
