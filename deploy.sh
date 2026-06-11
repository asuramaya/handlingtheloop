#!/usr/bin/env bash
# Build + deploy to the edge. Vite copies ALL of public/models (~950MB) into
# dist/, which is far too big to ship AND exceeds Cloudflare's 25 MiB/asset limit.
# Stem weights now load cross-origin from HuggingFace at runtime — Open-Unmix from
# our repo (asuramaya/htl-stems) and HT-Demucs from set-soft/audio_separation — so
# NOTHING under models/ needs to ship. Drop the whole dir.
set -euo pipefail
cd "$(dirname "$0")"

pnpm run build

rm -rf dist/models

echo "dist size: $(du -sh dist | cut -f1)"
pnpm exec wrangler deploy
