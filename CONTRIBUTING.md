# Contributing

Thanks for considering a contribution. Loom is pre-1.0; bug reports,
fixes, and feature ideas are all welcome.

> **Heads-up on CI:** workflow auto-triggers are paused while the
> project is in early-launch mode, so your PR won't show a green
> check. The maintainer runs the local `bun run check` umbrella
> before merging — see step 4 below. If a PR has been sitting for a
> few days without a response, ping in [Discussions][disc] or in the
> PR itself.

[disc]: https://github.com/lukazbaum/loom-terminal/discussions

## Building locally

See the [Install](README.md#install) section of the README for
prerequisites and full run instructions. The short version:

```sh
bun install --frozen-lockfile
bun run tauri dev
```

`--frozen-lockfile` matches what CI does and refuses to silently
regenerate `bun.lock` from a drifted `package.json`. Rust pulls its
toolchain from `rust-toolchain.toml` (channel + clippy + rustfmt) on
the first `cargo` invocation in the repo.

## Workflow

1. **For non-trivial changes, open an issue first** so we can talk through the
   approach before you spend time on a PR.
2. Fork the repo and create a feature branch off `main`.
3. Make your change. Keep the diff focused — small PRs land faster.
4. Run the local check umbrella — one command:

   ```sh
   bun run check
   ```

   That runs biome (format + lint), the frontend unit-test suite
   (`bun test`), the frontend build (`tsc && vite build`),
   `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
   and `cargo test --all-targets`. Split as `bun run check:fe` and
   `bun run check:rs` if you only want one side. (CI's full set
   additionally runs `cargo check --all-targets` and `cargo audit`;
   clippy effectively subsumes the check pass, and audit advisories
   shouldn't gate a fix PR.)

5. Open a PR against `main`. Reference any related issue.

## Code style

- **Rust** — standard `rustfmt`; clippy-clean.
- **TypeScript / React** — match the surrounding files. Tailwind for styling.
- **Comments** — only when the *why* isn't obvious from the code. Don't
  paraphrase what the next line already says.

## Tests

Both sides have unit tests — they run as part of `bun run check`.

**Rust** (118 tests). Conventions:

- **Where they live.** In the same file as the module under test,
  inside a `#[cfg(test)] mod tests { … }` block at the bottom. See
  `pty_buffer.rs` (ring-buffer + OSC scanner), `pty/spawn.rs`
  (`evict_failed_spawn` rollback + `ChildGuard::Drop` SIGKILL),
  `workspace_cmds.rs` (`unregister_workspace` lock-order regression),
  `usage_poller.rs` (`/usage` modal parsing), `hook_common.rs`
  (hook installer upserts), and `port_detect.rs` (URL extraction).

- **What's worth covering.** Pure functions on PTY-output bytes
  (anything in `ansi`, `pty_buffer`, `port_detect`, the `parse_usage`
  path), upsert helpers in `hook_common`, and any state machine that's
  easy to express as a chunked-input fixture. The Tauri command surface
  itself is harder to test in isolation (the commands take `State<'_,
  AppState>`); prefer extracting the meaty logic into a free function
  and testing that — see `workspace_cmds::unregister_workspace_impl`
  for the pattern.

- **What's still uncovered.** PTY reader-thread integration, the full
  `install_loom_hook` end-to-end flow (touches HOME / the filesystem),
  and the rate-limit disk persistence layer. Each is a good first PR.

**Frontend** (30 tests). Uses bun's built-in test runner.

- **Where they live.** Co-located as `<module>.test.ts` alongside the
  source. `apps/desktop/src/sessionPersist.test.ts` is the seed —
  covers `parsePersistedPane`, `loadSession`, `isSessionAgent`,
  `resumeAwareCommand`. The tsconfig `exclude`s `**/*.test.ts` so the
  vite build doesn't choke on the `bun:test` import.

- **localStorage.** Bun runs in Node, so there's no `window` or
  `localStorage` by default. The test file stubs them with an
  in-memory Map — see the top of `sessionPersist.test.ts` for the
  pattern to copy.

- **What's worth covering.** Pure data-shape transforms (the
  `sessionPersist` helpers, `presets` normalization, the
  `agents.detectAgent` + `agents.parseCommandLead` pair) and anything
  with a documented input/output contract. React component tests are
  out of scope for the bun test runner; for those we'd need vitest +
  jsdom, tracked separately.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind,
assume good faith, and keep discussions on-topic.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
