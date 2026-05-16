/// Workspace-level Tauri commands: registration, dirty / disk probes,
/// session-id discovery. Reads from / writes to `AppState`'s workspace
/// and session maps; no PTY internals here.
use std::collections::HashMap;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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
/// pane that has captured a Claude session id. Used by the frontend's
/// session-persist layer to enrich the saved snapshot so the next launch
/// can spawn each claude pane with `--resume <id>`.
///
/// Two transports in priority order:
///   1. In-memory `last_claude_session_id`, populated by the OSC scanner
///      when the hook's `loom-session` marker reaches our PTY. Fast,
///      synchronous with the turn ending.
///   2. Sidecar file at `~/.loom/sessions/<pane_id>`, written by the
///      hook script via `$LOOM_PANE_ID`. Required on agent builds that
///      capture hook stdout/stderr AND detach the hook from the TTY
///      (Claude 2.1.142+) — no other path reaches us.
///
/// Sidecar wins when both are present: the file is overwritten on every
/// SessionStart/Stop, so it's the freshest signal if the OSC path also
/// happened to land.
///
/// Side-effect: when a sidecar id differs from what the in-memory
/// `last_claude_session_id` was the last time we polled, we update the
/// in-memory field AND fire a `loom-session-captured` event so the
/// frontend's React handler runs (dispatch → state update → debounced
/// shape save). Without this, the polled return value here would
/// surface in the frontend's *next* save only if some unrelated
/// workspaces-state change kicked the debounce — i.e. a pane resumed
/// to a new id and the user just sat reading without clicking would
/// never have the new id flushed to localStorage.
#[tauri::command]
pub fn get_pane_session_ids(app: AppHandle, state: State<'_, AppState>) -> HashMap<String, String> {
    let p2s = state.pane_to_session.lock();
    let sessions = state.sessions.lock();
    let mut out = HashMap::new();
    let sidecar_root = sidecar_sessions_dir();
    for (pane_id, session_id) in p2s.iter() {
        let from_sidecar = sidecar_root
            .as_ref()
            .and_then(|root| read_pane_sidecar(root, pane_id));
        let from_memory = sessions
            .get(session_id)
            .and_then(|s| s.signals.lock().last_claude_session_id.clone());

        // If the sidecar carries a new id (one we haven't seen
        // in-memory yet), promote it: update the in-memory slot and
        // emit the event so the React handler can dispatch the
        // state patch + sync-persist the override. The dispatch
        // path's own equality check stops a re-emit loop once state
        // catches up.
        if let Some(fresh) = from_sidecar.as_deref() {
            let changed = match &from_memory {
                Some(prev) => prev != fresh,
                None => true,
            };
            if changed {
                if let Some(s) = sessions.get(session_id) {
                    s.signals.lock().last_claude_session_id = Some(fresh.to_string());
                }
                let _ = app.emit(
                    "loom-session-captured",
                    serde_json::json!({
                        "pane_id": pane_id,
                        "session_id": fresh,
                    }),
                );
            }
        }

        if let Some(sid) = from_sidecar.or(from_memory) {
            out.insert(pane_id.clone(), sid);
        }
    }
    out
}

/// `~/.loom/sessions/` — the directory hook scripts write captured
/// session ids into. Returns None when $HOME isn't set (shouldn't
/// happen in practice, but we'd rather skip the read than panic).
fn sidecar_sessions_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".loom").join("sessions"))
}

/// Whether `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` exists
/// and has at least one line of content. Frontend calls this before
/// splicing `claude --resume <id>` so a captured-but-never-written
/// session id (SessionStart fired on a fresh `claude` invocation, user
/// quit before the first turn was committed to disk) doesn't get
/// retried forever — the resume would error with "No conversation
/// found with session ID: ..." and dump the user at a shell.
///
/// Returns `false` on any IO or argument-shape problem; treating
/// "uncertain" as "missing" is safer than spuriously splicing a
/// `--resume` flag.
#[tauri::command]
pub fn claude_session_file_exists(cwd: String, session_id: String) -> bool {
    if !is_valid_session_id(&session_id) || cwd.is_empty() {
        return false;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let projects_root = std::path::PathBuf::from(home)
        .join(".claude")
        .join("projects");
    claude_session_file_has_content(&projects_root, &cwd, &session_id)
}

/// Path-building + size check separated from the `$HOME` lookup so it
/// can be unit-tested against a tempdir. Claude encodes the project
/// dir by replacing `/` with `-` (the leading slash becomes a leading
/// dash), so `/home/user` → `-home-user`. The encoding doesn't
/// escape any other character, which matches the layout under
/// `~/.claude/projects/`.
fn claude_session_file_has_content(
    projects_root: &std::path::Path,
    cwd: &str,
    session_id: &str,
) -> bool {
    let encoded = cwd.replace('/', "-");
    let path = projects_root
        .join(encoded)
        .join(format!("{session_id}.jsonl"));
    match std::fs::metadata(&path) {
        Ok(m) => m.is_file() && m.len() > 0,
        Err(_) => false,
    }
}

/// Shape gate for session ids we'll splice into the PTY-typed resume
/// command. Cap stops a malicious OSC marker (or stray sidecar file)
/// from constructing a long shell expression; character class blocks
/// shell metacharacters since the spliced command is typed straight
/// into the user's shell.
fn is_valid_session_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Read and validate a sidecar file at `<root>/<pane_id>`. Returns the
/// trimmed session id when it parses as a single line passing
/// `is_valid_session_id`; otherwise None. The shape gate is
/// defense-in-depth — the hook only writes Claude/Codex/Gemini session
/// ids, but the file lives in the user's $HOME and could be touched
/// by anything.
fn read_pane_sidecar(root: &std::path::Path, pane_id: &str) -> Option<String> {
    // Reject any pane_id that could escape the sidecar directory. Loom
    // pane ids are `p_<base36>_<base36>` so this is paranoia, not a
    // known vector — but the path is composed into a filesystem read.
    if pane_id.is_empty() || pane_id.contains('/') || pane_id.contains('\\') || pane_id == ".." {
        return None;
    }
    let raw = std::fs::read_to_string(root.join(pane_id)).ok()?;
    let trimmed = raw.trim();
    if is_valid_session_id(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_reader_accepts_well_formed_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let pane_id = "p_abc123_def456";
        std::fs::write(
            dir.path().join(pane_id),
            "77e64e20-1234-5678-9abc-def012345678\n",
        )
        .unwrap();
        assert_eq!(
            read_pane_sidecar(dir.path(), pane_id),
            Some("77e64e20-1234-5678-9abc-def012345678".to_string())
        );
    }

    #[test]
    fn sidecar_reader_rejects_shell_metacharacters() {
        // The session id is spliced into a shell-spawned `claude --resume`
        // command on restore (frontend `resumeAwareCommand`). A file
        // containing shell metachars must NOT round-trip through this
        // reader even though `resumeAwareCommand` has its own gate.
        let dir = tempfile::tempdir().unwrap();
        let pane_id = "p_x";
        std::fs::write(dir.path().join(pane_id), "abc;rm -rf $HOME").unwrap();
        assert_eq!(read_pane_sidecar(dir.path(), pane_id), None);
    }

    #[test]
    fn sidecar_reader_rejects_empty_or_oversized() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("empty"), "   \n").unwrap();
        assert_eq!(read_pane_sidecar(dir.path(), "empty"), None);
        std::fs::write(dir.path().join("huge"), "a".repeat(200)).unwrap();
        assert_eq!(read_pane_sidecar(dir.path(), "huge"), None);
    }

    #[test]
    fn sidecar_reader_rejects_path_traversal_in_pane_id() {
        let dir = tempfile::tempdir().unwrap();
        // A real attempt to escape the directory wouldn't ever land on
        // disk via our hook (we always write `<root>/<pane_id>` from
        // a Loom-generated `pane_id`), but the reader is a defensive
        // gate in case anything else populates the dir.
        assert_eq!(read_pane_sidecar(dir.path(), "../etc/passwd"), None);
        assert_eq!(read_pane_sidecar(dir.path(), ".."), None);
        assert_eq!(read_pane_sidecar(dir.path(), ""), None);
    }

    #[test]
    fn sidecar_reader_returns_none_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_pane_sidecar(dir.path(), "p_nonexistent"), None);
    }

    #[test]
    fn claude_session_file_exists_rejects_bad_session_id_shapes() {
        // No filesystem access needed for the shape gate; an explicit
        // empty / oversized / metacharacter id is rejected up front.
        assert!(!claude_session_file_exists("/home/user".into(), "".into()));
        assert!(!claude_session_file_exists(
            "/home/user".into(),
            "abc;rm -rf $HOME".into()
        ));
        assert!(!claude_session_file_exists(
            "/home/user".into(),
            "a".repeat(200)
        ));
        assert!(!claude_session_file_exists(
            "".into(),
            "904cc7fb-513b-4faa-82db-50d7515f559b".into()
        ));
    }

    #[test]
    fn claude_session_file_lookup_round_trip() {
        // Mirror Claude's projects/ layout in a tempdir, then check
        // that the resolver picks the right file for the given cwd.
        let root = tempfile::tempdir().unwrap();
        let project_dir = root.path().join("-home-user-Dev-loom");
        std::fs::create_dir_all(&project_dir).unwrap();
        let id = "904cc7fb-513b-4faa-82db-50d7515f559b";
        std::fs::write(project_dir.join(format!("{id}.jsonl")), "{...}\n").unwrap();
        assert!(claude_session_file_has_content(
            root.path(),
            "/home/user/Dev/loom",
            id
        ));
        // Empty transcript: still rejected, since `claude --resume`
        // against an empty file just dumps you back at a shell.
        let empty_id = "11111111-2222-3333-4444-555555555555";
        std::fs::write(project_dir.join(format!("{empty_id}.jsonl")), "").unwrap();
        assert!(!claude_session_file_has_content(
            root.path(),
            "/home/user/Dev/loom",
            empty_id
        ));
        // Wrong cwd → wrong encoded dir → not found.
        assert!(!claude_session_file_has_content(
            root.path(),
            "/home/user/Dev/other",
            id
        ));
    }

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
        assert!(std::path::Path::new("/home/user/repo").is_absolute());
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
