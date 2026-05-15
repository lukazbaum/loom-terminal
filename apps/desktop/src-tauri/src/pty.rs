//! PTY hot-path: pane spawning, the per-pane reader thread, the
//! URL probe spawned from it, and every Tauri command the React
//! terminal calls — write, resize, kill, snapshot, token, read text,
//! restart.
//!
//! ## Module split
//!
//! Each concern owns its own file so the diff for any one of them
//! stays scoped:
//!
//! | File              | What lives here                                   |
//! |-------------------|---------------------------------------------------|
//! | `spawn.rs`        | Types (`PaneSession`, `PaneSignals`, payloads,    |
//! |                   | `ChildGuard`), `spawn_terminal`,                  |
//! |                   | `build_pane_command`, `evict_failed_spawn`.       |
//! | `reader.rs`       | `spawn_pane_reader_thread`, `process_chunk`,      |
//! |                   | chunk-level unit tests.                           |
//! | `probe.rs`        | `spawn_url_probe` — dev-server HEAD probe.        |
//! | `commands.rs`     | Per-pane Tauri commands (write/resize/snapshot/   |
//! |                   | text/token/restart/kill).                         |
//!
//! ## Lock acquisition order
//!
//! When more than one lock is held at the same time, acquire them in
//! this order; never in reverse:
//!
//!   1. `AppState::pane_to_session`
//!   2. `AppState::sessions`
//!   3. per-session `PaneSession::signals` / `PaneSession::buffer`
//!   4. `AppState::workspaces`
//!   5. `AppState::workspace_ports`
//!   6. `AppState::probe_in_flight`
//!
//! Sites that need maps in a different order (e.g. `kill_terminal` reads
//! `sessions` first, then `pane_to_session`) MUST drop the earlier lock
//! before taking the later one. After the release-then-acquire, re-validate
//! with the mapping-equality guard — a concurrent spawn / restart might
//! have re-mapped the pane to a different session id under React
//! StrictMode double-mount.
//!
//! Per-pane inner locks (`signals`, `buffer`) are leaves: nothing global
//! is taken while either is held. The reader thread takes both
//! (sequentially, never nested) per chunk; this is the hot path.

// Submodules are `pub` so the Tauri `generate_handler!` macro in
// `lib.rs` can resolve the helper items that `#[tauri::command]` emits
// next to each command function. The macro expects `<path>::__cmd__X`
// to live alongside `<path>::X`, which re-exports don't expose.
pub mod commands;
pub mod probe;
pub mod reader;
pub mod spawn;

// `PaneSession` is the only spawn-side type that crosses the `pty`
// boundary (referenced from `workspace_cmds::unregister_workspace_impl`'s
// drained-sessions Vec). The other spawn types stay confined — callers
// reach them via their `pty::spawn::` / `pty::reader::` paths if
// needed. `PANE_BUFFER_BYTES` likewise stays internal to the tree.
pub use spawn::PaneSession;
