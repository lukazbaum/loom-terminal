mod ansi;
mod atomic_write;
mod attach;
mod constants;
mod env_validate;
mod hook;
mod hook_codex;
mod hook_common;
mod hook_consent;
mod hook_gemini;
mod port_cmds;
mod port_detect;
mod pty;
mod pty_buffer;
mod rate_limits;
mod shell_env;
mod usage_poller;
mod workspace_cmds;

pub(crate) use env_validate::validate_env_map;
#[cfg(test)]
use pty_buffer::{OscScanner, RingBuffer};

use std::collections::{HashMap, HashSet};

use parking_lot::Mutex;
use tauri::{Emitter, Manager};

// Only `PaneSession` actually needs to cross the `lib.rs` boundary
// (it appears in `workspace_cmds::unregister_workspace_impl`'s
// drained-sessions type). The other pty types are referenced via
// their `pty::commands::` / `pty::spawn::` paths in the
// invoke_handler macro and don't need a re-export. Visibility is
// `pub(crate)` since the binary has no library consumers.
pub(crate) use pty::PaneSession;

pub struct Workspace {
    pub path: String,
    pub pane_ids: Vec<String>,
}

#[derive(Default)]
pub struct AppState {
    /// Keyed by an internal session_id (UUID) so React StrictMode double-mounts
    /// (which call spawn_terminal twice for the same pane) get independent
    /// entries — the first cleanup can't accidentally evict the second mount.
    pub sessions: Mutex<HashMap<String, PaneSession>>,
    /// pane_id (caller-provided, stable across remounts) -> latest session_id.
    pub pane_to_session: Mutex<HashMap<String, String>>,
    pub workspaces: Mutex<HashMap<String, Workspace>>,
    /// Per-workspace registry of dev-server URLs detected from PTY output.
    /// Populated by the URL detector in each pane's reader thread, after
    /// a HEAD probe confirms the server is actually accepting connections.
    pub workspace_ports: Mutex<HashMap<String, Vec<port_detect::WorkspacePort>>>,
    /// In-flight HEAD probes — keyed by (workspace_id, url). A duplicate
    /// detection while the same URL is already being probed is silently
    /// dropped instead of spawning a redundant thread.
    pub probe_in_flight: Mutex<HashSet<(String, String)>>,
    /// Latest snapshot of the Claude.ai subscription rate-limit
    /// windows (5h / 7d). Updated by the `usage_poller` — polls
    /// `claude /usage` on a timer.
    pub rate_limits: rate_limits::RateLimitsInner,
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    // ─── RingBuffer ──────────────────────────────────────────────────────

    #[test]
    fn ring_buffer_snapshot_since_no_growth_returns_empty() {
        let mut b = RingBuffer::new(64);
        b.push(b"hello");
        let token = b.total_pushed();
        let slice = b.snapshot_since(token);
        assert!(slice.bytes.is_empty());
        assert_eq!(slice.new_token, token);
        assert!(!slice.dropped);
    }

    #[test]
    fn ring_buffer_snapshot_since_returns_only_new_bytes() {
        let mut b = RingBuffer::new(64);
        b.push(b"first ");
        let t = b.total_pushed();
        b.push(b"second");
        let slice = b.snapshot_since(t);
        assert_eq!(slice.bytes, b"second");
        assert!(!slice.dropped);
        assert_eq!(slice.new_token, b.total_pushed());
    }

    #[test]
    fn ring_buffer_snapshot_since_marks_dropped_when_caller_fell_behind() {
        let mut b = RingBuffer::new(8);
        b.push(b"abcdefgh"); // exactly fills
        let stale_token = 0; // older than oldest byte still in buffer
        b.push(b"ij"); // evicts "ab"
        let slice = b.snapshot_since(stale_token);
        assert!(slice.dropped);
        // Returned bytes should be the entire current window (not the missing
        // prefix) so the caller can resync.
        assert_eq!(slice.bytes.len(), 8);
        assert_eq!(slice.bytes, b"cdefghij");
    }

    #[test]
    fn ring_buffer_total_pushed_is_monotonic_across_eviction() {
        let mut b = RingBuffer::new(4);
        b.push(b"abcd");
        assert_eq!(b.total_pushed(), 4);
        b.push(b"ef");
        assert_eq!(b.total_pushed(), 6);
        // Window holds last 4 bytes; total counts every byte ever pushed.
        assert_eq!(b.snapshot(), b"cdef");
    }

    // ─── OscScanner ──────────────────────────────────────────────────────

    fn run_scanner(chunks: &[&[u8]]) -> Vec<String> {
        let mut s = OscScanner::new();
        let mut sessions = Vec::new();
        for c in chunks {
            sessions.extend(s.feed(c));
        }
        sessions
    }

    #[test]
    fn osc_scanner_captures_session_marker() {
        let sessions = run_scanner(&[b"\x1b]9;loom-session;abc-123-def-456\x1b\\"]);
        assert_eq!(sessions, vec!["abc-123-def-456".to_string()]);
    }

    #[test]
    fn osc_scanner_session_marker_with_bel_terminator() {
        let sessions = run_scanner(&[b"\x1b]9;loom-session;abc-123\x07"]);
        assert_eq!(sessions, vec!["abc-123".to_string()]);
    }

    #[test]
    fn osc_scanner_ignores_stop_marker_at_backend_layer() {
        // `loom-stop` is consumed by xterm.js on the frontend; the
        // backend scanner only tracks session ids. Its bytes are plain
        // output from this scanner's POV.
        let sessions = run_scanner(&[b"\x1b]9;loom-stop\x1b\\"]);
        assert!(sessions.is_empty());
    }

    #[test]
    fn osc_scanner_ignores_unrelated_bytes() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x1b[31mred\x1b[0m");
        bytes.extend_from_slice(b"\x07");
        bytes.extend_from_slice(b"\x1b]133;D\x1b\\");
        let sessions = run_scanner(&[&bytes]);
        assert!(sessions.is_empty());
    }

    #[test]
    fn osc_scanner_drops_oversized_session_without_panicking() {
        let mut payload = Vec::new();
        payload.extend_from_slice(b"\x1b]9;loom-session;");
        payload.extend(std::iter::repeat_n(
            b'x',
            pty_buffer::OSC_PAYLOAD_MAX_BYTES + 100,
        ));
        payload.extend_from_slice(b"\x1b\\");
        // Plus a well-formed session marker after to verify the scanner
        // recovers and keeps processing.
        payload.extend_from_slice(b"\x1b]9;loom-session;ok-id\x1b\\");
        let sessions = run_scanner(&[&payload]);
        assert_eq!(sessions, vec!["ok-id".to_string()]);
    }

    #[test]
    fn osc_scanner_handles_session_marker_split_across_chunks() {
        let sessions = run_scanner(&[b"\x1b]9;loom-ses", b"sion;split-uuid\x1b\\"]);
        assert_eq!(sessions, vec!["split-uuid".to_string()]);
    }

    #[test]
    fn osc_scanner_handles_terminator_esc_split_across_chunks() {
        let sessions = run_scanner(&[b"\x1b]9;loom-session;abc\x1b", b"\\"]);
        assert_eq!(sessions, vec!["abc".to_string()]);
    }
}

/// Forward panics to the log file before the unwinding thread dies, so
/// user bug reports include a stack location instead of an empty
/// `~/Library/Logs/com.loom.app/Loom.log`. Without this hook a panic in
/// any worker thread (PTY reader, URL probe, usage poller) was
/// invisible in macOS app bundles — stderr goes nowhere.
///
/// In release builds we deliberately log only the location + a short
/// payload, NOT the full backtrace — captured backtraces include
/// in-frame strings (panic messages derived from parsed input, etc.)
/// that can persist scraped user data into a file with whatever umask
/// the OS handed us. Debug builds keep the full trace.
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map_or_else(
            || "<unknown>".into(),
            |l| format!("{}:{}:{}", l.file(), l.line(), l.column()),
        );
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| {
                info.payload()
                    .downcast_ref::<String>()
                    .map(std::string::String::as_str)
            })
            .unwrap_or("<non-string panic payload>");
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        if cfg!(debug_assertions) {
            log::error!(
                "panic on thread '{thread}' at {location}: {payload}\nbacktrace:\n{:?}",
                std::backtrace::Backtrace::capture()
            );
        } else {
            log::error!("panic on thread '{thread}' at {location}: {payload}");
        }
        // Delegate so the default hook still writes to stderr in dev.
        default(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    tauri::Builder::default()
        // Logger first so failures in subsequent plugin init are visible.
        // Default targets write to ~/Library/Logs/com.loom.app/Loom.log
        // on macOS, %LOCALAPPDATA%\com.loom.app\logs\Loom.log on Windows,
        // and ~/.local/share/com.loom.app/logs/Loom.log on Linux.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2 * 1024 * 1024)
                // KeepOne caps disk-resident panic / log corpus at one
                // rotated file. The previous KeepAll grew indefinitely
                // (panic backtraces from prior runs persisting forever).
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = AppState::default();
            app.manage(state);

            // Spawn the rate-limit poller. It polls `claude /usage`
            // in a hidden PTY on a timer and updates the top-bar
            // badge regardless of where the user's actual claude
            // sessions live.
            usage_poller::start(app.handle().clone());

            // Per-agent consent gate. We only auto-install or auto-upgrade
            // hooks for agents the user previously opted into. First run
            // after this module landed: `migrate_implicit_consent` scans
            // each agent's config for an existing Loom marker so users
            // who accepted an older Welcome flow aren't re-prompted.
            //
            // Idempotent — the upsert detects legacy markers and rewrites
            // them in place, so opted-in users get the latest report-
            // emitting script transparently. Best-effort: log on failure
            // but don't block app start. When an upgrade happens, emit
            // an event so the UI can prompt the user to restart already-
            // running panes (which have the old hook cached in their
            // in-memory settings.json snapshot). On failure, emit
            // `loom-hook-failed` so the UI can toast — silent failure
            // used to look like the agent hanging because wait_for_idle
            // never saw a marker.
            let consent = hook_consent::migrate_implicit_consent();

            if consent.claude == hook_consent::AgentConsent::Enabled {
                match hook::configure_claude_notification_hook() {
                    Ok(result) if result.upgraded => {
                        let _ = app.handle().emit("loom-hook-upgraded", &result);
                    }
                    Err(e) => {
                        log::warn!("failed to configure Claude Stop hook: {e}");
                        let _ = app.handle().emit(
                            "loom-hook-failed",
                            serde_json::json!({ "error": e, "agent": "claude" }),
                        );
                    }
                    Ok(_) => {}
                }
            }

            // Codex hooks are behind a feature flag in
            // ~/.codex/config.toml; the installer flips it on if (and
            // only if) the user hasn't already set the flag explicitly
            // either way.
            if consent.codex == hook_consent::AgentConsent::Enabled {
                match hook_codex::configure_codex_notification_hook() {
                    Ok(result) if result.upgraded => {
                        let _ = app.handle().emit("loom-hook-upgraded", &result);
                    }
                    Err(e) => {
                        log::warn!("failed to configure Codex hook: {e}");
                        let _ = app.handle().emit(
                            "loom-hook-failed",
                            serde_json::json!({ "error": e, "agent": "codex" }),
                        );
                    }
                    Ok(_) => {}
                }
            }

            // Gemini has no per-turn Stop hook — SessionStart-only is
            // enough since `gemini --resume <uuid>` accepts the same id
            // we capture at session boot.
            if consent.gemini == hook_consent::AgentConsent::Enabled {
                match hook_gemini::configure_gemini_notification_hook() {
                    Ok(result) if result.upgraded => {
                        let _ = app.handle().emit("loom-hook-upgraded", &result);
                    }
                    Err(e) => {
                        log::warn!("failed to configure Gemini hook: {e}");
                        let _ = app.handle().emit(
                            "loom-hook-failed",
                            serde_json::json!({ "error": e, "agent": "gemini" }),
                        );
                    }
                    Ok(_) => {}
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn::spawn_terminal,
            pty::commands::write_terminal,
            pty::commands::resize_terminal,
            pty::commands::snapshot_pane_since,
            pty::commands::read_pane_text,
            pty::commands::pane_token,
            pty::commands::kill_terminal,
            pty::commands::restart_pane,
            workspace_cmds::workspace_dirty_summary,
            workspace_cmds::workspace_disk_space,
            port_cmds::list_workspace_ports,
            port_cmds::dismiss_workspace_port,
            attach::read_file_for_attach,
            workspace_cmds::get_pane_session_ids,
            workspace_cmds::paths_exist,
            workspace_cmds::register_workspace,
            workspace_cmds::unregister_workspace,
            hook::configure_claude_notification_hook,
            hook_codex::configure_codex_notification_hook,
            hook_gemini::configure_gemini_notification_hook,
            hook_consent::hook_consent_status,
            hook_consent::hook_consent_set,
            rate_limits::rate_limits_get,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // Tauri init / runtime failure — the GUI can't start, so
            // there's no graceful path back to the user. Skip the
            // `.expect()` panic (which produced a noisy "panic at
            // lib.rs:399" trace in the log file via our panic hook) and
            // emit a single direct error line instead. Mirror to stderr
            // so `cargo run` users see it without tailing the log.
            log::error!("tauri runtime failed: {e}");
            eprintln!("loom: tauri runtime failed: {e}");
            std::process::exit(1);
        })
        .run(|_app, event| {
            // Flip the process-wide shutdown flag so background threads
            // (URL probe poll loop, usage poller) can break out of their
            // current iteration instead of holding up app quit for the
            // remainder of a 6-second probe cycle. `Exit` fires on every
            // teardown path including window-close-quit on macOS; the
            // `ExitRequested` arm covers the brief pre-exit window so
            // probes already mid-sleep see the flag flip too.
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                constants::SHUTTING_DOWN.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });
}
