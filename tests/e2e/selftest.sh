#!/usr/bin/env bash
# Phase 1 acceptance run. Records the real screen for about 10 seconds (a few helper windows flash on screen), measures the files,
# prints PASS/FAIL with the numbers, then deletes the captures. Usage: bash tests/e2e/selftest.sh [acceptance|cam|all] [--keep]
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node tests/e2e/run.js "$@"
