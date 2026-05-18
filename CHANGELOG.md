# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it ships a tagged release.

The "Unreleased" section accumulates changes between releases — append
under the appropriate subheading as you land them, and on release cut
move the whole section under a new version heading.

## [Unreleased]

## [0.1.2-alpha] - 2026-05-18

### Added
- Customizable keyboard shortcuts. Every action in the Keyboard help
  overlay is now rebindable from Settings → Keyboard Shortcuts, with
  cross-OS chord normalization (a single `Mod` token resolves to ⌘ on
  macOS and Ctrl on Windows/Linux), a chord-recorder, and a
  `useActionChord` hook so inline hints (Sidebar, AppHeader, pane
  menu) update on rebind. Digit ranges and Escape stay non-customizable.
- Sidebar tab pulses (mint) when a non-focused workspace has unseen
  agent output. Tracked per-pane so catching up on one pane doesn't
  dismiss another's pulse; the pulse clears when you activate the
  workspace or scroll the relevant pane to the bottom.
- Notification sound when an agent finishes a turn. Off by default;
  pick from four built-in synthesized presets (Ding / Chime / Beep /
  Pop) or a custom `.wav` / `.mp3` / `.ogg` / `.flac`. Rides the same
  gate as the sidebar pulse — suppressed when you're already looking
  at the pane and scrolled to the bottom.

### Fixed
- Agent-completion detection: idle-timer fallback was firing during
  normal Claude/Codex work (mid-turn pauses, immediately after a
  workspace switch). Bell / OSC 133 / idle signals are now silenced
  for hook-equipped agents and pending idle timers are cancelled on
  pause.
- Claude 2.1.142+ detaches its Stop hook from the controlling TTY,
  which made the `loom-stop` OSC marker unreachable. Added a sidecar
  transport: hook scripts write `~/.loom/stops/<pane_id>` on Stop and
  a backend poller forwards mtime changes to the frontend as a new
  `loom-stop-captured` Tauri event.
- Pane scroll position is preserved when an agent ends its turn,
  instead of snapping to the bottom.

### Hardened
- `assetProtocol` enabled in `tauri.conf.json` with an extension-only
  scope (`.wav` / `.mp3` / `.ogg` / `.flac`) so user-picked
  notification sounds can be served without opening the door to
  arbitrary local-file access; CSP gains a matching `media-src 'self'
  asset: http://asset.localhost` directive.

## [0.1.1-alpha] - 2026-05-16

### Fixed
- Drag-and-drop files from Finder (or any external source) now lands
  in the focused pane of the active workspace via `text/uri-list`,
  instead of being swallowed by the WebView's default handler.
- Claude session resume no longer breaks when the Stop / SessionStart
  hooks run with no TTY attached; bad / malformed session ids are
  rejected up-front instead of being persisted.

## [0.1.0-alpha] - 2026-05-15

First tagged release. Loom is a Tauri 2 + React 19 desktop app for
running multiple coding agents (Claude, Codex, OpenCode, Gemini, Grok)
side-by-side in one workspace. Builds are **unsigned** — macOS users
may need to right-click → Open the first time, or
`xattr -d com.apple.quarantine /Applications/Loom.app`. Signing is on
the roadmap.

### Highlights
- Multi-pane workspaces anchored to a project folder; presets for
  one-click relaunch of a saved layout; custom themes.
- Agent session resume across restarts (Claude, Codex, Gemini) via
  per-agent Stop / SessionStart hooks the app auto-installs after
  per-agent consent.
- Dev-server port detection — paste `bun run dev` in a pane, get a
  toast + an iframe preview with desktop / tablet / mobile viewports.
- 4 MiB-per-pane ring buffer scrollback, per-pane environment
  overrides, in-app settings (font size, idle window, theme,
  keyboard shortcut overview).

### Hardened
- CSP locked down in `tauri.conf.json` (no remote `img-src`,
  localhost-only `frame-src` / `connect-src`, `object-src 'none'`,
  `frame-ancestors 'none'`).
- Per-pane env-var validation rejects `LD_*`, `DYLD_*`,
  `NODE_OPTIONS`, `BASH_ENV`, `PROMPT_COMMAND`, `PYTHONPATH`,
  `PERL5*`, etc.
- Workspace path arguments rejected if non-absolute (blocks argv
  injection into downstream `df` / `git -C`); `workspace_dirty_summary`
  pins `git -c core.fsmonitor= -c core.hooksPath=/dev/null
  -c protocol.ext.allow=never` so an attacker-staged repo can't get
  arbitrary code via git config.
- Atomic config-file writes via `tempfile::NamedTempFile` + parent
  fsync; refuses to overwrite a symlink at the destination.
- Dev-server URL detection's host allowlist anchored so
  `localhost.attacker.com` doesn't slip through to the
  "Open in browser" path.

### Tested
- 118 Rust unit tests (lock-order regression + ChildGuard SIGKILL +
  spawn rollback + RingBuffer + OscScanner + hook installer + URL
  extractor + atomic_write + env validation + usage modal parsing).
- 30 frontend unit tests over the persistence layer
  (parsePersistedPane / loadSession / resumeAwareCommand /
  isSessionAgent).
- All running via `bun run check`. CI gates merges on the same.

[Unreleased]: https://github.com/lukazbaum/loom-terminal/compare/v0.1.2-alpha...HEAD
[0.1.2-alpha]: https://github.com/lukazbaum/loom-terminal/compare/v0.1.1-alpha...v0.1.2-alpha
[0.1.1-alpha]: https://github.com/lukazbaum/loom-terminal/compare/v0.1.0-alpha...v0.1.1-alpha
[0.1.0-alpha]: https://github.com/lukazbaum/loom-terminal/releases/tag/v0.1.0-alpha
