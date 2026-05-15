#!/usr/bin/env bash
# Installed by Loom into ~/.claude/loom-stop-hook.sh and registered against
# both the `Stop` and `SessionStart` hooks in ~/.claude/settings.json.
#
# Stop:         emits `loom-session` (resume id) + `loom-stop` (turn-end
#               trigger consumed by xterm.js on the frontend).
# SessionStart: emits `loom-session` only — `loom-stop` is suppressed so
#               the frontend's completion path doesn't fire on session boot.
#
# `loom-stop` goes via an EXIT trap so an early failure inside the python
# helper can't swallow it.
#
# Output goes to /dev/tty (the controlling terminal — for a Loom pane,
# the PTY slave) instead of stdout. Claude Code captures the hook's
# stdout, so writing OSC bytes there would leak them into Claude's hook
# log instead of reaching our pane. Fall back to /dev/null if no
# controlling TTY exists (headless runs) so the OSC bytes never end up
# in Claude's captured stdout.

set -u

exec >/dev/tty 2>/dev/null || exec >/dev/null

emit_stop() { printf '\033]9;loom-stop\033\\'; }
# Default to Stop semantics; the python helper disarms via rc=10 on
# non-Stop events.
trap emit_stop EXIT

cat | python3 -c '
import json, os, sys

try:
    hook_input = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)

# hook_event_name is set on every Claude Code hook invocation; absent on
# older Claude builds, in which case fall back to Stop semantics.
event = hook_input.get("hook_event_name") or "Stop"

transcript = hook_input.get("transcript_path")
session_id = None
if transcript:
    session_id = os.path.splitext(os.path.basename(transcript))[0]
# SessionStart payloads also carry session_id directly; prefer it when the
# transcript_path is missing (some Claude builds omit it on session boot).
if not session_id:
    session_id = hook_input.get("session_id")

if session_id:
    sys.stdout.write("\x1b]9;loom-session;" + session_id + "\x1b\\")
    sys.stdout.flush()

# SessionStart only needs the session marker; suppress the `loom-stop`
# EXIT trap by signaling rc=10 to the shell wrapper.
if event != "Stop":
    sys.exit(10)
'
rc=$?
if [ "$rc" = "10" ]; then
    trap - EXIT
fi
exit 0
