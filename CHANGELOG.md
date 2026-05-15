# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it ships a tagged release.

The "Unreleased" section accumulates changes between releases — append
under the appropriate subheading as you land them, and on release cut
move the whole section under a new version heading.

## [Unreleased]

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

[Unreleased]: https://github.com/lukazbaum/loom-terminal/compare/v0.1.0-alpha...HEAD
[0.1.0-alpha]: https://github.com/lukazbaum/loom-terminal/releases/tag/v0.1.0-alpha
