/// Installs a SessionStart hook into ~/.gemini/settings.json so Gemini
/// CLI sessions emit a `loom-session` OSC marker on boot.
///
/// Gemini's hook schema is flatter than Claude/Codex (`{type, command}`
/// directly in the event array — no `{matcher, hooks: [...]}` wrapper),
/// so the shared installer's `HookSchema::Flat` path handles the upsert.
///
/// Gemini does NOT have a per-turn Stop hook (only `SessionEnd`, which
/// fires at process exit and is best-effort). Capturing the id once at
/// SessionStart is sufficient — it's stable across the session and
/// `gemini --resume <uuid>` accepts the same id verbatim.
use crate::hook_common::{install_loom_hook, HookSchema, HookSetupResult, HookSpec};

const LOOM_HOOK_MARKER: &str = "loom-gemini-session-osc";
const LOOM_HOOK_SCRIPT_NAME: &str = "loom-gemini-session-hook.sh";
const LOOM_HOOK_SCRIPT: &str = include_str!("loom-gemini-session-hook.sh");

#[tauri::command]
pub fn configure_gemini_notification_hook() -> Result<HookSetupResult, String> {
    install_loom_hook(&HookSpec {
        config_subdir: ".gemini",
        settings_filename: "settings.json",
        script_filename: LOOM_HOOK_SCRIPT_NAME,
        script_body: LOOM_HOOK_SCRIPT,
        marker: LOOM_HOOK_MARKER,
        legacy_marker: None,
        schema: HookSchema::Flat,
        events: &["SessionStart"],
    })
}
