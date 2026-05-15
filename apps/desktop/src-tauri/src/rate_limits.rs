//! Tracks Claude Code's rolling rate-limit windows (5-hour and 7-day)
//! for the user's claude.ai subscription, and surfaces the latest
//! snapshot to the React top-bar widget.
//!
//! The [`usage_poller`] module spawns `claude` in a hidden PTY, sends
//! `/usage`, parses the rendered modal, and calls [`update_from_poll`]
//! on a timer regardless of where the user's claude sessions live.
//! `RateLimitsInner::set` de-dupes, persists the snapshot to disk,
//! and fires `loom-rate-limits-changed` so the frontend re-renders
//! without polling.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::atomic_write;
use crate::AppState;

/// One rolling-window slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Window {
    /// 0..100, integer-ish.
    pub used_percentage: f32,
    /// Human-readable reset time as Claude renders it
    /// (e.g. `"9:30pm (Europe/Berlin)"` or `"May 20 at 9am"`). The
    /// frontend shows it verbatim in the tooltip — no timezone math
    /// needed on our side.
    pub resets_label: Option<String>,
    /// Unix epoch seconds when available (currently only from the
    /// stream-json `rate_limit_event` channel). The poller leaves this
    /// `None` and relies on `resets_label`.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RateLimits {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
    /// Unix epoch seconds when we last received an update. The UI
    /// shows this in a tooltip so users can tell if the value is stale.
    pub updated_at: i64,
}

#[derive(Default)]
pub struct RateLimitsInner {
    pub current: Mutex<Option<RateLimits>>,
}

impl RateLimitsInner {
    /// Apply a new snapshot. Skips emit when byte-identical to the
    /// previous one (avoids useless re-renders from a chatty stream).
    pub fn set(&self, app: &AppHandle, next: RateLimits) {
        let changed = {
            let mut slot = self.current.lock();
            let same = slot.as_ref().is_some_and(|cur| {
                cur.five_hour == next.five_hour && cur.seven_day == next.seven_day
            });
            *slot = Some(next.clone());
            !same
        };
        persist_to_disk(&next);
        if changed {
            let _ = app.emit("loom-rate-limits-changed", &next);
        }
    }
}

// ─── Ingest path A: poll-driven (`/usage` PTY scrape) ─────────────────

/// Called by [`crate::usage_poller`] after parsing `/usage` output.
/// Either window may be None if the modal didn't expose it (e.g.
/// API-key users get a different modal).
pub fn update_from_poll(app: &AppHandle, five_hour: Option<Window>, seven_day: Option<Window>) {
    if five_hour.is_none() && seven_day.is_none() {
        // Nothing parseable — typically an API-key user. Don't clobber
        // a previously-valid snapshot with emptiness.
        return;
    }
    let state: tauri::State<'_, AppState> = app.state();
    state.rate_limits.set(
        app,
        RateLimits {
            five_hour,
            seven_day,
            updated_at: now_secs(),
        },
    );
}

// ─── Tauri command + disk persistence ─────────────────────────────────

#[tauri::command]
pub fn rate_limits_get(app: AppHandle) -> Option<RateLimits> {
    let state: tauri::State<'_, AppState> = app.state();
    let slot = state.rate_limits.current.lock();
    if let Some(rl) = slot.clone() {
        return Some(rl);
    }
    // Cold start — hydrate from disk so the badge shows last-known
    // values immediately instead of blanking until the next poll.
    drop(slot);
    let restored = load_from_disk();
    if let Some(ref rl) = restored {
        *state.rate_limits.current.lock() = Some(rl.clone());
    }
    restored
}

fn disk_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join(".claude")
            .join(".loom-rate-limits.json"),
    )
}

fn persist_to_disk(rl: &RateLimits) {
    let Some(path) = disk_path() else {
        return;
    };
    persist_to_path(&path, rl);
}

fn load_from_disk() -> Option<RateLimits> {
    load_from_path(&disk_path()?)
}

/// Variant that takes the destination path directly, so tests can write
/// to a tempdir instead of touching `~/.claude`. Same atomic-write
/// + best-effort-mkdir semantics as the HOME-driven path.
fn persist_to_path(path: &std::path::Path, rl: &RateLimits) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_vec(rl) {
        let _ = atomic_write::write(path, &serialized);
    }
}

fn load_from_path(path: &std::path::Path) -> Option<RateLimits> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample() -> RateLimits {
        RateLimits {
            five_hour: Some(Window {
                used_percentage: 42.0,
                resets_label: Some("9:30pm (Europe/Berlin)".into()),
                resets_at: None,
            }),
            seven_day: Some(Window {
                used_percentage: 11.5,
                resets_label: Some("May 20 at 9am".into()),
                resets_at: Some(1_780_000_000),
            }),
            updated_at: 1_750_000_000,
        }
    }

    #[test]
    fn round_trip_preserves_both_windows_and_updated_at() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rate-limits.json");
        let original = sample();
        persist_to_path(&path, &original);
        let restored = load_from_path(&path).expect("load_from_path returned Some");
        assert_eq!(restored, original);
    }

    #[test]
    fn load_from_missing_path_returns_none() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert!(load_from_path(&path).is_none());
    }

    #[test]
    fn load_from_corrupted_payload_returns_none_not_panic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rate-limits.json");
        std::fs::write(&path, b"{ not even close to valid json").unwrap();
        // Best-effort: a broken disk cache shouldn't poison the badge,
        // it should just go cold and let the next poll re-populate.
        assert!(load_from_path(&path).is_none());
    }

    #[test]
    fn persist_creates_parent_dirs_if_missing() {
        let dir = TempDir::new().unwrap();
        // Path is two levels deep — neither exists yet.
        let path = dir.path().join("a").join("b").join("rl.json");
        persist_to_path(&path, &sample());
        assert!(path.exists(), "persist_to_path mkdir -p'd the parents");
        let restored = load_from_path(&path).unwrap();
        assert_eq!(restored, sample());
    }

    #[test]
    fn round_trip_handles_partial_snapshot_with_only_five_hour() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("rate-limits.json");
        let partial = RateLimits {
            five_hour: Some(Window {
                used_percentage: 16.0,
                resets_label: None,
                resets_at: None,
            }),
            seven_day: None,
            updated_at: 0,
        };
        persist_to_path(&path, &partial);
        assert_eq!(load_from_path(&path).unwrap(), partial);
    }
}
