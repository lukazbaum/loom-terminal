//! Sidecar-based transport for the `loom-stop` completion signal.
//!
//! Background: on Claude 2.1.142+ (and Codex similarly) the Stop hook
//! is detached from the controlling TTY, so the OSC `loom-stop` byte
//! the script tries to emit lands in `/dev/null` and never reaches our
//! PTY. Without an alternative transport, the frontend's completion
//! path (which pulses the workspace tab when an agent finishes a turn)
//! never fires for users on those builds.
//!
//! This module spawns a small poll thread that watches per-pane sidecar
//! files at `~/.loom/stops/<pane_id>`. The hook scripts write
//! (atomically, via tmp+rename) to that path on each `Stop` event; the
//! poller compares the file's mtime against an in-memory "last seen"
//! per pane and emits a `loom-stop-captured` Tauri event each time a
//! newer write appears.
//!
//! Why mtime instead of file contents: writes are idempotent and the
//! interesting bit is "did a fresh Stop just land", so a 64-bit
//! SystemTime comparison is the smallest sufficient signal.
//!
//! First-poll handling: when the poller first sees a pane id (from
//! `AppState::pane_to_session`), it records `SystemTime::now()` as the
//! baseline rather than the file's current mtime. That makes stale
//! sidecars from a previous Loom run (same pane id, old mtime) inert
//! — only writes that arrive after the pane was registered fire.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, Manager};

use crate::constants::SHUTTING_DOWN;
use crate::AppState;

/// Time between scans. 750 ms feels live (sub-second pulse after Claude
/// finishes) without burning CPU on filesystem stats. The hook itself
/// writes once per turn so there's nothing to debounce against.
const POLL_INTERVAL: Duration = Duration::from_millis(750);

/// Wait before the first scan so we don't race the Tauri window init.
const STARTUP_DELAY: Duration = Duration::from_millis(500);

/// Spawn the background poll loop. Idempotent — repeated calls (e.g.
/// from a hot-reloaded `setup()`) no-op so we don't end up with two
/// pollers fighting over the same files.
pub fn start(app: AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = thread::Builder::new()
        .name("loom-stops-poller".into())
        .stack_size(256 * 1024)
        .spawn(move || run_loop(app))
    {
        // Recoverable: completion-signal sidecar transport is dead, so
        // newer-Claude users won't get tab-pulse on turn end. Log so
        // the symptom has a discoverable cause.
        log::error!("failed to spawn stops poller thread: {e}");
    }
}

fn run_loop(app: AppHandle) {
    thread::sleep(STARTUP_DELAY);
    let dir = match stops_dir() {
        Some(d) => d,
        None => {
            log::warn!("stops poller: $HOME not set, completion-signal sidecar disabled");
            return;
        }
    };
    let mut last_seen: HashMap<String, SystemTime> = HashMap::new();
    loop {
        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            break;
        }
        let state = app.state::<AppState>();
        let pane_ids: Vec<String> = state.pane_to_session.lock().keys().cloned().collect();
        // Drop bookkeeping for panes that no longer exist so the map
        // doesn't grow without bound over long sessions.
        last_seen.retain(|pid, _| pane_ids.contains(pid));
        for pid in pane_ids {
            // Defense-in-depth: pane ids feed into a filesystem path
            // join, and although Loom generates them as `p_<base36>_…`
            // we shouldn't trust the map's keys to be path-safe.
            // Matches `workspace_cmds::read_pane_sidecar`.
            if !is_safe_pane_id(&pid) {
                continue;
            }
            let mtime = std::fs::metadata(dir.join(&pid))
                .and_then(|m| m.modified())
                .ok();
            // First time we see this pane: baseline at NOW so stale
            // sidecars from a previous run (file mtime < NOW) don't
            // fire a phantom completion on launch. `or_insert_with`
            // skips the SystemTime::now() call when the entry already
            // exists, which is the common path on every iteration
            // after the first.
            let last = last_seen.entry(pid.clone()).or_insert_with(SystemTime::now);
            if let Some(mt) = mtime {
                if mt > *last {
                    *last = mt;
                    let _ = app.emit("loom-stop-captured", serde_json::json!({ "pane_id": pid }));
                }
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn stops_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".loom").join("stops"))
}

/// Reject pane ids that could escape the stops directory when joined
/// into a path. Mirrors the check in
/// `workspace_cmds::read_pane_sidecar` — Loom generates pane ids
/// itself, so this is paranoia, not a known vector.
fn is_safe_pane_id(pid: &str) -> bool {
    !pid.is_empty() && !pid.contains('/') && !pid.contains('\\') && pid != ".."
}

#[cfg(test)]
mod tests {
    use super::is_safe_pane_id;

    #[test]
    fn safe_pane_id_accepts_loom_generated_ids() {
        assert!(is_safe_pane_id("p_abc123_def456"));
        assert!(is_safe_pane_id("simple"));
        assert!(is_safe_pane_id("with-dashes_and_underscores.123"));
    }

    #[test]
    fn safe_pane_id_rejects_path_traversal() {
        assert!(!is_safe_pane_id(""));
        assert!(!is_safe_pane_id(".."));
        assert!(!is_safe_pane_id("../etc"));
        assert!(!is_safe_pane_id("a/b"));
        assert!(!is_safe_pane_id("a\\b"));
    }
}
