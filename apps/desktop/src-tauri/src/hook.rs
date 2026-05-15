/// Installs the Loom hooks into ~/.claude/settings.json so every Claude
/// Code session emits OSC-9 markers Loom can scan. Registered under two
/// events:
///
/// - `Stop` — fires on every turn end. Emits `loom-session` (resume id,
///   parsed by the backend `OscScanner`) and `loom-stop` (turn-end
///   signal, consumed by xterm.js's OSC 9 handler in the frontend).
/// - `SessionStart` — fires on session boot. Emits `loom-session` only,
///   so the resume id is durable from the first prompt, not only after
///   the first turn ends.
///
/// The hook script itself is bundled as `loom-stop-hook.sh` (it branches
/// internally on hook_event_name) and copied next to the settings file on
/// every configure.
///
/// The function is idempotent: re-running it either no-ops (already
/// up-to-date), upgrades an old marker in place (legacy bell hook -> OSC,
/// or OSC -> OSC + report-script), or appends a new entry.
use crate::hook_common::{install_loom_hook, HookSchema, HookSetupResult, HookSpec};

// OSC-9 marker that only Loom emits so wait_for_idle can distinguish
// a real "agent done" from claude's own internal bells. The trailing
// comment in the settings.json command is the marker the upgrade path
// looks for.
const LOOM_HOOK_MARKER: &str = "loom-stop-osc";
const LOOM_HOOK_LEGACY_MARKER: &str = "loom-notify-hook";
const LOOM_HOOK_SCRIPT_NAME: &str = "loom-stop-hook.sh";
const LOOM_HOOK_SCRIPT: &str = include_str!("loom-stop-hook.sh");

#[tauri::command]
pub fn configure_claude_notification_hook() -> Result<HookSetupResult, String> {
    install_loom_hook(&HookSpec {
        config_subdir: ".claude",
        settings_filename: "settings.json",
        script_filename: LOOM_HOOK_SCRIPT_NAME,
        script_body: LOOM_HOOK_SCRIPT,
        marker: LOOM_HOOK_MARKER,
        legacy_marker: Some(LOOM_HOOK_LEGACY_MARKER),
        schema: HookSchema::Nested,
        events: &["Stop", "SessionStart"],
    })
}
