/// Shared installer for the three per-agent hooks (Claude, Codex, Gemini).
/// The config files live in different paths and use slightly different
/// schemas, but the lifecycle — write the bundled script, normalize the
/// JSON, upsert our entry under each event, atomically rewrite if anything
/// changed — is the same. Per-agent variation is captured in `HookSpec`;
/// the only thing left to each `hook_*.rs` file is supplying the spec and
/// any agent-specific extras (e.g. Codex's config.toml feature flag).
use serde_json::Value;

use crate::atomic_write;

/// Returned to the frontend after the installer runs so the UI can toast
/// on upgrade ("Loom updated your Claude hook — restart any running claude
/// panes to pick it up") or on hard failure.
#[derive(Clone, serde::Serialize)]
pub struct HookSetupResult {
    pub added: bool,
    #[serde(rename = "alreadyPresent")]
    pub already_present: bool,
    /// True when an existing Loom hook entry was rewritten in place. The
    /// agent process may have already cached the old command and won't pick
    /// up the new one until restarted.
    pub upgraded: bool,
    pub path: String,
}

#[derive(Default)]
pub(crate) struct UpsertOutcome {
    pub appended: bool,
    pub upgraded: bool,
    pub already_present: bool,
}

/// Shape of the per-entry hook record. Claude and Codex use the nested
/// `{matcher, hooks: [{type, command}]}` form; Gemini uses the flat
/// `{type, command}` form.
pub(crate) enum HookSchema {
    Nested,
    Flat,
}

/// Everything an agent installer varies on. Lifetimes are tied to `'static`
/// strs in practice (all values are compile-time constants), but the borrow
/// keeps the spec cheap to construct.
pub(crate) struct HookSpec<'a> {
    /// Directory under `$HOME` that holds this agent's config
    /// (e.g. `.claude`).
    pub config_subdir: &'a str,
    /// File inside `config_subdir` that holds the hook config
    /// (e.g. `settings.json` for Claude/Gemini, `hooks.json` for Codex).
    pub settings_filename: &'a str,
    pub script_filename: &'a str,
    pub script_body: &'a str,
    /// Substring left in the command's trailing comment that identifies a
    /// Loom-managed entry across runs (e.g. `loom-stop-osc`).
    pub marker: &'a str,
    /// Older marker covered by the in-place upgrade path so users from
    /// pre-OSC builds get their entry migrated automatically.
    pub legacy_marker: Option<&'a str>,
    pub schema: HookSchema,
    /// Event names to install the hook under (e.g. `["Stop",
    /// "SessionStart"]` for Claude/Codex, `["SessionStart"]` for Gemini).
    pub events: &'a [&'a str],
}

/// Idempotent agent-hook install. Re-running either no-ops (already
/// up-to-date), upgrades an old marker in place, or appends a new entry,
/// then atomically rewrites the settings file only if something changed.
pub(crate) fn install_loom_hook(spec: &HookSpec<'_>) -> Result<HookSetupResult, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
    install_loom_hook_at(std::path::Path::new(&home), spec)
}

/// Same as `install_loom_hook`, but with an explicit home directory.
/// Tests use this to point the installer at a tempdir instead of
/// stomping on the user's real `~/.claude` / `~/.codex` / `~/.gemini`.
pub(crate) fn install_loom_hook_at(
    home: &std::path::Path,
    spec: &HookSpec<'_>,
) -> Result<HookSetupResult, String> {
    let dir = home.join(spec.config_subdir);
    let settings_path = dir.join(spec.settings_filename);
    let script_path = dir.join(spec.script_filename);

    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    // Always rewrite the script so upgrades pick up new logic. Atomic
    // write so a crash mid-update can't truncate the existing hook.
    atomic_write::write(&script_path, spec.script_body.as_bytes())
        .map_err(|e| format!("write {}: {e}", script_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)
            .map_err(|e| format!("stat {}: {e}", script_path.display()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms)
            .map_err(|e| format!("chmod {}: {e}", script_path.display()))?;
    }

    // Shell-quote the script path so a `$HOME` with spaces or metachars
    // doesn't word-split into "command + spurious args" when the agent
    // shells out the hook. `# marker` is a shell comment so the trailing
    // marker is harmless after the quoted path.
    let hook_command = format!(
        "{} # {}",
        shell_quote(&script_path.to_string_lossy()),
        spec.marker
    );

    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("read {}: {e}", settings_path.display()))?;
        serde_json::from_str(&content).unwrap_or_else(|e| {
            // The user's settings file was unparseable. Before falling
            // back to a fresh object, copy the original off to a
            // timestamped backup so a hand-edit (or a stray JSONC
            // comment in a file Loom didn't write) is recoverable. The
            // old behavior — log + silently clobber — was destroying
            // user state that the log warning couldn't be relied on to
            // surface.
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = settings_path.with_extension(format!("loom-backup-{stamp}.json"));
            match atomic_write::write(&backup, content.as_bytes()) {
                Ok(()) => log::warn!(
                    "settings file at {} is not valid JSON ({e}); original backed up to {}",
                    settings_path.display(),
                    backup.display()
                ),
                Err(be) => log::warn!(
                    "settings file at {} is not valid JSON ({e}); backup write also failed ({be}) — \
                     the next write will overwrite the unparseable file in place",
                    settings_path.display()
                ),
            }
            serde_json::json!({})
        })
    } else {
        serde_json::json!({})
    };

    if !settings.is_object() {
        log::warn!(
            "settings file at {} parsed as a non-object value; replacing with a fresh object",
            settings_path.display()
        );
        settings = serde_json::json!({});
    }

    // The is_object/is_array check-and-rewrite above guarantees the
    // matching `as_object_mut`/`as_array_mut` here will succeed, but we
    // still surface a clean error instead of panicking — a future
    // refactor that drops the early rewrite would otherwise crash a
    // Tauri command and (under panic = unwind) destabilize the runtime.
    let obj = settings.as_object_mut().ok_or_else(|| {
        format!(
            "{} root is not an object after normalization",
            spec.settings_filename
        )
    })?;
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or_else(|| "hooks field is not an object after normalization".to_string())?;

    let mut any_appended = false;
    let mut any_upgraded = false;
    let mut all_present = true;
    for event in spec.events {
        let array = hooks_obj
            .entry(*event)
            .or_insert_with(|| serde_json::json!([]));
        if !array.is_array() {
            *array = serde_json::json!([]);
        }
        let arr = array
            .as_array_mut()
            .ok_or_else(|| format!("{event} hooks field is not an array after normalization"))?;
        let outcome = match spec.schema {
            HookSchema::Nested => {
                upsert_nested_hook_entry(arr, &hook_command, spec.marker, spec.legacy_marker)
            }
            HookSchema::Flat => upsert_flat_hook_entry(arr, &hook_command, spec.marker),
        };
        any_appended |= outcome.appended;
        any_upgraded |= outcome.upgraded;
        all_present &= outcome.already_present;
    }

    let added = any_appended;
    let upgraded = any_upgraded;

    if !added && !upgraded {
        // Already up to date — leave the file untouched.
        return Ok(HookSetupResult {
            added: false,
            already_present: all_present,
            upgraded: false,
            path: settings_path.to_string_lossy().into_owned(),
        });
    }

    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("serialize {}: {e}", spec.settings_filename))?;
    atomic_write::write(&settings_path, serialized.as_bytes())
        .map_err(|e| format!("write {}: {e}", settings_path.display()))?;

    Ok(HookSetupResult {
        added,
        already_present: false,
        upgraded,
        path: settings_path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod install_tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn nested_spec(name: &str) -> HookSpec<'static> {
        // Lifetime cheat: the spec borrows &'static strs; tests construct
        // them at call-site so this static-leaking pattern is fine.
        let _ = name;
        HookSpec {
            config_subdir: ".claude",
            settings_filename: "settings.json",
            script_filename: "loom-stop-hook.sh",
            script_body: "#!/bin/sh\necho test\n",
            marker: "loom-stop-osc",
            legacy_marker: Some("loom-notify-hook"),
            schema: HookSchema::Nested,
            events: &["Stop", "SessionStart"],
        }
    }

    fn read_settings(home: &Path) -> Value {
        let raw = fs::read_to_string(home.join(".claude").join("settings.json")).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn first_run_writes_script_settings_and_marks_added() {
        let home = TempDir::new().unwrap();
        let result = install_loom_hook_at(home.path(), &nested_spec("claude")).unwrap();
        assert!(result.added);
        assert!(!result.already_present);
        assert!(!result.upgraded);

        // Script written + chmod'd executable.
        let script = home.path().join(".claude").join("loom-stop-hook.sh");
        assert!(script.exists());
        let body = fs::read_to_string(&script).unwrap();
        assert!(body.contains("echo test"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&script).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }

        // settings.json has Stop + SessionStart hook entries with the marker.
        let settings = read_settings(home.path());
        let hooks = settings["hooks"].as_object().unwrap();
        for event in ["Stop", "SessionStart"] {
            let arr = hooks[event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "exactly one entry in {event}");
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.ends_with(" # loom-stop-osc"));
        }
    }

    #[test]
    fn re_run_is_idempotent_and_reports_already_present() {
        let home = TempDir::new().unwrap();
        install_loom_hook_at(home.path(), &nested_spec("claude")).unwrap();
        let mtime = fs::metadata(home.path().join(".claude").join("settings.json"))
            .unwrap()
            .modified()
            .unwrap();

        // Sleep a beat so an erroneous rewrite would change mtime.
        std::thread::sleep(std::time::Duration::from_millis(20));

        let second = install_loom_hook_at(home.path(), &nested_spec("claude")).unwrap();
        assert!(!second.added);
        assert!(!second.upgraded);
        assert!(second.already_present);

        let mtime2 = fs::metadata(home.path().join(".claude").join("settings.json"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            mtime, mtime2,
            "no-op install must not touch the settings file"
        );
    }

    #[test]
    fn legacy_marker_is_upgraded_to_new_marker() {
        let home = TempDir::new().unwrap();
        // Hand-write a Stop entry that uses the LEGACY marker; install
        // should rewrite the command but not append a duplicate.
        let dir = home.path().join(".claude");
        fs::create_dir_all(&dir).unwrap();
        let legacy_settings = serde_json::json!({
            "hooks": {
                "Stop": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": "/old/path/loom-stop.sh # loom-notify-hook",
                    }],
                }],
            },
        });
        fs::write(
            dir.join("settings.json"),
            serde_json::to_string_pretty(&legacy_settings).unwrap(),
        )
        .unwrap();

        let result = install_loom_hook_at(home.path(), &nested_spec("claude")).unwrap();
        assert!(result.upgraded);
        assert!(!result.already_present);

        let settings = read_settings(home.path());
        let stop_arr = settings["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop_arr.len(), 1, "upgrade in place, not append");
        let cmd = stop_arr[0]["hooks"][0]["command"].as_str().unwrap();
        // New command points at the freshly-written script + new marker.
        assert!(cmd.ends_with(" # loom-stop-osc"));
        assert!(cmd.contains("loom-stop-hook.sh"));
    }

    #[test]
    fn corrupted_settings_json_is_replaced_with_a_fresh_object() {
        let home = TempDir::new().unwrap();
        let dir = home.path().join(".claude");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), "{ not json at all }").unwrap();

        // Should succeed (not return Err) and write a valid object.
        let result = install_loom_hook_at(home.path(), &nested_spec("claude")).unwrap();
        assert!(result.added);

        let settings = read_settings(home.path());
        assert!(settings["hooks"]["Stop"].is_array());
    }

    #[test]
    fn unrelated_settings_keys_are_preserved() {
        let home = TempDir::new().unwrap();
        let dir = home.path().join(".claude");
        fs::create_dir_all(&dir).unwrap();
        let existing = serde_json::json!({
            "model": "claude-sonnet-4-7",
            "theme": "dark",
            "hooks": {
                "Notification": [
                    {
                        "matcher": "",
                        "hooks": [{
                            "type": "command",
                            "command": "/usr/bin/notify-send Hi",
                        }],
                    },
                ],
            },
        });
        fs::write(
            dir.join("settings.json"),
            serde_json::to_string_pretty(&existing).unwrap(),
        )
        .unwrap();

        install_loom_hook_at(home.path(), &nested_spec("claude")).unwrap();

        let after = read_settings(home.path());
        assert_eq!(after["model"], "claude-sonnet-4-7");
        assert_eq!(after["theme"], "dark");
        // Existing Notification hook still there.
        let notif = after["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
        assert_eq!(notif[0]["hooks"][0]["command"], "/usr/bin/notify-send Hi",);
        // Loom's Stop hook landed alongside.
        assert!(after["hooks"]["Stop"].is_array());
    }

    #[test]
    fn flat_schema_writes_unwrapped_entries() {
        let home = TempDir::new().unwrap();
        let spec = HookSpec {
            config_subdir: ".gemini",
            settings_filename: "settings.json",
            script_filename: "loom-gemini.sh",
            script_body: "#!/bin/sh\n",
            marker: "loom-gemini-session-osc",
            legacy_marker: None,
            schema: HookSchema::Flat,
            events: &["SessionStart"],
        };
        install_loom_hook_at(home.path(), &spec).unwrap();

        let raw = fs::read_to_string(home.path().join(".gemini").join("settings.json")).unwrap();
        let settings: Value = serde_json::from_str(&raw).unwrap();
        let entries = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        // Flat: {type, command} — no nested `hooks: [...]`, no `matcher`.
        assert_eq!(entries[0]["type"], "command");
        assert!(entries[0].get("hooks").is_none());
        assert!(entries[0].get("matcher").is_none());
    }
}

/// POSIX shell-quote a path. Leaves the safe-character subset alone so
/// the trailing `# marker` comment stays readable in settings.json;
/// single-quote-with-escape anything else.
fn shell_quote(s: &str) -> String {
    let safe = s.bytes().all(|b| {
        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'@' | b':' | b'+' | b'-')
    });
    if safe {
        s.to_string()
    } else {
        // Standard escape: close-quote, escape literal `'`, open-quote.
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Identity check: does this command look like a Loom-managed entry?
/// Tightened from `cmd.contains(marker)` to `cmd.trim_end().ends_with(" # marker")` —
/// the marker is always written as a trailing shell comment, so requiring
/// the exact ` # <marker>` suffix (rather than any substring anywhere)
/// prevents a user's own command that incidentally mentions the marker
/// from being silently rewritten as if Loom had created it.
fn is_loom_owned(cmd: &str, marker: &str, legacy_marker: Option<&str>) -> bool {
    let tail_marker = format!(" # {marker}");
    let trimmed = cmd.trim_end();
    if trimmed.ends_with(&tail_marker) {
        return true;
    }
    if let Some(lm) = legacy_marker {
        let legacy_tail = format!(" # {lm}");
        if trimmed.ends_with(&legacy_tail) {
            return true;
        }
    }
    false
}

/// Upsert into a Claude-style hook array — each entry is
/// `{matcher, hooks: [{type, command}]}`. Used by Claude and Codex.
pub(crate) fn upsert_nested_hook_entry(
    arr: &mut Vec<Value>,
    hook_command: &str,
    marker: &str,
    legacy_marker: Option<&str>,
) -> UpsertOutcome {
    let mut outcome = UpsertOutcome::default();
    for entry in arr.iter_mut() {
        let inner = match entry.get_mut("hooks").and_then(|h| h.as_array_mut()) {
            Some(a) => a,
            None => continue,
        };
        for h in inner.iter_mut() {
            let cmd = h
                .get("command")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            if !is_loom_owned(&cmd, marker, legacy_marker) {
                continue;
            }
            if cmd == hook_command {
                outcome.already_present = true;
                return outcome;
            }
            if let Some(obj) = h.as_object_mut() {
                obj.insert(
                    "command".to_string(),
                    Value::String(hook_command.to_string()),
                );
                outcome.upgraded = true;
            }
        }
    }
    if !outcome.upgraded {
        arr.push(serde_json::json!({
            "matcher": "",
            "hooks": [{
                "type": "command",
                "command": hook_command,
            }],
        }));
        outcome.appended = true;
    }
    outcome
}

#[cfg(test)]
mod nested_tests {
    use super::*;

    const MARKER: &str = "loom-stop-osc";
    const LEGACY: &str = "loom-notify-hook";

    #[test]
    fn appends_when_array_is_empty() {
        let mut arr: Vec<Value> = Vec::new();
        let outcome = upsert_nested_hook_entry(&mut arr, "/bin/loom # loom-stop-osc", MARKER, None);
        assert!(outcome.appended);
        assert!(!outcome.upgraded);
        assert!(!outcome.already_present);
        assert_eq!(arr.len(), 1);
        let first = &arr[0];
        assert_eq!(first["matcher"], "");
        let inner = first["hooks"].as_array().unwrap();
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0]["type"], "command");
        assert_eq!(inner[0]["command"], "/bin/loom # loom-stop-osc");
    }

    #[test]
    fn appends_when_array_has_unrelated_entries() {
        let mut arr: Vec<Value> = vec![serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "/usr/bin/notify-send done"}],
        })];
        let outcome = upsert_nested_hook_entry(&mut arr, "/bin/loom # loom-stop-osc", MARKER, None);
        assert!(outcome.appended);
        assert_eq!(arr.len(), 2);
        // Pre-existing entry left alone.
        assert_eq!(arr[0]["hooks"][0]["command"], "/usr/bin/notify-send done");
    }

    #[test]
    fn reports_already_present_for_byte_identical_match() {
        let cmd = "/bin/loom # loom-stop-osc";
        let mut arr: Vec<Value> = vec![serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": cmd}],
        })];
        let outcome = upsert_nested_hook_entry(&mut arr, cmd, MARKER, None);
        assert!(!outcome.appended);
        assert!(!outcome.upgraded);
        assert!(outcome.already_present);
        // No new entry appended.
        assert_eq!(arr.len(), 1);
    }

    #[test]
    fn upgrades_in_place_when_command_drifted() {
        let mut arr: Vec<Value> = vec![serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "/old/path/loom-stop.sh # loom-stop-osc"}],
        })];
        let outcome = upsert_nested_hook_entry(
            &mut arr,
            "/new/path/loom-stop.sh # loom-stop-osc",
            MARKER,
            None,
        );
        assert!(!outcome.appended);
        assert!(outcome.upgraded);
        assert!(!outcome.already_present);
        assert_eq!(arr.len(), 1);
        assert_eq!(
            arr[0]["hooks"][0]["command"],
            "/new/path/loom-stop.sh # loom-stop-osc"
        );
    }

    #[test]
    fn upgrades_legacy_marker_to_new_marker() {
        let mut arr: Vec<Value> = vec![serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "/old/path/loom-notify.sh # loom-notify-hook"}],
        })];
        let outcome = upsert_nested_hook_entry(
            &mut arr,
            "/new/path/loom-stop.sh # loom-stop-osc",
            MARKER,
            Some(LEGACY),
        );
        assert!(outcome.upgraded);
        assert!(!outcome.appended);
        assert_eq!(
            arr[0]["hooks"][0]["command"],
            "/new/path/loom-stop.sh # loom-stop-osc"
        );
    }

    #[test]
    fn ignores_entries_without_a_hooks_array() {
        let mut arr: Vec<Value> = vec![serde_json::json!({"matcher": "", "hooks": "not-an-array"})];
        let outcome = upsert_nested_hook_entry(&mut arr, "/bin/loom # loom-stop-osc", MARKER, None);
        assert!(outcome.appended);
        // Malformed entry left alone, new entry appended.
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn does_not_hijack_user_command_with_marker_substring_internal() {
        // A user-written hook whose command happens to contain
        // "loom-stop-osc" somewhere internally (not as the trailing
        // shell-comment marker) must NOT be treated as a Loom-managed
        // entry — the old `cmd.contains(marker)` check would silently
        // rewrite this user command to point at Loom's bundled script.
        let user_cmd = "/usr/bin/env STAGE=loom-stop-osc /bin/true";
        let mut arr: Vec<Value> = vec![serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": user_cmd}],
        })];
        let outcome = upsert_nested_hook_entry(
            &mut arr,
            "/path/to/loom-stop-hook.sh # loom-stop-osc",
            MARKER,
            None,
        );
        assert!(
            outcome.appended,
            "user command must be left untouched and Loom appends fresh"
        );
        assert_eq!(arr.len(), 2);
        assert_eq!(
            arr[0]["hooks"][0]["command"], user_cmd,
            "user command must NOT have been rewritten"
        );
    }

    #[test]
    fn does_not_hijack_user_echo_command_mentioning_marker() {
        // Another realistic shape: a user echoing the marker word.
        let user_cmd = r#"echo "running loom-stop-osc-replacement""#;
        let mut arr: Vec<Value> = vec![serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": user_cmd}],
        })];
        let outcome = upsert_nested_hook_entry(
            &mut arr,
            "/path/to/loom-stop-hook.sh # loom-stop-osc",
            MARKER,
            None,
        );
        assert!(outcome.appended);
        assert_eq!(arr[0]["hooks"][0]["command"], user_cmd);
    }

    #[test]
    fn shell_quote_leaves_simple_paths_alone() {
        assert_eq!(
            shell_quote("/home/user/.claude/loom-stop-hook.sh"),
            "/home/user/.claude/loom-stop-hook.sh"
        );
    }

    #[test]
    fn shell_quote_single_quotes_paths_with_spaces() {
        assert_eq!(
            shell_quote("/Users/Foo Bar/.claude/loom-stop-hook.sh"),
            "'/Users/Foo Bar/.claude/loom-stop-hook.sh'"
        );
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quote() {
        // POSIX trick: close-quote, escape literal `'`, open-quote.
        // The output `'it'\''s'` reassembles to `it's` in the shell.
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn shell_quote_handles_command_substitution_chars() {
        // `$(...)` and backticks in $HOME would otherwise run as command
        // substitution when the agent shells out the hook command.
        let evil_home = "/Users/$(touch /tmp/pwn)/.claude/loom.sh";
        let quoted = shell_quote(evil_home);
        assert!(quoted.starts_with('\''));
        assert!(quoted.ends_with('\''));
        assert!(quoted.contains("$(touch /tmp/pwn)"));
    }
}

/// Upsert into a Gemini-style hook array — each entry is `{type, command}`
/// directly (no nested `hooks` wrapper). Identity check matches the
/// nested form: exact ` # <marker>` suffix, not substring-anywhere.
pub(crate) fn upsert_flat_hook_entry(
    arr: &mut Vec<Value>,
    hook_command: &str,
    marker: &str,
) -> UpsertOutcome {
    let mut outcome = UpsertOutcome::default();
    for entry in arr.iter_mut() {
        let cmd = entry
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        if !is_loom_owned(&cmd, marker, None) {
            continue;
        }
        if cmd == hook_command {
            outcome.already_present = true;
            return outcome;
        }
        if let Some(obj) = entry.as_object_mut() {
            obj.insert(
                "command".to_string(),
                Value::String(hook_command.to_string()),
            );
            outcome.upgraded = true;
        }
    }
    if !outcome.upgraded {
        arr.push(serde_json::json!({
            "type": "command",
            "command": hook_command,
        }));
        outcome.appended = true;
    }
    outcome
}

#[cfg(test)]
mod flat_tests {
    use super::*;

    const MARKER: &str = "loom-gemini-session-osc";

    #[test]
    fn appends_into_empty_array() {
        let mut arr: Vec<Value> = Vec::new();
        let outcome =
            upsert_flat_hook_entry(&mut arr, "/bin/loom # loom-gemini-session-osc", MARKER);
        assert!(outcome.appended);
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "command");
        assert_eq!(arr[0]["command"], "/bin/loom # loom-gemini-session-osc");
        // Flat schema must NOT wrap in a `hooks` array — that's the
        // nested form Claude/Codex use, which Gemini wouldn't honor.
        assert!(arr[0].get("hooks").is_none());
        assert!(arr[0].get("matcher").is_none());
    }

    #[test]
    fn reports_already_present_for_identical_command() {
        let cmd = "/bin/loom # loom-gemini-session-osc";
        let mut arr: Vec<Value> = vec![serde_json::json!({"type": "command", "command": cmd})];
        let outcome = upsert_flat_hook_entry(&mut arr, cmd, MARKER);
        assert!(outcome.already_present);
        assert!(!outcome.appended);
        assert!(!outcome.upgraded);
        assert_eq!(arr.len(), 1);
    }

    #[test]
    fn upgrades_when_marker_matches_but_command_drifted() {
        let mut arr: Vec<Value> = vec![serde_json::json!({
            "type": "command",
            "command": "/old/path/loom-gemini.sh # loom-gemini-session-osc",
        })];
        let outcome = upsert_flat_hook_entry(
            &mut arr,
            "/new/path/loom-gemini.sh # loom-gemini-session-osc",
            MARKER,
        );
        assert!(outcome.upgraded);
        assert_eq!(arr.len(), 1);
        assert_eq!(
            arr[0]["command"],
            "/new/path/loom-gemini.sh # loom-gemini-session-osc"
        );
    }

    #[test]
    fn leaves_unrelated_entries_alone_and_appends() {
        let mut arr: Vec<Value> = vec![serde_json::json!({
            "type": "command",
            "command": "/usr/bin/say session-start",
        })];
        let outcome =
            upsert_flat_hook_entry(&mut arr, "/bin/loom # loom-gemini-session-osc", MARKER);
        assert!(outcome.appended);
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["command"], "/usr/bin/say session-start");
        assert_eq!(arr[1]["command"], "/bin/loom # loom-gemini-session-osc");
    }
}
