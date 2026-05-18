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

exec 2>/dev/null
exec 3>/dev/tty || exec 3>/dev/null

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

# Gemini only registers SessionStart, so we never see a Stop event with
# a guaranteed-written transcript. Capture only when the file is on
# disk with content — otherwise a fresh `gemini` session that the user
# never typed into would persist a bogus id and the next launch
# `gemini --resume <id>` would fail.
def has_transcript_content(path):
    if not path:
        return False
    try:
        return os.path.isfile(path) and os.path.getsize(path) > 0
    except Exception:
        return False

transcript = hook_input.get("transcript_path")
if session_id and has_transcript_content(transcript):
    # Per-pane sidecar at ~/.loom/sessions/<pane_id> the Loom backend
    # reads. Required when the hook is spawned without a controlling
    # TTY (the `tty is not None` write below silently disappears).
    pane_id = os.environ.get("LOOM_PANE_ID")
    if pane_id:
        try:
            home = os.path.expanduser("~")
            sidecar_dir = os.path.join(home, ".loom", "sessions")
            os.makedirs(sidecar_dir, exist_ok=True)
            sidecar_path = os.path.join(sidecar_dir, pane_id)
            tmp_path = sidecar_path + ".tmp"
            with open(tmp_path, "w") as f:
                f.write(str(session_id) + "\n")
            os.replace(tmp_path, sidecar_path)
        except Exception:
            pass
    if tty is not None:
        try:
            tty.write("\x1b]9;loom-session;" + str(session_id) + "\x1b\\")
            tty.flush()
        except Exception:
            pass

sys.stdout.write("{}")
sys.stdout.flush()
'
exit 0
