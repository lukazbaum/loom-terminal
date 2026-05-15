# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security reports.

Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/lukazbaum/loom-terminal/security/advisories/new)

Or email **lukas@lukasbaum.dev**.

We aim to acknowledge receipt within 7 days and to publish a fix and advisory
once a patch is ready.

## In scope

Loom runs locally as a desktop app. Likely classes of issue:

- Code execution via crafted PTY output
- Bypasses of the Tauri CSP or IPC allowlist
- Privilege escalation through the opt-in agent hooks Loom installs into
  `~/.claude`, `~/.codex`, or `~/.gemini` (each one is gated behind a
  per-agent consent card on first launch; consent is persisted in
  `~/.loom/hooks.json`)

## Out of scope

- Vulnerabilities in upstream dependencies — please report to those projects.
- Issues that already require local code execution on the user's machine.

## Threat model and mitigations

Loom runs PTY output from agent processes and dev servers inside a
Tauri webview. The classes of attack a reporter is most likely to
explore — and the mitigations they need to defeat:

### PTY-output-driven code execution

PTY bytes are *never* eval'd. The pipeline:

1. Bytes land in `apps/desktop/src-tauri/src/pty/reader.rs`'s per-pane
   reader thread.
2. They're pushed into a fixed-size `RingBuffer` (4 MiB scrollback), fed
   to the OSC marker scanner, and forwarded to the frontend as base64.
3. The frontend hands them to xterm.js for rendering, which escapes all
   CSI/OSC sequences before applying them to the terminal grid.
4. The Tauri webview's CSP (`script-src 'self' 'wasm-unsafe-eval'`,
   `style-src 'self' 'unsafe-inline'`) blocks inline scripts entirely;
   `wasm-unsafe-eval` is required by xterm.js's WebGL addon and isn't
   reachable from PTY output.

The backend OSC scanner (`pty_buffer::OscScanner`) recognizes one
Loom-specific marker — `loom-session` — by pattern, never by `eval` /
`Function`. The other hook-emitted marker (`loom-stop`) is consumed
by xterm.js's OSC 9 handler on the frontend, in `TerminalView.tsx`,
so the backend treats those bytes as ordinary scrollback. Payload
size on the session-id marker is clamped at `OSC_PAYLOAD_MAX_BYTES`
(64 KiB) so a crafted oversized marker can't OOM the scanner.

### Tauri command surface

Every `#[tauri::command]` is enumerated in `lib.rs`'s
`invoke_handler!`. The notable ones and how they handle untrusted input:

- `read_file_for_attach` (`attach.rs`) — bounded at 100 KB
  (`MAX_BYTES = 100_000`), refuses symlinks (`symlink_metadata`
  check), refuses anything that isn't a regular file (sockets, FIFOs,
  devices, directories), and requires the canonicalized path to live
  under a registered workspace root.
- Per-pane env-var overrides (`env_validate.rs`) — validates POSIX env
  names, rejects NUL / newline bytes in values, and denylists keys
  that act as code-injection vectors for the spawned shell or agent
  (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `PERL5*`,
  `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `IFS`, `PS4`, etc.).
- Workspace path arguments — `register_workspace` rejects non-absolute
  paths so downstream `df` / `git -C` invocations can't treat the
  workspace value as a CLI flag. `workspace_dirty_summary` shells
  `git status` with `-c core.fsmonitor= -c core.hooksPath=/dev/null
  -c protocol.ext.allow=never` so an attacker-staged repo can't get
  arbitrary code to run through git's standard exec-on-config hooks.
- Opener capability is `opener:allow-open-url` scoped to `https://*`
  and `http://*` only — `open_path` / `reveal_item_in_dir` are not
  granted so a frontend pivot can't shell-open a `.command` /
  `.app` bundle.

### iframe (WebPreviewPane)

Detected localhost dev-server URLs render inside an iframe with
`sandbox="allow-scripts allow-forms allow-same-origin
allow-downloads"`, `referrerPolicy="no-referrer"`, and an empty
`allow=""`. The CSP `frame-src` allowlist limits *which* hosts can
be framed; the sandbox attributes limit what those hosts can *do*
once framed (no top-navigation, no popups, no native permission
prompts).

### Agent-hook installation

Hooks land in `~/.claude/settings.json`, `~/.codex/hooks.json`, and
`~/.gemini/settings.json`. The installer (`hook_common::install_loom_hook`):

- Gates every install behind a per-agent consent card on first launch.
  Consent is persisted to `~/.loom/hooks.json` (`hook_consent.rs`).
- Atomically writes the bundled stop-hook script (write-to-temp +
  mode 0600 + fsync + rename + dir-fsync via `atomic_write::write`)
  so a crash or power loss mid-update can't truncate a user's working
  hook. The atomic-write path refuses to overwrite a symlink at the
  destination so a planted symlink can't redirect the write target.
- Identifies its own entries on subsequent runs by the *exact*
  ` # <marker>` trailing-comment suffix on the command line, not by a
  bare substring match — a user-authored hook whose command happens
  to mention the marker word internally is left alone. Legacy markers
  from earlier Loom versions are upgraded in place by the same
  suffix-match rule.
- Shell-quotes the bundled script path before embedding it in the
  command field, so a `$HOME` with spaces or shell metachars doesn't
  word-split into a broken (or, pathologically, RCE-shaped) command
  line at hook-fire time.
- If the existing settings file fails to parse as JSON, copies it
  off to `<path>.loom-backup-<unix_ts>.json` before falling back to a
  fresh object — hand-edited state (including JSONC comments) is
  recoverable rather than silently destroyed.

### CSP

Tightened in `apps/desktop/src-tauri/tauri.conf.json`:

- `img-src` omits remote schemes — no source code loads `<img src=…>`
  from the network. `data:` / `blob:` cover icon SVGs and any future
  canvas exports.
- `frame-src` allows only `'self'` + `http://localhost:*` and
  `http://127.0.0.1:*` so `WebPreviewPane` can iframe detected dev
  servers but a malicious chunk can't iframe `attacker.example`.
- `connect-src` mirrors the same localhost restriction plus the Tauri
  IPC channel.
- `base-uri 'self'` blocks a `<base href="…">` from rewriting every
  relative URL out from under the otherwise-tight `default-src 'self'`.
- `form-action 'none'`, `object-src 'none'`, `frame-ancestors 'none'`,
  `worker-src 'self'`, `manifest-src 'self'` close the standard escape
  hatches a webview compromise would otherwise reach for.
- `'wasm-unsafe-eval'` and `'unsafe-inline'` for styles are present but
  scoped: WASM is reachable only by xterm.js's WebGL renderer; inline
  styles are required by Tailwind v4's runtime arbitrary-value classes.

### Panics

Release builds use `panic = "unwind"` rather than `abort`. Worker
threads (URL probe, usage poller) wrap their hot paths in
`std::panic::catch_unwind` so a parser bug in one path doesn't take
down the whole process. A custom panic hook (`install_panic_hook` in
`lib.rs`) routes every panic through the log file — important on
macOS bundles where stderr is silenced. The full `Backtrace::capture()`
is only included in debug builds, since captured backtraces can
include in-frame strings derived from parsed input that we'd rather
not persist to disk under whatever umask the user happens to have.
