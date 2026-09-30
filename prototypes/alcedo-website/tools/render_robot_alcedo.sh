#!/usr/bin/env bash
# Re-renders assets/ai-robot-alcedo.png: the application's own AI robot scene
# (scripts/mascot/atlas-mascot-scene.src.mjs) with tools/robot-alcedo-mark.patch applied,
# which swaps only the forehead/chest decal texture from the Atlas mark to the ALCEDO symbol.
# Model, materials, lighting, camera framing and the four frames (open, blink, sleep, happy)
# come unchanged from scripts/render_atlas_bot_badges.mjs.
#
# Works in a temporary folder and never writes into apps/web or scripts/.
# Needs node, Playwright with Chromium (ATLAS_PLAYWRIGHT or a global install) and npm access.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/scripts/mascot" "$WORK/web/assets/atlas-bot" "$WORK/out"
cp "$ROOT/scripts/mascot/atlas-mascot-scene.src.mjs" "$WORK/scripts/mascot/"
(cd "$WORK" && git apply "$HERE/tools/robot-alcedo-mark.patch")
(cd "$WORK" && npm init -y >/dev/null && npm i --silent --no-audit --no-fund three@0.186.1 esbuild@0.25.10)
# Same esbuild options as scripts/build_atlas_mascot.mjs, output into the temp folder.
(cd "$WORK" && node -e "
  require('esbuild').build({ entryPoints: ['scripts/mascot/atlas-mascot-scene.src.mjs'], outfile: 'web/assets/atlas-bot/atlas-mascot-scene.js',
    bundle: true, format: 'esm', minify: true, target: ['es2020', 'safari15'], legalComments: 'inline', nodePaths: ['node_modules'], logLevel: 'warning' })")
# The repository renderer, pointed at the temp folder instead of apps/web.
sed -e "s#const WEB = path.join(ROOT, 'apps/web');#const WEB = process.env.MASCOT_WEB;#" \
    -e "s#const OUT = path.join(WEB, 'assets/atlas-bot');#const OUT = process.env.MASCOT_OUT;#" \
    "$ROOT/scripts/render_atlas_bot_badges.mjs" > "$WORK/render.mjs"
PW=${ATLAS_PLAYWRIGHT:-$(npm root -g)/playwright}
(cd "$WORK" && MASCOT_WEB="$WORK/web" MASCOT_OUT="$WORK/out" ATLAS_PLAYWRIGHT="$PW" node render.mjs)
cp "$WORK/out/atlas-bot.png" "$HERE/assets/ai-robot-alcedo.png"
echo "wrote $HERE/assets/ai-robot-alcedo.png"
