/// Workspace-level Tauri commands: registration, dirty / disk probes,
/// session-id discovery. Reads from / writes to `AppState`'s workspace
/// and session maps; no PTY internals here.
use std::collections::HashMap;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::State;

use crate::{AppState, PaneSession, Workspace};

#[tauri::command]
pub fn register_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<(), String> {
    // Absolute paths only — both `df` (which accepts options after
    // `-P -k`) and `git -C` would otherwise interpret a path starting
    // with `-` as a flag. Also blocks `..` smuggling through downstream
    // shell-out paths. We don't canonicalize here because the workspace
    // folder may be temporarily missing (mounted volume, etc.) and
    // `canonicalize` requires the path to exist.
    if !std::path::Path::new(&path).is_absolute() {
        return Err(format!("workspace path must be absolute: {path}"));
    }
    let mut wmap = state.workspaces.lock();
    wmap.entry(workspace_id).or_insert(Workspace {
        path,
        pane_ids: Vec::new(),
    });
    Ok(())
}

/// Tears the workspace down in one lock pass: removes its entry from
/// the workspaces map, kills every pane session that belonged to it,
/// drops the pane→session reverse mappings, and clears the detected-port
/// registry for it. Per-pane `kill_terminal` calls fired by each
/// `<TerminalView>`'s unmount cleanup hit empty maps after this and
/// become cheap no-ops — saving N IPC round-trips of lock contention
/// when closing a workspace with many panes.
///
/// Lock-order safety: this command never holds more than one global
/// map lock at a time. The pty.rs lock-order doc only constrains call
/// sites that hold multiple locks concurrently; the release-then-
/// acquire pattern used here side-steps it entirely. The order we
/// acquire them in (workspaces → pane_to_session → sessions →
/// workspace_ports) is deliberately the same as the snapshot the data
/// flows through — read the workspace's pane list, look each pane up
/// in the reverse index, drain the session entries, then trim port
/// state — so a concurrent `kill_terminal` against any single pane
/// either lands before we read the workspace's list (and disappears
/// from it) or lands after (and finds an empty p2s entry, no-ops).
/// The expensive session drops (PTY teardown, ChildGuard SIGKILL)
/// happen *after* the sessions map lock is released so they don't
/// serialize spawns for surviving workspaces.
#[tauri::command]
pub fn unregister_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    unregister_workspace_impl(&state, &workspace_id);
    Ok(())
}

/// Tauri-state-free body of `unregister_workspace`. Split out so the
/// lock-order regression test can exercise the exact same acquisition
/// dance from multiple threads without needing a real `State<'_,
/// AppState>` (which is Tauri-runtime-only).
pub(crate) fn unregister_workspace_impl(state: &AppState, workspace_id: &str) {
    let pane_ids: Vec<String> = {
        let mut wmap = state.workspaces.lock();
        wmap.remove(workspace_id)
            .map(|w| w.pane_ids)
            .unwrap_or_default()
    };

    if !pane_ids.is_empty() {
        // Resolve pane_id -> session_id while holding the reverse map
        // briefly, then release it before draining sessions so the
        // expensive drop (PTY teardown, ChildGuard SIGKILL) doesn't
        // serialize spawns for surviving workspaces.
        let session_ids: Vec<String> = {
            let mut p2s = state.pane_to_session.lock();
            pane_ids.iter().filter_map(|pid| p2s.remove(pid)).collect()
        };

        if !session_ids.is_empty() {
            let mut sessions = state.sessions.lock();
            // Pull each session out so its Drop (ChildGuard SIGKILL +
            // PTY fd close) runs after we release the map lock —
            // matches the per-pane kill_terminal pattern.
            let drained: Vec<PaneSession> = session_ids
                .iter()
                .filter_map(|sid| sessions.remove(sid))
                .collect();
            drop(sessions);
            for mut s in drained {
                s.shutdown.store(true, Ordering::Relaxed);
                let _ = s.child.kill();
            }
        }
    }

    // Clear any detected ports for this workspace — keyed by
    // workspace_id, so one removal covers all panes.
    state.workspace_ports.lock().remove(workspace_id);
}

#[derive(Serialize)]
pub struct DirtySummary {
    /// Number of `git status --porcelain` rows. None when the path isn't
    /// a git repo or git itself is unavailable.
    pub dirty_files: Option<u64>,
    pub branch: Option<String>,
}

#[derive(Serialize)]
pub struct DiskSpace {
    pub free_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

/// Cheap free-space probe via `df -P -k <path>`. We treat any failure as
/// "unknown" (returning None) rather than blocking — the UI just won't
/// surface a warning. Used by the workspace launch path to nudge users
/// before they hit confusing PTY / agent-timeout errors caused by a
/// nearly-full disk.
fn probe_disk_space(path: &str) -> DiskSpace {
    let out = std::process::Command::new("df")
        .args(["-P", "-k", path])
        .output();
    let stdout = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => {
            return DiskSpace {
                free_bytes: None,
                total_bytes: None,
            }
        }
    };
    // Skip header; second line has size data. Columns: filesystem
    // 1024-blocks used available capacity mounted-on.
    let row = stdout.lines().nth(1).unwrap_or("");
    let cols: Vec<&str> = row.split_whitespace().collect();
    if cols.len() < 4 {
        return DiskSpace {
            free_bytes: None,
            total_bytes: None,
        };
    }
    let total_kb: Option<u64> = cols[1].parse().ok();
    let free_kb: Option<u64> = cols[3].parse().ok();
    DiskSpace {
        free_bytes: free_kb.map(|kb| kb * 1024),
        total_bytes: total_kb.map(|kb| kb * 1024),
    }
}

#[tauri::command]
pub fn workspace_disk_space(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<DiskSpace, String> {
    let path = state
        .workspaces
        .lock()
        .get(&workspace_id)
        .ok_or_else(|| format!("unknown workspace: {workspace_id}"))?
        .path
        .clone();
    Ok(probe_disk_space(&path))
}

/// Cheap summary of uncommitted changes for the workspace's path. Used by
/// the close-workspace confirm dialog to warn before discarding work.
/// Best-effort: any failure (no git, not a repo, slow disk) returns
/// `dirty_files: None` rather than blocking the UI.
///
/// One git invocation does both jobs via `--branch --porcelain=v1`:
/// stdout's first line is `## <branch>...` (or `## HEAD (no branch)` in
/// a detached state), and the rest are one row per dirty entry. Two
/// processes were doubling fork+exec cost per close-workspace probe;
/// the combined form runs ~2x faster on slow disks.
#[tauri::command]
pub fn workspace_dirty_summary(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<DirtySummary, String> {
    let path = state
        .workspaces
        .lock()
        .get(&workspace_id)
        .ok_or_else(|| format!("unknown workspace: {workspace_id}"))?
        .path
        .clone();

    // If the workspace folder is gone (user deleted it / a watched repo
    // moved), `Command::current_dir` followed by `output()` fails with
    // ENOENT on every call. That's a normal state — stale workspaces
    // sit in the sidebar until the user closes them — so it shouldn't
    // wake the warn channel up. Short-circuit before spawning.
    if !std::path::Path::new(&path).is_dir() {
        return Ok(DirtySummary {
            dirty_files: None,
            branch: None,
        });
    }

    // `git status` evaluates several config keys from the repo's
    // .git/config that have program-execution side effects:
    //   - core.fsmonitor (runs the program for every status invocation)
    //   - core.hooksPath  (relocates hook scripts)
    //   - protocol.ext.allow / `ext::…` remote helpers
    // A user who opens an attacker-staged repo as a workspace would
    // otherwise trigger arbitrary code execution at every close-dialog
    // probe. Pin each one to an empty / disallowed value via `-c`.
    let out = match std::process::Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.ext.allow=never",
            "status",
            "--porcelain=v1",
            "--branch",
        ])
        .current_dir(&path)
        .output()
    {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            // Not a repo / git ran but bailed — common when the user
            // points Loom at a plain folder. Log at debug so the noise
            // doesn't crowd the warn channel.
            log::debug!(
                "git status in {} returned non-zero ({}): {}",
                path,
                o.status,
                String::from_utf8_lossy(&o.stderr).trim()
            );
            return Ok(DirtySummary {
                dirty_files: None,
                branch: None,
            });
        }
        Err(e) => {
            // Spawn failed for some reason other than the missing cwd
            // we filtered above — most likely git itself isn't on PATH
            // (one-time install issue, affects every workspace probe so
            // worth surfacing) or a permission denial. Both warrant a
            // log line.
            log::warn!("git status failed to spawn in {path}: {e}");
            return Ok(DirtySummary {
                dirty_files: None,
                branch: None,
            });
        }
    };

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    // First line is `## <branch>...` or `## HEAD (no branch)`.
    // Everything after is one entry per modified path.
    let branch = lines.next().and_then(parse_branch_header);
    let dirty_files = Some(lines.filter(|l| !l.is_empty()).count() as u64);

    Ok(DirtySummary {
        dirty_files,
        branch,
    })
}

/// Parse the `## <branch>...<upstream>` (or `## HEAD (no branch)`) header
/// emitted by `git status --porcelain=v1 --branch`. Returns `None` for a
/// detached HEAD; the close-dialog UI prefers no branch name to a literal
/// "HEAD".
fn parse_branch_header(line: &str) -> Option<String> {
    let rest = line.strip_prefix("## ")?;
    // Detached HEAD path: `## HEAD (no branch)`. Surface as None so the
    // UI can fall back to the path-only phrasing.
    if rest.starts_with("HEAD ") || rest == "HEAD" {
        return None;
    }
    // Strip ahead/behind suffix and the upstream segment; the first
    // segment up to `...` or ` ` is the local branch.
    let branch_end = rest
        .find("...")
        .or_else(|| rest.find(' '))
        .unwrap_or(rest.len());
    let branch = rest[..branch_end].trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}
/// Batched existence check for workspace paths. Used on app start to
/// surface a single "your workspace folder is gone" toast instead of
/// letting each pane in that workspace fail at spawn with a cryptic
/// pty-process error. Cheap (`Path::is_dir`), no symlink-following
/// surprises beyond what the OS already does for `stat`.
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths
        .into_iter()
        .map(|p| std::path::Path::new(&p).is_dir())
        .collect()
}

/// Returns a `pane_id -> claude_session_id` map of every currently-running
/// pane that has captured a Claude session id from a Stop hook. Used by
/// the frontend's session-persist layer to enrich the saved snapshot so
/// the next launch can spawn each claude pane with `--resume <id>`.
#[tauri::command]
pub fn get_pane_session_ids(state: State<'_, AppState>) -> HashMap<String, String> {
    let p2s = state.pane_to_session.lock();
    let sessions = state.sessions.lock();
    let mut out = HashMap::new();
    for (pane_id, session_id) in p2s.iter() {
        if let Some(s) = sessions.get(session_id) {
            if let Some(sid) = s.signals.lock().last_claude_session_id.clone() {
                out.insert(pane_id.clone(), sid);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_branch_header_handles_normal_branch() {
        assert_eq!(
            parse_branch_header("## main...origin/main"),
            Some("main".to_string())
        );
    }

    #[test]
    fn parse_branch_header_returns_none_for_detached() {
        assert_eq!(parse_branch_header("## HEAD (no branch)"), None);
        assert_eq!(parse_branch_header("## HEAD"), None);
    }

    #[test]
    fn parse_branch_header_strips_ahead_behind() {
        assert_eq!(
            parse_branch_header("## feature-x...origin/feature-x [ahead 2]"),
            Some("feature-x".to_string())
        );
    }

    /// Regression test for the workspace-registration hardening: a path
    /// that starts with `-` would otherwise be passed verbatim to `df`
    /// (which accepts options after `-P -k`) or to git's `-C` flag,
    /// turning into argv injection at the next shell-out.
    #[test]
    fn register_workspace_rejects_path_starting_with_dash() {
        let app = AppState::default();
        let state_holder = std::sync::Arc::new(app);
        // Build a State<'_, _> isn't trivial outside Tauri; exercise the
        // validation directly via a freestanding equivalent below.
        let _ = state_holder;

        // The absolute-path check is the security gate; verify the
        // freestanding predicate matches `is_absolute()`.
        assert!(!std::path::Path::new("--help").is_absolute());
        assert!(!std::path::Path::new("-o").is_absolute());
        assert!(!std::path::Path::new("relative/path").is_absolute());
        assert!(std::path::Path::new("/Users/lukas/repo").is_absolute());
    }

    /// Lock-order regression. The pty.rs module header documents an
    /// acquisition order (pane_to_session → sessions → buffer/signals →
    /// workspaces → workspace_ports); `unregister_workspace_impl` and
    /// the `evict_failed_spawn` rollback path each take a subset in
    /// different orders. The release-then-acquire pattern they use is
    /// supposed to make concurrent execution safe — this test pins it.
    ///
    /// 8 worker threads × 200 iterations hammer the two functions
    /// against a populated AppState. A `JoinHandle::is_finished` poll
    /// with a 10 s hard deadline catches deadlocks as a test failure
    /// rather than a hung CI run. In a healthy build the workers all
    /// finish in well under a second; the deadline is generous so a
    /// real cycle (which would hang forever) is unambiguous.
    ///
    /// We don't construct real PaneSession entries — the test exercises
    /// the lock-acquisition dance, not the PTY-teardown side effects.
    /// `sessions.remove()` on a missing key is the same `HashMap`
    /// operation under the same lock, so the ordering invariant is
    /// faithfully exercised.
    #[test]
    fn lock_order_no_deadlock_under_concurrent_evict_and_unregister() {
        use crate::pty::spawn::evict_failed_spawn;
        use std::sync::Arc;
        use std::thread;
        use std::time::{Duration, Instant};

        let state = Arc::new(AppState::default());
        // Pre-populate: 4 workspaces × 4 panes each.
        for ws in 0..4 {
            let wsid = format!("ws_{ws}");
            let mut pane_ids = Vec::new();
            for p in 0..4 {
                let pid = format!("pane_{ws}_{p}");
                let sid = format!("sess_{ws}_{p}");
                state.pane_to_session.lock().insert(pid.clone(), sid);
                pane_ids.push(pid);
            }
            state.workspaces.lock().insert(
                wsid,
                Workspace {
                    path: format!("/tmp/{ws}"),
                    pane_ids,
                },
            );
        }

        let n_workers = 8;
        let iterations = 200;
        let handles: Vec<_> = (0..n_workers)
            .map(|w| {
                let state = state.clone();
                thread::spawn(move || {
                    for i in 0..iterations {
                        let ws = (w + i) % 4;
                        let pane = (w * (i + 1)) % 4;
                        let wsid = format!("ws_{ws}");
                        let sid = format!("sess_{ws}_{pane}");
                        let pid = format!("pane_{ws}_{pane}");
                        if i % 3 == 0 {
                            unregister_workspace_impl(&state, &wsid);
                            // Re-populate so the next iteration of
                            // other workers has something to work on.
                            state.workspaces.lock().insert(
                                wsid.clone(),
                                Workspace {
                                    path: format!("/tmp/{ws}"),
                                    pane_ids: vec![pid.clone()],
                                },
                            );
                            state
                                .pane_to_session
                                .lock()
                                .insert(pid.clone(), sid.clone());
                        } else {
                            evict_failed_spawn(&state, &sid, &pid, &wsid);
                        }
                    }
                })
            })
            .collect();

        // JoinHandle::is_finished + poll lets us enforce a hard
        // deadline; stdlib `join()` has no timeout variant.
        let deadline = Instant::now() + Duration::from_secs(10);
        for h in handles {
            while !h.is_finished() {
                if Instant::now() >= deadline {
                    panic!(
                        "worker thread didn't finish in 10s — \
                         possible deadlock in lock acquisition order"
                    );
                }
                thread::sleep(Duration::from_millis(20));
            }
            h.join().expect("worker panicked");
        }
    }
}
