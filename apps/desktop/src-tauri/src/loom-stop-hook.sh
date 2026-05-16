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
# controlling TTY exists (some hook-spawning paths in newer Claude
# builds detach from the TTY) — the OSC marker becomes a no-op then,
# but the sidecar-file write below still reaches Loom either way.

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

# Persist the id only if the transcript actually exists on disk with
# content. SessionStart fires the moment claude initialises — before a
# fresh session has written its first turn — so the named file may not
# exist yet. Persisting a session id with no transcript would cause
# the next launch to `claude --resume <bogus>` and the user gets a
# "No conversation found with session ID: ..." dump. The next Stop
# hook (after a real turn) will write the id when the file exists.
# Resume invocations always have an existing transcript by definition,
# so this check passes for them.
def has_transcript_content(path):
    if not path:
        return False
    try:
        return os.path.isfile(path) and os.path.getsize(path) > 0
    except Exception:
        return False

if session_id and (event == "Stop" or has_transcript_content(transcript)):
    # Sidecar transport: per-pane file the Loom backend polls. Required
    # on Claude 2.1.142+ which captures hook stdout/stderr AND detaches
    # the hook from the controlling TTY — neither stdout, stderr, nor
    # `/dev/tty` route bytes back to our PTY. The OSC marker below is
    # the original transport, kept for older builds where /dev/tty
    # still reaches the pane.
    pane_id = os.environ.get("LOOM_PANE_ID")
    if pane_id:
        try:
            home = os.path.expanduser("~")
            sidecar_dir = os.path.join(home, ".loom", "sessions")
            os.makedirs(sidecar_dir, exist_ok=True)
            sidecar_path = os.path.join(sidecar_dir, pane_id)
            tmp_path = sidecar_path + ".tmp"
            # Atomic-replace via tmp + rename so a partial read from the
            # backend never sees a half-written id.
            with open(tmp_path, "w") as f:
                f.write(session_id + "\n")
            os.replace(tmp_path, sidecar_path)
        except Exception:
            pass
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
