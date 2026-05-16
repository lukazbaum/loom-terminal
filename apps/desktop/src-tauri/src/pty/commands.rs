//! Tauri commands that operate on existing panes: write/resize/snapshot
//! /text/token, plus the restart and kill paths. Spawn-side logic lives
//! in `super::spawn` so the read/write surface and the create/destroy
//! surface stay in independently-reviewable files.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, PtySize};
use tauri::{AppHandle, State};

use crate::pty_buffer::RingBuffer;
use crate::AppState;

use super::spawn::{
    build_pane_command, evict_failed_spawn, ChildGuard, PaneSession, PaneSignals, PaneSnapshot,
    PANE_BUFFER_BYTES,
};

#[tauri::command]
pub fn write_terminal(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock();
    let session = map
        .get_mut(&id)
        .ok_or_else(|| format!("Unknown terminal: {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Reject obviously bogus PTY dimensions at the IPC boundary. The
/// renderer already filters `<1` before invoking, but the Tauri
/// command surface is reachable from any code in the WebView; a
/// 0×0 resize crashes some TUIs (TIOCSWINSZ with ws_row=0 is legal
/// at the kernel level, applications are not) and absurdly large
/// dimensions can OOM apps that allocate per-cell scrollback.
const MIN_PTY_DIM: u16 = 1;
const MAX_PTY_DIM: u16 = 2000;

pub(crate) fn validate_pty_size(cols: u16, rows: u16) -> Result<(), String> {
    if cols < MIN_PTY_DIM || rows < MIN_PTY_DIM || cols > MAX_PTY_DIM || rows > MAX_PTY_DIM {
        return Err(format!(
            "invalid pty size {cols}x{rows} (allowed {MIN_PTY_DIM}..={MAX_PTY_DIM})"
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    validate_pty_size(cols, rows)?;
    let map = state.sessions.lock();
    let session = map
        .get(&id)
        .ok_or_else(|| format!("Unknown terminal: {id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

/// Returns bytes pushed to the pane's ring buffer since `since_token`.
/// Used by TerminalView's pause/resume path: when a workspace is
/// hidden we stop writing chunks to xterm; on resume we ask the
/// backend for everything we missed and write it in one go.
#[tauri::command]
pub fn snapshot_pane_since(
    state: State<'_, AppState>,
    id: String,
    since_token: u64,
) -> Result<PaneSnapshot, String> {
    let map = state.sessions.lock();
    let session = map
        .get(&id)
        .ok_or_else(|| format!("Unknown terminal: {id}"))?;
    // Snapshot under the buffer lock, then drop both locks before the
    // base64 encode so the reader thread isn't blocked during it.
    let slice = session.buffer.lock().snapshot_since(since_token);
    drop(map);
    Ok(PaneSnapshot {
        data: B64.encode(&slice.bytes),
        new_token: slice.new_token,
        dropped: slice.dropped,
    })
}

/// Returns the pane's currently-buffered scrollback as plain UTF-8 text
/// (lossily decoded). Used by the "copy output" button in the pane
/// header — much faster than asking xterm to dump its window. Capped at
/// the ring buffer size (`PANE_BUFFER_BYTES`) by construction.
#[tauri::command]
pub fn read_pane_text(state: State<'_, AppState>, pane_id: String) -> Result<String, String> {
    let session_id = state
        .pane_to_session
        .lock()
        .get(&pane_id)
        .cloned()
        .ok_or_else(|| format!("pane not registered: {pane_id}"))?;
    let map = state.sessions.lock();
    let session = map
        .get(&session_id)
        .ok_or_else(|| format!("pane not running: {pane_id}"))?;
    let bytes = session.buffer.lock().snapshot();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Cheap "what's the current cursor?" — used at pause time so the next
/// resume can call snapshot_pane_since with this value.
#[tauri::command]
pub fn pane_token(state: State<'_, AppState>, id: String) -> Result<u64, String> {
    let map = state.sessions.lock();
    let session = map
        .get(&id)
        .ok_or_else(|| format!("Unknown terminal: {id}"))?;
    let token = session.buffer.lock().total_pushed();
    Ok(token)
}

/// Respawns the child for an existing pane in place: same `pane_id`, same
/// `session_id`, same React-side terminal — just a fresh PTY and process.
/// The React xterm sees a brief "[process exited]" then continues with the
/// new banner; existing pane_id references stay valid.
pub(crate) fn restart_pane_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    pane_id: &str,
) -> Result<(), String> {
    let session_id = state
        .pane_to_session
        .lock()
        .get(pane_id)
        .cloned()
        .ok_or_else(|| format!("pane not registered: {pane_id}"))?;

    let (workspace_id, command, size) = {
        let sessions = state.sessions.lock();
        let s = sessions
            .get(&session_id)
            .ok_or_else(|| format!("pane not running: {pane_id}"))?;
        let size = s
            .master
            .get_size()
            .map_err(|e| format!("get pty size: {e}"))?;
        (s.workspace_id.clone(), s.command.clone(), size)
    };

    let workspace_path = state
        .workspaces
        .lock()
        .get(&workspace_id)
        .ok_or_else(|| format!("unknown workspace: {workspace_id}"))?
        .path
        .clone();

    // Build the new PTY (mirrors spawn_terminal's setup).
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("openpty: {e}"))?;
    let cmd_builder = build_pane_command(&workspace_path, pane_id, None)?;

    let new_child = ChildGuard::new(
        pair.slave
            .spawn_command(cmd_builder)
            .map_err(|e| format!("spawn: {e}"))?,
    );
    let new_writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let new_reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;

    let new_buffer = Arc::new(Mutex::new(RingBuffer::new(PANE_BUFFER_BYTES)));
    let new_signals = Arc::new(Mutex::new(PaneSignals::new()));
    let new_shutdown = Arc::new(AtomicBool::new(false));

    // Atomically swap session contents. Flipping the previous shutdown
    // flag tells the old reader to exit at the top of its next loop —
    // releases the old RingBuffer Arc immediately instead of waiting
    // for EOF (which on rapid restarts piled up stale per-pane buffers).
    //
    // `mem::replace` on `s.child` is load-bearing: a plain `s.child =
    // new_child` drops the old `ChildGuard` *inside* the locked critical
    // section, which means its Drop-side SIGKILL syscall runs while
    // every other pane operation is serialized behind us. SIGKILL is
    // fast on macOS today but cross-platform child teardown isn't free.
    // Extracting it out lets the old guard drop after the lock is
    // released, at the end of this block.
    let (output_channel, exit_channel, _old_child) = {
        let mut sessions = state.sessions.lock();
        let s = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("pane gone: {pane_id}"))?;
        s.shutdown.store(true, Ordering::Relaxed);
        let _ = s.child.kill();
        s.writer = new_writer;
        s.master = pair.master;
        let old_child = std::mem::replace(&mut s.child, new_child);
        s.buffer = new_buffer.clone();
        s.signals = new_signals.clone();
        s.shutdown = new_shutdown.clone();
        (s.output_channel.clone(), s.exit_channel.clone(), old_child)
    };
    // `_old_child` drops here, outside the sessions lock. Its Drop sends
    // SIGKILL — a no-op since we already killed it above, but the
    // backstop matters if a future refactor drops the proactive kill.

    // Reuse the same session_id so React's existing channel handlers
    // continue receiving bytes from the restarted shell.
    if let Err(e) = super::reader::spawn_pane_reader_thread(
        app.clone(),
        session_id.clone(),
        pane_id.to_string(),
        workspace_id.clone(),
        new_reader,
        new_buffer,
        new_signals,
        new_shutdown,
        output_channel,
        exit_channel,
    ) {
        // No reader means no output ever reaches React. The old child
        // is already dead so we can't un-restart. Evict the session
        // entirely — the frontend's exit-channel handler will see the
        // teardown and the user can close+reopen the pane. SIGKILL on
        // the new child rides along via ChildGuard's Drop.
        evict_failed_spawn(state, &session_id, pane_id, &workspace_id);
        return Err(e);
    }

    // Re-run the original startup command. Tiny pause so the shell has time
    // to come up and consume input as a real keypress instead of a paste.
    if let Some(c) = command.filter(|s| !s.trim().is_empty()) {
        thread::sleep(crate::constants::RESTART_COMMAND_DELAY);
        let mut sessions = state.sessions.lock();
        let s = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("pane gone: {pane_id}"))?;
        s.writer
            .write_all(c.as_bytes())
            .map_err(|e| format!("write cmd: {e}"))?;
        s.writer
            .write_all(b"\r")
            .map_err(|e| format!("write enter: {e}"))?;
        s.writer.flush().map_err(|e| format!("flush: {e}"))?;
    }

    Ok(())
}

/// Restart the pane in place. Used by the ⌘R keyboard shortcut so the user
/// can recycle a stuck dev server / agent.
#[tauri::command]
pub fn restart_pane(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<(), String> {
    restart_pane_session(&app, &state, &pane_id)
}

#[tauri::command]
pub fn kill_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Take the session out of the global map while we hold the lock,
    // then release every other lock acquisition. The expensive bit —
    // ChildGuard's Drop SIGKILL + PTY fd close — happens at the end of
    // this function when `_session` falls out of scope, so it doesn't
    // serialize spawns for surviving panes.
    let mut session: Option<PaneSession> = None;
    let session_id = id.clone();
    {
        let mut map = state.sessions.lock();
        if let Some(mut s) = map.remove(&session_id) {
            // Tell the reader thread to bail so its RingBuffer Arc drops
            // immediately instead of waiting for EOF.
            s.shutdown.store(true, Ordering::Relaxed);
            let _ = s.child.kill();
            session = Some(s);
        }
    }
    if let Some(s) = session.as_ref() {
        let workspace_id = s.workspace_id.clone();
        let pane_id = s.pane_id.clone();
        // Only drop the pane->session mapping if it still points at *this*
        // session. If a remount has already replaced it (StrictMode), leave
        // the newer mapping intact.
        let still_owns = {
            let mut p2s = state.pane_to_session.lock();
            if p2s.get(&pane_id).map(std::string::String::as_str) == Some(&session_id) {
                p2s.remove(&pane_id);
                true
            } else {
                false
            }
        };
        if still_owns {
            {
                let mut wmap = state.workspaces.lock();
                if let Some(ws) = wmap.get_mut(&workspace_id) {
                    ws.pane_ids.retain(|p| p != &pane_id);
                }
            }
            // Drop any detected ports that came from this pane.
            let mut ports_map = state.workspace_ports.lock();
            if let Some(ports) = ports_map.get_mut(&workspace_id) {
                ports.retain(|p| p.pane_id != pane_id);
            }
        }
    }
    // `session` drops here — ChildGuard SIGKILL runs outside every map
    // lock.
    drop(session);
    Ok(())
}
