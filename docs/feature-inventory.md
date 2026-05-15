# Loom Feature Inventory

A read-only map of what Loom does today, organized by functional area.
File references point at the module that owns each behavior; deeper
line numbers are deliberately omitted because they drift with every
refactor — `grep -n` once you're in the right file.

---

## 1. Terminal & Shell

- **Multiple shell agents**. Built-in presets for Shell (empty
  command), Claude, Codex, OpenCode, Gemini, Grok. Detection is
  basename-based, so `FOO=bar /usr/local/bin/claude --resume` still
  resolves as Claude. Anything else becomes "custom". (`src/agents.ts`)
- **PTY spawning and lifecycle**. Tauri backend spawns native PTYs via
  `portable_pty`; wraps each child in `ChildGuard` so any drop path
  SIGKILLs the process. Ring buffer holds 4 MiB of scrollback per pane;
  per-pane reader thread pushes output through a `tauri::ipc::Channel`
  to the matching `<TerminalView>`. (`src-tauri/src/pty/spawn.rs`,
  `pty/reader.rs`, `pty_buffer.rs`)
- **Terminal environment inheritance**. Resolves the `claude` binary
  via `$PATH` + login shell config + hardcoded fallback paths
  (`~/.claude/local`, `~/.npm-global`, `~/.bun`, `~/.volta`,
  `/opt/homebrew`, `/usr/local`). Used by `usage_poller` and by
  the hook installer when it needs the canonical path.
  (`src-tauri/src/shell_env.rs`)
- **Backend OSC scanning**. `OscScanner` (`pty_buffer.rs`) recognizes
  the `loom-session` OSC-9 marker emitted by each agent's hook and
  pushes the captured id to the React side via the
  `loom-session-captured` event. The companion `loom-stop` marker is
  consumed by xterm.js's OSC 9 handler in `TerminalView.tsx`, not by
  the backend scanner. Both scanners are state machines that handle
  markers split across PTY chunks.
- **Resume agent sessions**. If a pane's stored command still leads
  with the agent that captured the id, the spawn splices in the
  agent-specific resume flag: `claude --resume <id>`,
  `codex resume <id>` (subcommand, not flag), or
  `gemini --resume <id>`. Spliced at spawn time only — never baked
  into the persisted command — so a fresh capture after `/clear`
  always wins over a hydrated one. (`src/sessionPersist.ts ::
  resumeAwareCommand`)

---

## 2. Workspaces & Sessions

- **Workspace anchoring**. Each workspace is a folder path. Frontend
  registers / unregisters workspaces via Tauri commands; backend
  tracks the workspace path + a list of pane ids per workspace.
  (`src-tauri/src/workspace_cmds.rs`)
- **Multi-pane layout per workspace**. Workspaces hold a pane list;
  frontend renders a CSS-grid with manual or auto-fit dimensions and
  draggable resize tracks. (`src/Workspace.tsx`)
- **Session persistence to localStorage**. Workspace list + pane
  configs (id, kind, command, cwd, env, previewUrl, sessionId,
  sessionAgent) saved to `loom.session.v1`; the small selection blob
  (active workspace + active pane per workspace) saved to a separate
  `loom.session.selection.v1` key so a pane click doesn't restringify
  the workspaces array. On restore, each pane respawns its command
  from scratch (PTY state can't be serialized). The reader still
  accepts the legacy `claudeSessionId` field on disk for snapshots
  written before the multi-agent rename. (`src/sessionPersist.ts`)
- **Per-pane environment variables**. Each pane can override env vars
  as a `{key: value}` map layered on the inherited shell environment.
  Validated at spawn time: rejects POSIX-illegal names, NUL/newline
  values, and a denylist of code-injection vectors (`LD_*`, `DYLD_*`,
  `NODE_OPTIONS`, `BASH_ENV`, `PROMPT_COMMAND`, `IFS`, `PS4`,
  `PERL5LIB`, `PERL5OPT`, `PYTHONPATH`, …). (`src-tauri/src/env_validate.rs`)
- **Synchronous session-id overrides**. Captured ids are also written
  to a tiny `loom.session.idOverrides.v1` map synchronously from the
  `loom-session-captured` event listener, so a hard quit between
  marker arrival and the 1 s debounced shape save doesn't lose the
  resume id. The next shape save folds the override back in.

---

## 3. Presets & Agents

- **Preset object**. ID, name, workspace path, pane count, per-pane
  startup commands (array of strings), created timestamp. Stored in
  `loom.presets.v1`. Legacy `vibeTerm.presets.v2` migration runs once
  on read. (`src/presets.ts`)
- **Built-in agents**. Shell (empty command), Claude (`claude`),
  Codex (`codex`), OpenCode (`opencode`), Gemini (`gemini`),
  Grok (`grok`). (`src/agents.ts`)
- **Custom commands**. Anything not matching a built-in agent
  basename is type `custom`.
- **Preset CRUD**. Create / update / delete with automatic command
  array normalization (pad with `""` or truncate to match the pane
  count). Saved on every change.

---

## 4. Web Preview & Ports

- **Port detection**. Per-pane `UrlDetector` watches PTY output for
  dev-server URLs (`http://localhost:PORT`-shape). Maintains a rolling
  4 KB tail so URLs split across chunks resolve; uses a `detected` set
  to fire once per `host:port`. Patterns: `Local: http://…`
  (Vite / Astro / Nuxt / CRA / Webpack / Storybook / Next.js),
  `listening on …` (Django / Rails / Hugo / etc.), and bare loopback
  URLs on their own line. Host-allowlist regex is anchored so
  `localhost.attacker.com` doesn't slip through. (`src-tauri/src/port_detect.rs`)
- **Ready probe**. On detection, an in-process `ureq` HEAD probe (1 s
  timeout, polled for up to 6 s) gates "URL printed" → "URL ready"
  so Next.js et al don't surface as broken iframes. Bails early on
  app shutdown via the process-wide `SHUTTING_DOWN` flag.
- **Ports panel**. Modal listing detected dev-server URLs per
  workspace. Shows URL + age + originating pane + ready flag.
  Actions: preview / copy URL / open in external browser / dismiss.
  Auto-refreshes on `workspace-port-detected`. (`src/PortsPanel.tsx`)
- **Web preview pane**. Iframe-based preview of a localhost dev
  server. Viewport sizes (full / 1280 / 768 / 375), in-app history
  stack (capped at 50), reload (cache-buster query param), URL bar,
  external-open. iframe sandbox is `allow-scripts allow-forms
  allow-same-origin allow-downloads` with `referrerPolicy="no-referrer"`
  and `allow=""`. (`src/WebPreviewPane.tsx`)

---

## 5. OS Integrations

- **File dialogs**. `tauri_plugin_dialog`'s `open` for folder
  selection on the Welcome screen.
- **Opener plugin**. `plugin:opener|open_url` opens a URL in the
  system browser. Capability is scoped to `http://*` + `https://*`
  only — `open_path` / `reveal_item_in_dir` are not granted.
- **Per-agent agent hooks**. Auto-installs / upgrades, one agent at
  a time, after the user opts in via the per-agent consent card:
  - **Claude** — Stop + SessionStart hooks in `~/.claude/settings.json`
  - **Codex** — Stop + SessionStart hooks in `~/.codex/hooks.json`
    (plus `[features] codex_hooks = true` in `~/.codex/config.toml`)
  - **Gemini** — SessionStart hook only in `~/.gemini/settings.json`
    (Gemini has no per-turn Stop hook; capturing the resume id once
    at session boot is sufficient)

  Each script emits `loom-session` (resume id) on every fire it has;
  the Stop scripts additionally emit `loom-stop` (turn-end signal
  consumed by xterm.js on the frontend). Installer is idempotent:
  upgrades existing Loom-owned hooks transparently (matched by a
  trailing `# <marker>` comment, not a substring) and preserves
  any other hooks the user has.
  Consent is persisted to `~/.loom/hooks.json`.
  (`src-tauri/src/hook.rs`, `hook_codex.rs`, `hook_gemini.rs`,
  `hook_common.rs`, `hook_consent.rs`)

---

## 6. Settings UI

- **In-app settings page**. `SettingsPage.tsx` covers terminal font
  size, idle quiet-window timeout, the active theme picker, the
  `⌘R` restart-shortcut toggle, and a read-only keyboard-shortcut
  overview. Routed via the gear icon in the header.
- **Theme editor**. `ThemeEditor.tsx` for creating / editing /
  importing / deleting custom themes; the registry lives in
  `themes.ts` and the active theme is mirrored to CSS variables on
  `:root`. Each theme has a full token table (ink-0..ink-4, paper,
  rule, amber, coral, mint, etc.) plus an `appearance: "dark" | "light"`
  flag that drives `color-scheme`.
- **Keyboard shortcut overview**. `KeyboardHelpOverlay.tsx` (triggered
  with `?` anywhere outside an input). Same data the Settings page
  renders. Read-only today — rebinding isn't implemented yet.

---

## 7. Persistence keys

- `loom.session.v1` — `PersistedSession` (v, workspaces,
  activeWorkspaceId, activePaneByWs). Heavy blob, debounced 1 s.
- `loom.session.selection.v1` — small selection blob. Debounced 200 ms
  so pane clicks don't restringify the workspace array.
- `loom.session.idOverrides.v1` — synchronously-written
  `paneId → {id, agent, ts}` map covering the
  marker-arrived-but-not-yet-saved race.
- `loom.presets.v1` — array of `Preset` objects. Migrated from the
  legacy `vibeTerm.presets.v2` key on first read.
- `loom.welcome.recentFolders.v1` — capped list of recent folders.
- `loom.welcome.recentCommands.v1` — capped list of recent startup commands.
- `loom.settings.v1` — flat key/value object that backs the
  `useSetting` hook.
- `loom.themes.v1` — user-authored themes registry.
- `loom.sidebarCollapsed` / `loom.sidebarWidth` — sidebar state.

---

## 8. Hardening

- **Atomic writes for config files**. `atomic_write::write` does
  write-to-tempfile (`NamedTempFile`) + fsync + atomic rename +
  parent-dir fsync. Refuses to overwrite a symlink at the
  destination so a planted symlink can't redirect the write target.
- **Workspace path validation**. `register_workspace` rejects
  non-absolute paths so downstream `df` / `git -C` invocations can't
  treat the workspace value as a CLI flag. `workspace_dirty_summary`
  shells `git status` with `-c core.fsmonitor=`, `-c
  core.hooksPath=/dev/null`, `-c protocol.ext.allow=never` so an
  attacker-staged repo can't trigger arbitrary code via git config.
- **`read_file_for_attach`**. Bounded at 100 KB, refuses symlinks
  + non-regular files, requires a canonicalized path under a
  registered workspace root.
- **CSP / capabilities**. Tightened CSP in `tauri.conf.json`:
  no remote `connect-src` outside localhost + IPC; `frame-src`
  limited to self + localhost; `form-action 'none'`, `object-src
  'none'`, `frame-ancestors 'none'`. Opener capability scoped to
  `http://*` + `https://*` only. See `SECURITY.md` for the full
  surface.
- **Panic resilience**. Worker threads (URL probe, usage poller)
  wrap their hot paths in `std::panic::catch_unwind`. Process-wide
  panic hook in `lib.rs` routes panics through `log::error!` so
  macOS app-bundle users (where stderr is silenced) still get a
  stack location.

---

## Notable Missing on the Surface

- **Telemetry**. None. No analytics, no crash reporting, no remote
  calls. Local-first design intent.
- **Plugins / Extensions**. No plugin system; features are
  compiled in.
- **Collaboration**. No real-time multi-user sharing or remote
  cursors.
- **Standalone CLI**. No command-line interface for launching
  workspaces or creating presets outside the Tauri app.
- **Full-text scrollback search**. No search over pane output;
  scrollback is the 4 MiB ring buffer, lost on app close or pane
  restart.
- **Keyboard shortcut rebinding**. The keyboard-help overlay is
  read-only; users can't customize bindings today.
- **Signed / notarized binaries**. `bun run tauri build` produces
  working artifacts but Gatekeeper / SmartScreen flag them as
  unsigned. Code-signing is on the roadmap.
