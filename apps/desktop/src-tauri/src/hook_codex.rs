/// Installs the Loom hooks into ~/.codex/hooks.json (Stop + SessionStart)
/// and ensures the `codex_hooks` feature flag is enabled in
/// ~/.codex/config.toml. Mirrors `hook.rs` for Claude.
///
/// Codex's hook JSON schema is nested the same way Claude's is
/// (`{matcher, hooks: [{type, command}]}`), so the shared installer's
/// `HookSchema::Nested` path handles the upsert. The script is bundled
/// via `include_str!` and rewritten atomically on every launch so upgrades
/// pick up new logic transparently.
use std::path::Path;

use crate::atomic_write;
use crate::hook_common::{install_loom_hook, HookSchema, HookSetupResult, HookSpec};

const LOOM_HOOK_MARKER: &str = "loom-codex-stop-osc";
const LOOM_HOOK_SCRIPT_NAME: &str = "loom-codex-stop-hook.sh";
const LOOM_HOOK_SCRIPT: &str = include_str!("loom-codex-stop-hook.sh");

#[tauri::command]
pub fn configure_codex_notification_hook() -> Result<HookSetupResult, String> {
    // Hooks live in ~/.codex/hooks.json. Codex also accepts a [hooks]
    // section in config.toml; we prefer the dedicated file so we don't
    // race with the user's config.toml edits.
    let result = install_loom_hook(&HookSpec {
        config_subdir: ".codex",
        settings_filename: "hooks.json",
        script_filename: LOOM_HOOK_SCRIPT_NAME,
        script_body: LOOM_HOOK_SCRIPT,
        marker: LOOM_HOOK_MARKER,
        legacy_marker: None,
        schema: HookSchema::Nested,
        events: &["Stop", "SessionStart"],
    })?;

    // Codex hooks are behind a feature flag. Flip it on if absent —
    // idempotent, respects any existing user setting (true OR false).
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
    let config_path = std::path::PathBuf::from(home)
        .join(".codex")
        .join("config.toml");
    ensure_codex_hooks_feature_flag(&config_path)?;

    Ok(result)
}

/// Ensure `codex_hooks = true` is set under `[features]` in config.toml.
///
/// Strategy:
///   1. If any line declares a value for `codex_hooks` (true or false),
///      leave it untouched — the user has an explicit preference.
///   2. Else if a `[features]` table exists, insert `codex_hooks = true`
///      immediately after its header.
///   3. Else append a new `[features]` table with the flag at the end of
///      the file.
///
/// This is text-based on purpose: pulling in a full TOML editor crate
/// (toml_edit) for one line isn't worth the dependency weight, and a
/// round-trip serializer would discard the user's comments and ordering.
/// Returns whether the file was modified.
fn ensure_codex_hooks_feature_flag(config_path: &Path) -> Result<bool, String> {
    let existing = if config_path.exists() {
        std::fs::read_to_string(config_path)
            .map_err(|e| format!("read {}: {e}", config_path.display()))?
    } else {
        String::new()
    };

    let already_set = existing.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            return false;
        }
        // Match `codex_hooks = true|false` with arbitrary whitespace.
        let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
        compact.starts_with("codex_hooks=")
    });
    if already_set {
        return Ok(false);
    }

    let mut new_content = String::new();
    let mut inserted = false;
    for line in existing.lines() {
        new_content.push_str(line);
        new_content.push('\n');
        if !inserted && line.trim() == "[features]" {
            new_content.push_str("codex_hooks = true\n");
            inserted = true;
        }
    }

    if !inserted {
        if !new_content.is_empty() {
            if !new_content.ends_with('\n') {
                new_content.push('\n');
            }
            new_content.push('\n');
        }
        new_content.push_str("[features]\ncodex_hooks = true\n");
    }

    atomic_write::write(config_path, new_content.as_bytes())
        .map_err(|e| format!("write {}: {e}", config_path.display()))?;
    Ok(true)
}

#[cfg(test)]
mod feature_flag_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn writes_a_fresh_features_section_when_file_does_not_exist() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        let changed = ensure_codex_hooks_feature_flag(&path).unwrap();
        assert!(changed);
        let body = read(&path);
        assert!(body.contains("[features]"));
        assert!(body.contains("codex_hooks = true"));
    }

    #[test]
    fn appends_features_section_when_file_exists_without_one() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "model = \"o1\"\n").unwrap();
        let changed = ensure_codex_hooks_feature_flag(&path).unwrap();
        assert!(changed);
        let body = read(&path);
        assert!(body.contains("model = \"o1\""));
        assert!(body.contains("[features]\ncodex_hooks = true"));
    }

    #[test]
    fn inserts_flag_under_existing_features_section() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[features]\nother = true\n").unwrap();
        let changed = ensure_codex_hooks_feature_flag(&path).unwrap();
        assert!(changed);
        let body = read(&path);
        // Header preserved, our flag landed immediately after it, other
        // flag preserved.
        let lines: Vec<&str> = body.lines().collect();
        let header = lines.iter().position(|l| l.trim() == "[features]").unwrap();
        assert_eq!(lines[header + 1].trim(), "codex_hooks = true");
        assert!(body.contains("other = true"));
    }

    #[test]
    fn is_idempotent_when_flag_already_true() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        let initial = "[features]\ncodex_hooks = true\n";
        fs::write(&path, initial).unwrap();
        let changed = ensure_codex_hooks_feature_flag(&path).unwrap();
        assert!(!changed, "second run must be a no-op");
        assert_eq!(read(&path), initial, "file content must not be touched");
    }

    #[test]
    fn preserves_user_explicit_false() {
        // User opted out — we must NOT flip the flag back to true.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        let initial = "[features]\ncodex_hooks = false\n";
        fs::write(&path, initial).unwrap();
        let changed = ensure_codex_hooks_feature_flag(&path).unwrap();
        assert!(!changed);
        assert_eq!(read(&path), initial);
    }

    #[test]
    fn tolerates_whitespace_around_equals() {
        // `codex_hooks  =  true` (extra spaces) must count as set.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[features]\ncodex_hooks   =   true\n").unwrap();
        let changed = ensure_codex_hooks_feature_flag(&path).unwrap();
        assert!(!changed);
    }

    #[test]
    fn ignores_comment_lines_mentioning_the_key() {
        // A commented-out hint must not be mistaken for an active setting.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "# codex_hooks = true\n").unwrap();
        let changed = ensure_codex_hooks_feature_flag(&path).unwrap();
        assert!(changed, "comment must not be treated as the flag");
        let body = read(&path);
        assert!(body.contains("# codex_hooks = true"));
        // Real flag was appended in a fresh [features] section.
        assert!(body.contains("[features]\ncodex_hooks = true"));
    }

    #[test]
    fn handles_file_without_trailing_newline() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "model = \"o1\"").unwrap(); // no trailing \n
        let changed = ensure_codex_hooks_feature_flag(&path).unwrap();
        assert!(changed);
        let body = read(&path);
        // The new section starts on its own line with a blank gap, not
        // glued onto `model = "o1"`.
        assert!(body.contains("model = \"o1\"\n"));
        assert!(body.contains("[features]\ncodex_hooks = true"));
    }
}
