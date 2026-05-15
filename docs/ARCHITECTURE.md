# Loom architecture

A practical map of the moving parts. The README has the user-facing
"what is this" pitch; this file is for contributors who want to know
where to put the next change.

## Process model

Loom is a single OS process — the Tauri runtime — with one webview
(React 19, the chrome) and a small Rust core that owns every PTY and
every long-lived background worker. There is no daemon, no IPC outside
Tauri's `invoke` / `Channel` / `emit`, and no telemetry.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Tauri process                                                        │
│                                                                      │
│   ┌────────────┐                                                     │
│   │ React 19   │  ───invoke──▶  ┌────────────────────────────────┐   │
│   │ webview    │ ◀──Channel──   │ Rust commands (apps/desktop/   │   │
│   │ (src/)     │ ◀──emit─────   │   src-tauri/src/)              │   │
│   └────────────┘                └─┬──────────────┬───────────┬──┘   │
│                                   │              │           │      │
│                          ┌────────▼─────┐ ┌──────▼────┐ ┌────▼───┐  │
│                          │ PTY reader   │ │ Usage     │ │ URL    │  │
│                          │ thread per   │ │ poller    │ │ probe  │  │
│                          │ pane         │ │ (claude   │ │ thread │  │
│                          │              │ │  /usage)  │ │ (ureq) │  │
│                          └──────────────┘ └───────────┘ └────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

Worker threads are spawned with `thread::Builder` (named, bounded stack
size) and report back to the frontend over per-pane `tauri::ipc::Channel`s
or app-wide `emit` events. The PTY itself comes from
[`portable-pty`](https://docs.rs/portable-pty); we don't shell out to
`script`/`unbuffer`/etc.

## Module layout (Rust)

`apps/desktop/src-tauri/src/`

| File | Responsibility |
|---|---|
| `lib.rs` | Tauri builder, `AppState`, panic hook, command registry, process-wide shutdown flag |
| `main.rs` | Cargo binary entrypoint — just calls `loom_lib::run()` |
| `pty.rs` | Module trampoline + module-header lock-order doc; submodules carry the actual code |
| `pty/spawn.rs` | Types (`PaneSession`, `PaneSignals`, `ChildGuard`, payloads), `spawn_terminal`, `build_pane_command`, `evict_failed_spawn` rollback helper |
| `pty/reader.rs` | Per-pane reader thread, `process_chunk` pure function, chunk-level tests |
| `pty/probe.rs` | `spawn_url_probe` — HEAD-checks a detected dev-server URL via `ureq` |
| `pty/commands.rs` | Tauri commands the React terminal calls (write/resize/snapshot/token/read_text/restart/kill) |
| `pty_buffer.rs` | `RingBuffer` (per-pane scrollback) + `OscScanner` (backend `loom-session` marker detection) |
| `port_detect.rs` | `UrlDetector` over PTY output → registers detected dev-server URLs; in-process `ureq` HEAD probe |
| `ansi.rs` | Shared CSI/OSC byte stripper used by both `port_detect` and `usage_poller` |
| `usage_poller.rs` | Background thread that spawns claude in a hidden PTY, types `/usage`, parses the rendered modal |
| `rate_limits.rs` | In-memory + on-disk cache of the parsed 5h / 7d windows |
| `hook_common.rs` | Shared installer for the three per-agent hooks (`HookSpec`, `install_loom_hook`) |
| `hook.rs` / `hook_codex.rs` / `hook_gemini.rs` | Thin wrappers supplying each agent's `HookSpec` |
| `hook_consent.rs` | First-run consent gate per agent (Claude / Codex / Gemini) |
| `workspace_cmds.rs` | Workspace-level commands (register, dirty summary, disk space, etc.) |
| `port_cmds.rs` | Frontend wrappers for the detected-ports list |
| `attach.rs` | "Drag a file into the chat" — bounded file read with type checks |
| `shell_env.rs` | Resolves the user's claude binary path through known install locations |
| `env_validate.rs` | Validates per-pane env-var overrides (POSIX names, no NUL / newline values) |
| `atomic_write.rs` | Write-then-rename helper used by every config-file mutator |
| `constants.rs` | Shared timing / size constants + the process-wide `SHUTTING_DOWN` flag |

## IPC contracts

Commands are registered in `lib.rs`'s `invoke_handler!`. The hot ones:

- `spawn_terminal` — opens a PTY, registers the session, spawns a reader
  thread. Returns a session id; bytes flow back via the per-call
  `Channel<OutputPayload>` instead of a global `emit` (early versions
  used `emit("terminal-output", …)` and produced O(N²) listener fanout
  at 16+ panes).
- `write_terminal` / `resize_terminal` — straight pipe to the PTY master.
- `snapshot_pane_since(id, since_token)` — pause/resume path. When a
  workspace tab goes hidden, the frontend stops writing chunks to xterm
  and remembers the latest cursor. On resume it asks for everything
  that streamed during the pause and writes it in one go.
- `restart_pane(pane_id)` — swaps the child PTY in place. The
  `session_id` is reused so the React-side channel handlers stay valid.
- `kill_terminal(id)` — drops the entry from `sessions`; `ChildGuard::Drop`
  SIGKILLs the process.

Backend → frontend events (via `emit`):

- `loom-session-captured` — emitted by the reader thread when it sees a
  new `loom-session` OSC marker. Frontend persists synchronously so a
  crash between marker and the debounced shape save doesn't lose the
  resume id.
- `workspace-port-detected` — emitted by the URL probe after a HEAD on
  a detected URL returns 2xx/3xx.
- `loom-hook-upgraded` / `loom-hook-failed` — fired from the
  consent-gated hook installer at startup.
- `loom-rate-limits-changed` — fired by `rate_limits::update_from_poll`.

## State + lock map

All mutable global state lives behind `parking_lot::Mutex` (non-poisoning,
faster than `std::sync::Mutex` on the contended PTY path):

```
AppState {
  sessions:        Mutex<HashMap<session_id, PaneSession>>
  pane_to_session: Mutex<HashMap<pane_id,    session_id>>
  workspaces:      Mutex<HashMap<workspace_id, Workspace>>
  workspace_ports: Mutex<HashMap<workspace_id, Vec<WorkspacePort>>>
  probe_in_flight: Mutex<HashSet<(workspace_id, url)>>
  rate_limits:     RateLimitsInner
}

PaneSession {
  buffer:  Arc<Mutex<RingBuffer>>     // per-pane scrollback (4 MiB)
  signals: Arc<Mutex<PaneSignals>>    // last_output_at, last_claude_session_id
  shutdown: Arc<AtomicBool>           // flipped by kill/restart so the reader bails
}
```

Lock acquisition order (when more than one is held at the same time —
**never** in reverse):

1. `pane_to_session`
2. `sessions`
3. per-session `signals` / `buffer`
4. `workspaces`
5. `workspace_ports`
6. `probe_in_flight`

The full discussion lives at the top of `pty.rs`. Sites that take maps
in a different order (notably `kill_terminal`: `sessions` first, then
`pane_to_session`) **release the first lock before acquiring the second**
and re-validate with a mapping-equality guard — React's StrictMode
double-mount can otherwise interleave with a fresh spawn and clobber
the wrong entry.

Per-session inner locks (`buffer`, `signals`) are leaves: nothing global
is held while either is taken. The reader thread takes both sequentially
per chunk; this is the hot path.

## Frontend layout

`apps/desktop/src/`

Shell (composition + routing):
- `App.tsx` (~930 lines) — top-level orchestrator: workspace state via
  `useWorkspacesStore` (reducer), session persistence via
  `useSessionPersistence`, keyboard shortcuts via `useAppShortcuts`,
  undo/redo via `useLayoutHistory`, plus the global event listeners.
- `AppHeader.tsx` — titlebar + hook-upgraded banner + port-detected toast.
- `Sidebar.tsx` — left rail (workspace tabs + drag-reorder + collapse).
- `MainPanes.tsx` — workspace switcher + lazy `Welcome` + Settings /
  ThemeEditor overlays.

Pane-level:
- `Workspace.tsx` + `WorkspaceTab.tsx` — workspace grid + tab.
- `TerminalView.tsx` — xterm.js wrapper, the per-pane terminal. Its
  600-line mount effect is split into colocated helpers
  (`setupWebgl`, `setupCompletionSignals`, `wireOutputChannel`,
  `wirePauseResume`, `wireResizeAndFit`) sharing a `TermState` bag.
- `WebPreviewPane.tsx` — iframe wrapper for detected dev-server URLs.
- `PaneContextMenu.tsx` — right-click menu with WAI-ARIA keyboard nav.

Dialogs / modal chrome:
- `Modal.tsx` — backdrop + ESC + focus trap + focus restore atom.
- `ConfirmDialog.tsx`, `ConfirmCloseModal.tsx`, `KeyboardHelpOverlay.tsx`,
  `PortsPanel.tsx`, `AddShellsPrompt.tsx`, `ThemeEditor.tsx` — all use
  `<Modal>` (or `useFocusTrap` directly for the floating prompt).
- `SecondaryButton.tsx` — shared bordered-uppercase-mono button atom.
- `ErrorBoundary.tsx` — wraps each `Workspace` and `Welcome` individually
  so one crash doesn't take down the whole window.

Welcome flow:
- `Welcome.tsx` + `welcome/*.tsx` — new-workspace setup view (composer,
  presets rail, per-agent hook consent cards).

State + persistence:
- `useWorkspacesStore.ts` — `useReducer` over the workspaces array;
  12 actions covering every shape mutation.
- `useSessionPersistence.ts` — three debounced effects + `beforeunload`.
- `useLayoutHistory.ts` — snapshot-based undo/redo of the workspaces shape.
- `useAppShortcuts.ts` — capture-phase + bubble-phase keydown listeners.
- `useTauriEvent.ts` — race-safe `listen() → unlisten` helper.
- `useClaudeRateLimits.ts` — wires the rate-limit badge.
- `sessionPersist.ts` — localStorage schema + back-compat reader (still
  reads the legacy `claudeSessionId` key; new writes use `sessionId`).
- `presets.ts`, `recentCommands.ts`, `settings.ts`, `agents.ts`,
  `shortcuts.ts`, `format.ts`, `toast.tsx`, `terminalPool.ts`,
  `useModalFocus.ts`.

Theming:
- `themes.ts` / `ThemeEditor.tsx` / `ThemeChip.tsx` — theme registry,
  editor with import/delete, color picker chip.

Tests:
- `sessionPersist.test.ts` — bun's built-in runner; 30 tests over
  `parsePersistedPane` / `loadSession` / `resumeAwareCommand` /
  `isSessionAgent`.

## Hook flow (per agent)

```
Loom app start
  │
  ▼
hook_consent::migrate_implicit_consent()      ◀── scans for any pre-existing
  │                                                Loom marker so legacy
  ▼                                                opted-in users aren't re-asked
for each agent that consent == Enabled:
  │
  ▼
hook_common::install_loom_hook(HookSpec) ─────▶  ~/.claude/settings.json
                                                  ~/.codex/hooks.json
                                                  ~/.gemini/settings.json
                                                  + bundled stop hook script
  │
  ▼
Hook fires on every Stop / SessionStart turn
  │
  ▼
Emits OSC-9 markers ── loom-session;<uuid>     ┐  Captured by OscScanner
                  ── loom-stop                 ┘  (backend reader thread)
                                                  for session id;
                                                  loom-stop is read by
                                                  xterm.js's OSC handler
                                                  on the frontend.
```

`HookSchema::Nested` covers Claude / Codex (`{matcher, hooks: [{type,
command}]}`). `HookSchema::Flat` covers Gemini (`{type, command}` directly).
Codex's hooks live in `~/.codex/hooks.json`; the installer additionally
sets `[features] codex_hooks = true` in `~/.codex/config.toml` so the
agent reads them. That config-flag step is in `hook_codex.rs` and not
in the shared installer.

Event coverage varies per agent: Claude and Codex install Stop +
SessionStart hooks, but Gemini has no per-turn Stop hook upstream, so
the Gemini installer only registers SessionStart. The resume id is
captured once at session boot, which is sufficient because
`gemini --resume <id>` doesn't need a mid-session marker.

## Panic strategy

The release profile uses `panic = "unwind"` (not `abort`) so the
worker threads can `catch_unwind` and recover:

- `pty/probe.rs::spawn_url_probe` wraps the `ureq` HEAD probe in
  `catch_unwind` so a panic anywhere in the readiness loop doesn't bring
  down the process. The probe also checks the process-wide
  `SHUTTING_DOWN` flag each tick so app quit isn't blocked for the
  remainder of a 6 s readiness cycle.
- `usage_poller.rs::run_loop` wraps each poll in `catch_unwind`; on
  panic the badge keeps its last value and the loop retries on the
  next tick.
- `install_panic_hook` (in `lib.rs`) routes every panic through
  `log::error!` with the captured backtrace so user bug reports include
  a stack location even in release-bundle macOS app builds (where
  stderr goes nowhere).

## Where to look when…

- **"a new IPC command is needed"** — declare it in the module that owns
  the state, register it in `lib.rs`'s `invoke_handler!`, type it on the
  frontend with `invoke<T>(...)`.
- **"a long-running task should run in the background"** — `thread::Builder`
  with a named thread, a bounded stack, and a stop signal (see
  `usage_poller.rs::start`). Don't reach for tokio.
- **"a config file needs to be edited atomically"** — `atomic_write::write`.
  All hook installers and `rate_limits`'s disk snapshot route through it.
- **"a hot path takes too many locks"** — fold related state behind one
  `Mutex` (see `PaneSignals` — two metadata fields under one lock so
  the reader thread takes a single per-chunk lock instead of two).
