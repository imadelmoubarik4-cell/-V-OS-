#!/usr/bin/env bash
# One command for the S94 Media end-to-end proof:
#   scripts/e2e/s94-media/run.sh [gateway|browser|all]   (default: all)
# Each suite gets a fresh backend (setup.sh) and its own stack.mjs process;
# containers are stopped at the end (teardown.sh). Loopback only.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
what="${1:-all}"
status=0

python3 "$E2E_DIR/make_samples.py" "$E2E_WORK/samples" >/dev/null

start_stack() {
  rm -f "$E2E_WORK/stack.json"
  node "$E2E_DIR/stack.mjs" >"$E2E_WORK/stack.out" 2>&1 &
  STACK_PID=$!
  for _ in $(seq 1 50); do [[ -f "$E2E_WORK/stack.json" ]] && return 0; sleep 0.2; done
  echo "stack.mjs did not start" >&2; cat "$E2E_WORK/stack.out" >&2; return 1
}
stop_stack() { kill "${STACK_PID:-0}" 2>/dev/null; wait "${STACK_PID:-0}" 2>/dev/null; }

run_suite() {
  local name="$1"; shift
  "$E2E_DIR/setup.sh" >"$E2E_WORK/setup-$name.log" 2>&1 || { echo "setup failed (see $E2E_WORK/setup-$name.log)"; return 1; }
  start_stack || return 1
  "$@" | tee "$E2E_WORK/$name.out" | grep -E '^(FAIL|\{)' || true
  local result=${PIPESTATUS[0]}
  if [[ "$name" == "browser" ]]; then
    # After every browser failure path: no orphan rows or objects, no leaks.
    node "$E2E_DIR/gateway-e2e.mjs" --only=orphans,logs,boundary | tee "$E2E_WORK/browser-after.out" | grep -E '^(FAIL|\{)' || true
    [[ ${PIPESTATUS[0]} -eq 0 ]] || result=1
  fi
  stop_stack
  return "$result"
}

if [[ "$what" == "gateway" || "$what" == "all" ]]; then
  run_suite gateway node "$E2E_DIR/gateway-e2e.mjs" || status=1
fi
if [[ "$what" == "browser" || "$what" == "all" ]]; then
  : "${ATLAS_BROWSER_LIBS:?set ATLAS_BROWSER_LIBS to a node_modules with @supabase/supabase-js@2.45.4 and lucide@0.454.0}"
  run_suite browser flock "${ATLAS_BROWSER_LOCK:-$E2E_WORK/browser.lock}" node "$E2E_DIR/browser-e2e.mjs" || status=1
fi
"$E2E_DIR/teardown.sh" >/dev/null
exit "$status"
