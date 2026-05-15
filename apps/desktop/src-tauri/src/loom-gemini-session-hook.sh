#!/usr/bin/env bash
# Installed by Loom into ~/.gemini/loom-gemini-session-hook.sh and registered
# against the `SessionStart` event in ~/.gemini/settings.json.
#
# Gemini has no per-turn Stop hook (only SessionEnd, which is best-effort
# on process exit), so we capture the session id once when it boots. The
# id is stable for the lifetime of the session, which is enough for
# `gemini --resume <uuid>` to pick the conversation up on restart.
#
# Gemini REQUIRES a single JSON object on stdout — even one extra echo
# breaks parsing. The OSC marker goes to fd 3 (the controlling TTY) so
# stdout stays clean.

set -u

exec 3>/dev/tty 2>/dev/null || exec 3>/dev/null

cat | python3 -c '
import json, os, sys

try:
    hook_input = json.loads(sys.stdin.read())
except Exception:
    sys.stdout.write("{}")
    sys.exit(0)

session_id = hook_input.get("session_id")

try:
    tty = os.fdopen(3, "w")
except Exception:
    tty = None

if session_id and tty is not None:
    try:
        tty.write("\x1b]9;loom-session;" + str(session_id) + "\x1b\\")
        tty.flush()
    except Exception:
        pass

sys.stdout.write("{}")
sys.stdout.flush()
'
exit 0
