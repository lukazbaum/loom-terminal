#!/usr/bin/env bash
# Installed by Loom into ~/.codex/loom-codex-stop-hook.sh and registered
# against both the `Stop` and `SessionStart` events in ~/.codex/hooks.json.
#
# Codex Stop hooks REQUIRE a JSON object on stdout — anything else breaks
# parsing. So OSC markers can't go to stdout the way Claude's hook does
# them. Instead we open fd 3 against the controlling terminal (the PTY
# slave inside a Loom pane) and write OSC there, then emit `{}` on real
# stdout so Codex sees valid JSON.
#
# Stop  → emits `loom-session` (resume id) + `loom-stop` (turn-end
#         trigger consumed by xterm.js on the frontend) via an EXIT trap.
# SessionStart → emits `loom-session` only. The EXIT trap is disarmed
#                so the frontend doesn't fire a completion on session boot.

set -u

# Open fd 3 to the controlling TTY; fall back to /dev/null so writes
# silently succeed when there's no TTY (e.g. Codex run headless).
exec 3>/dev/tty 2>/dev/null || exec 3>/dev/null

emit_stop() { printf '\033]9;loom-stop\033\\' >&3 2>/dev/null || true; }
trap emit_stop EXIT

cat | python3 -c '
import json, os, sys

try:
    hook_input = json.loads(sys.stdin.read())
except Exception:
    # Malformed input from Codex: bail cleanly so we still emit `{}` and
    # the EXIT trap still fires (Stop semantics by default).
    sys.stdout.write("{}")
    sys.exit(0)

event = hook_input.get("hook_event_name") or "Stop"
session_id = hook_input.get("session_id")

try:
    tty = os.fdopen(3, "w")
except Exception:
    tty = None

def emit_osc(s):
    if tty is None:
        return
    try:
        tty.write(s)
        tty.flush()
    except Exception:
        pass

if session_id:
    emit_osc("\x1b]9;loom-session;" + str(session_id) + "\x1b\\")

# SessionStart: session marker only, no stop.
# rc=10 tells the shell to disarm the EXIT trap.
if event != "Stop":
    sys.stdout.write("{}")
    sys.stdout.flush()
    sys.exit(10)

# Codex Stop expects JSON on stdout. Empty object is valid.
sys.stdout.write("{}")
sys.stdout.flush()
'
rc=$?
if [ "$rc" = "10" ]; then
    trap - EXIT
fi
exit 0
