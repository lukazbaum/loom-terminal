//! Pane spawn path: types, shell-command construction, the
//! `spawn_terminal` Tauri command, and the rollback helper shared with
//! the restart path.
//!
//! State inserted here lives in `AppState::sessions`, `pane_to_session`,
//! and `workspaces.pane_ids`. If the reader-thread spawn fails after
//! these inserts land, `evict_failed_spawn` is the single canonical
//! teardown — both this file and `commands::restart_pane_session` call
//! it.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::pty_buffer::RingBuffer;
use crate::{AppState, Workspace};

/// Ring-buffer cap (bytes) per pane. 4 MiB lets a chatty TUI run for
/// minutes before scrollback wraps; 16 panes × 4 MiB = 64 MiB ceiling.
pub const PANE_BUFFER_BYTES: usize = 4 * 1024 * 1024;

/// Wraps a PTY child so that *any* drop path — explicit cleanup, panic
/// unwind, HashMap eviction during shutdown — sends a SIGKILL. Without
/// this, a session removed from the map without an explicit `.kill()`
/// leaks the underlying process until the parent exits and the OS reaps
/// it via SIGCHLD. We don't `.wait()` here because the kernel will reap
/// the zombie once we exit; blocking on shutdown of every session in
/// series would be slow when many panes close at once.
pub struct ChildGuard(Box<dyn Child + Send + Sync>);

impl ChildGuard {
    pub fn new(c: Box<dyn Child + Send + Sync>) -> Self {
        Self(c)
    }

    pub fn kill(&mut self) -> std::io::Result<()> {
        self.0.kill()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

pub struct PaneSession {
    pub pane_id: String,
    pub workspace_id: String,
    pub command: Option<String>,
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: ChildGuard,
    pub buffer: Arc<Mutex<RingBuffer>>,
    pub signals: Arc<Mutex<PaneSignals>>,
    /// Set by kill/restart so the reader thread exits at the top of its
    /// loop instead of waiting for EOF — releases the RingBuffer Arc
    /// immediately and avoids piling up stale per-pane buffers when a
    /// pane is restarted in quick succession.
    pub shutdown: Arc<AtomicBool>,
    /// Per-pane output channel. The reader thread sends bytes here
    /// instead of via `app_handle.emit("terminal-output", ...)` — that
    /// global event was visited by every TerminalView's listener and
    /// produced O(N²) listener fanout at scale (caused the 16-pane
    /// close-cascade lag).
    pub output_channel: Channel<OutputPayload>,
    pub exit_channel: Channel<ExitPayload>,
}

/// Hot-path signals updated by the per-pane reader thread. Folded into
/// one struct behind one Mutex so the reader takes one lock per chunk.
pub struct PaneSignals {
    pub last_output_at: Instant,
    /// Most recent Claude Code session id observed from the OSC 9
    /// `loom-session` marker (the basename of the transcript_path the
    /// Stop hook receives on stdin). Used by session persistence so the
    /// next app launch can spawn this pane as `claude --resume <id>`.
    /// Same id across all turns of a session — last write wins.
    pub last_claude_session_id: Option<String>,
}

impl PaneSignals {
    pub fn new() -> Self {
        Self {
            last_output_at: Instant::now(),
            last_claude_session_id: None,
        }
    }
}

impl Default for PaneSignals {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
pub struct OutputPayload {
    pub id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct ExitPayload {
    pub id: String,
}

#[derive(Clone, serde::Serialize)]
pub struct PaneSnapshot {
    /// Bytes that arrived between `since_token` and the current cursor,
    /// base64-encoded so they survive the JSON IPC. Empty when the
    /// caller is already up to date.
    pub data: String,
    /// New cursor — pass back as the next `since_token` to keep an
    /// incremental stream going.
    pub new_token: u64,
    /// True when `since_token` was older than the oldest byte still in
    /// the ring buffer — `data` is the full current window so the
    /// caller can resync, but bytes between then and now were lost.
    pub dropped: bool,
}

/// Build the shell `CommandBuilder` used by both `spawn_terminal` and the
/// restart path. Layers env in the same order so an in-place restart sees
/// the same shell environment the original spawn did: inherited TERM
/// (falling back to xterm-256color), HOME, and PATH first, then any
/// caller-supplied overrides applied last so they win.
pub(crate) fn build_pane_command(
    cwd: &str,
    pane_id: &str,
    env: Option<&HashMap<String, String>>,
) -> Result<CommandBuilder, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.cwd(cwd);
    if let Ok(term) = std::env::var("TERM") {
        cmd.env("TERM", term);
    } else {
        cmd.env("TERM", "xterm-256color");
    }
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }
    if let Ok(p) = std::env::var("PATH") {
        cmd.env("PATH", p);
    }
    // Expose the pane id so descendant processes — specifically the
    // agent's Stop/SessionStart hooks — can drop the captured session
    // id into a per-pane sidecar at `~/.loom/sessions/<pane_id>`. The
    // OSC-9 marker path through the PTY is unreliable when newer agent
    // builds (e.g. Claude 2.1.142+) detach hooks from the controlling
    // terminal AND capture stdout/stderr — the sidecar file is the
    // only TTY-independent transport we have. See `loom-stop-hook.sh`.
    cmd.env("LOOM_PANE_ID", pane_id);
    if let Some(env_map) = env {
        crate::validate_env_map(env_map)?;
        for (k, v) in env_map {
            cmd.env(k, v);
        }
    }
    Ok(cmd)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    workspace_id: String,
    path: String,
    command: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
    on_output: Channel<OutputPayload>,
    on_exit: Channel<ExitPayload>,
) -> Result<String, String> {
    super::commands::validate_pty_size(cols, rows)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let effective_cwd = cwd.as_deref().unwrap_or(&path);
    let cmd = build_pane_command(effective_cwd, &pane_id, env.as_ref())?;

    let child = ChildGuard::new(
        pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?,
    );

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader failed: {e}"))?;

    let buffer = Arc::new(Mutex::new(RingBuffer::new(PANE_BUFFER_BYTES)));
    let signals = Arc::new(Mutex::new(PaneSignals::new()));
    let shutdown = Arc::new(AtomicBool::new(false));

    let session_id = uuid::Uuid::new_v4().to_string();

    {
        let mut map = state.sessions.lock();
        map.insert(
            session_id.clone(),
            PaneSession {
                pane_id: pane_id.clone(),
                workspace_id: workspace_id.clone(),
                command,
                writer,
                master: pair.master,
                child,
                buffer: buffer.clone(),
                signals: signals.clone(),
                shutdown: shutdown.clone(),
                output_channel: on_output.clone(),
                exit_channel: on_exit.clone(),
            },
        );
    }
    {
        let mut p2s = state.pane_to_session.lock();
        p2s.insert(pane_id.clone(), session_id.clone());
    }
    {
        let mut wmap = state.workspaces.lock();
        let ws = wmap.entry(workspace_id.clone()).or_insert(Workspace {
            path: path.clone(),
            pane_ids: Vec::new(),
        });
        if !ws.pane_ids.contains(&pane_id) {
            ws.pane_ids.push(pane_id.clone());
        }
    }

    if let Err(e) = super::reader::spawn_pane_reader_thread(
        app,
        session_id.clone(),
        pane_id.clone(),
        workspace_id.clone(),
        reader,
        buffer,
        signals,
        shutdown,
        on_output,
        on_exit,
    ) {
        evict_failed_spawn(&state, &session_id, &pane_id, &workspace_id);
        return Err(e);
    }

    Ok(session_id)
}

/// Remove every map entry for a freshly-failed pane spawn. Called from
/// both rollback paths (the inline `spawn_terminal` thread-spawn failure
/// and the `restart_pane` reader-thread failure) — they each insert into
/// `sessions`, `pane_to_session`, and `workspaces.pane_ids` BEFORE
/// spawning the reader, so if the reader spawn fails the maps end up
/// referencing a child whose output nobody will ever consume. Removing
/// the `PaneSession` entry drops its `ChildGuard`, which SIGKILLs the
/// otherwise-orphaned child PTY.
///
/// Three separate locked blocks, never two concurrently — matches the
/// release-then-acquire pattern documented in the module header. The
/// `pane_to_session` mapping-equality guard prevents a StrictMode
/// double-mount from evicting the *new* mapping if the failing pane was
/// raced by a fresh re-spawn under the same `pane_id`.
///
/// Ports cleanup is intentionally absent: the failing pane hasn't yet
/// run any URL detection — its reader thread never spawned — so there
/// can't be a port entry attributable to this `pane_id`. The full
/// `kill_terminal` path is what clears port state for live panes.
pub(crate) fn evict_failed_spawn(
    state: &AppState,
    session_id: &str,
    pane_id: &str,
    workspace_id: &str,
) {
    {
        let mut sessions = state.sessions.lock();
        sessions.remove(session_id);
    }
    {
        let mut p2s = state.pane_to_session.lock();
        if p2s.get(pane_id).map(std::string::String::as_str) == Some(session_id) {
            p2s.remove(pane_id);
        }
    }
    {
        let mut wmap = state.workspaces.lock();
        if let Some(ws) = wmap.get_mut(workspace_id) {
            ws.pane_ids.retain(|p| p != pane_id);
        }
    }
}

#[cfg(all(test, unix))]
mod child_guard_tests {
    //! Verifies the `ChildGuard::Drop` SIGKILL backstop actually
    //! delivers. The Drop impl is the safety net that catches every
    //! pane-eviction path that forgets to call `.kill()` explicitly —
    //! if it ever silently no-ops, killed panes leak as runaway
    //! processes until the parent exits and the kernel reaps via
    //! SIGCHLD. Unix-only because `kill(pid, 0)` / ESRCH are POSIX;
    //! Windows uses a different mechanism (`TerminateProcess`) we'd
    //! probe differently.
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::time::{Duration, Instant};

    /// Send signal 0 to `pid` — no-op signal that just probes whether
    /// the process exists. Returns true while it does, false once it's
    /// gone (errno == ESRCH).
    fn pid_alive(pid: i32) -> bool {
        // SAFETY: `kill(pid, 0)` is signal-handler-safe and has no
        // ownership concerns. We only read errno via the libc API.
        let rc = unsafe { libc::kill(pid, 0) };
        if rc == 0 {
            return true;
        }
        // Look at errno to disambiguate "process gone" (ESRCH) from
        // "permission denied" (EPERM). We spawned the process
        // ourselves so EPERM shouldn't happen, but the assertion
        // becomes "process is in fact gone" not "syscall returned
        // non-zero for any reason".
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[test]
    fn dropping_child_guard_kills_the_child() {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        // `sleep 30` is the simplest long-lived child that won't exit
        // on its own during the test. Using `/bin/sleep` directly
        // avoids any shell-startup variability that would race the
        // pid_alive probe.
        let mut cmd = CommandBuilder::new("/bin/sleep");
        cmd.arg("30");
        let child = pty.slave.spawn_command(cmd).expect("spawn sleep");
        let pid = child.process_id().expect("process_id") as i32;

        // Sanity: it's alive immediately after spawn.
        assert!(pid_alive(pid), "child should be alive right after spawn");

        let guard = ChildGuard::new(child);
        drop(guard);

        // SIGKILL is delivered synchronously but reaping is async — the
        // kernel marks the process terminated and our `kill(pid, 0)`
        // can briefly still return success while the zombie waits to
        // be reaped. Poll for up to 500 ms; in practice it's gone
        // within a few ms.
        let deadline = Instant::now() + Duration::from_millis(500);
        let mut gone = false;
        while Instant::now() < deadline {
            if !pid_alive(pid) {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            gone,
            "child pid {pid} still alive 500 ms after ChildGuard drop",
        );
    }
}

#[cfg(test)]
mod evict_failed_spawn_tests {
    //! Tests for the spawn-rollback teardown helper. We deliberately do
    //! NOT construct a real `PaneSession` here — its fields require a
    //! live PTY, writer, channel, etc., which would turn unit tests
    //! into integration tests. The `sessions.remove(session_id)` call
    //! is a single `HashMap::remove` and has no logic worth testing in
    //! isolation; the *interesting* behavior is the mapping-equality
    //! guard on `pane_to_session` and the `pane_ids` retain.
    use super::*;

    #[test]
    fn removes_pane_to_session_and_workspace_entry() {
        let state = AppState::default();
        state
            .pane_to_session
            .lock()
            .insert("pane_a".into(), "sess_a".into());
        state.workspaces.lock().insert(
            "ws_a".into(),
            Workspace {
                path: "/tmp/x".into(),
                // Sibling pane retained to prove `retain` is specific.
                pane_ids: vec!["pane_a".into(), "pane_b".into()],
            },
        );

        evict_failed_spawn(&state, "sess_a", "pane_a", "ws_a");

        assert!(
            !state.pane_to_session.lock().contains_key("pane_a"),
            "pane_to_session should have dropped the failed pane"
        );
        let wmap = state.workspaces.lock();
        let ws = wmap.get("ws_a").expect("workspace still present");
        assert_eq!(
            ws.pane_ids,
            vec!["pane_b".to_string()],
            "only the failed pane should be removed from pane_ids"
        );
    }

    #[test]
    fn preserves_remapped_pane_to_session_under_strictmode_remount() {
        // React StrictMode double-mounts spawn_terminal: the first mount
        // fails after the maps were populated; meanwhile a second mount
        // has already replaced pane_a → sess_b. The rollback must NOT
        // evict the *new* mapping or the live pane goes missing.
        let state = AppState::default();
        state
            .pane_to_session
            .lock()
            .insert("pane_a".into(), "sess_b".into());

        evict_failed_spawn(&state, "sess_a", "pane_a", "ws_a");

        let p2s = state.pane_to_session.lock();
        assert_eq!(
            p2s.get("pane_a"),
            Some(&"sess_b".to_string()),
            "pane_a → sess_b (the newer mapping) must survive"
        );
    }

    #[test]
    fn no_panic_when_workspace_is_missing() {
        // workspace_id may be one that was never inserted (the spawn
        // failed before the workspaces.entry() ran, or a concurrent
        // unregister_workspace removed it). Eviction must be a clean
        // no-op rather than panicking.
        let state = AppState::default();
        evict_failed_spawn(&state, "sess_a", "pane_a", "ws_nonexistent");
        assert!(state.workspaces.lock().is_empty());
        assert!(state.pane_to_session.lock().is_empty());
    }

    #[test]
    fn no_panic_when_pane_id_absent_from_workspace_pane_list() {
        // The pane_ids vec may not contain the failed pane (e.g. it was
        // never inserted because the entry() created a fresh workspace
        // and then the next push was raced). `retain` on a missing
        // value is a no-op; assert that explicitly.
        let state = AppState::default();
        state.workspaces.lock().insert(
            "ws_a".into(),
            Workspace {
                path: "/tmp/x".into(),
                pane_ids: vec!["pane_b".into()],
            },
        );
        evict_failed_spawn(&state, "sess_a", "pane_a", "ws_a");
        let wmap = state.workspaces.lock();
        assert_eq!(
            wmap.get("ws_a").unwrap().pane_ids,
            vec!["pane_b".to_string()]
        );
    }
}
