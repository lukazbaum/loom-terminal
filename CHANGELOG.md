# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it ships a tagged release.

The "Unreleased" section accumulates changes between releases — append
under the appropriate subheading as you land them, and on release cut
move the whole section under a new version heading.

## [Unreleased]

### Added
- Initial backend test coverage for the shared hook installer (10 new
  unit tests covering nested + flat upsert flows).
- Shared `ansi` byte-stripper module used by both `port_detect` and
  `usage_poller`.
- `cargo audit`, Dependabot, and per-OS Rust CI (macOS now in addition
  to Linux).

### Changed
- `App.tsx` and `Welcome.tsx` decomposed into per-component files —
  behavior-identical splits, no logic changes.
- `workspace_dirty_summary` does one `git status --branch --porcelain=v1`
  instead of two separate git invocations.
- Usage-poller regexes compiled once via `OnceLock` instead of on every
  poll tick.

### Fixed
- `restart_pane_session`'s reader-thread-failure path no longer leaks
  stale `pane_to_session` / `workspace.pane_ids` entries.
- `usage_poller::extract_window` walks back to a char boundary before
  slicing — claude's modal contains multi-byte `─` separators that
  could land mid-codepoint and panic.
- `workspace_dirty_summary` no longer spams warn-level logs for stale
  workspaces (folder deleted out from under it).
- `read_file_for_attach` rejects non-regular files (sockets, FIFOs,
  device files) before reading.

### Security
- CSP narrowed in `tauri.conf.json`: dropped `https:` from `img-src`
  (no remote image loads anywhere) and replaced wide-open
  `frame-src http: https:` with localhost-only matching connect-src.

[Unreleased]: https://github.com/lukazbaum/loom-terminal/commits/main
