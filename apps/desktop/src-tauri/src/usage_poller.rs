//! Authoritative source of rate-limit data: spawn `claude` in a hidden
//! PTY, type `/usage`, read the rendered modal, parse the two
//! `<N>% used` lines, and push to [`crate::rate_limits`].
//!
//! Why a PTY: `/usage` is an Ink-rendered TUI modal — `claude -p`
//! print-mode just returns a static intro line, not the data. The
//! slash command only fills in the percentages when stdin is a TTY.
//! `claude /usage` makes no API call (it reads cached state from the
//! Anthropic backend), so polling is essentially free.
//!
//! Cadence: once at app launch (after a small startup delay so we
//! don't race with Tauri's window-init) and every `POLL_INTERVAL`
//! after that. The frontend's `useClaudeRateLimits` hook receives the
//! `loom-rate-limits-changed` event whenever a poll updates the cache.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use regex::Regex;
use tauri::AppHandle;

use crate::rate_limits::{self, Window};
use crate::shell_env;

/// Compile the modal regexes exactly once. They were previously rebuilt
/// on every `parse_usage` call (each poll) with `.expect("...regex")`
/// in the hot path, which would have hard-panicked the poller thread
/// on a malformed pattern.
fn pct_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(\d+)\s*%\s*used").expect("pct regex"))
}

fn resets_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?m)^\s*Resets\s+(.+?)\s*$").expect("resets regex"))
}

/// Time between poll attempts after the first one fires.
const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Wait this long after app launch before the first poll, so we
/// don't compete with Tauri's window-init for CPU.
const STARTUP_DELAY: Duration = Duration::from_secs(8);
/// Hard upper bound on a single poll attempt. `/usage` typically
/// renders in 1–3 s; allow extra for slow first-time renders that
/// load contributing-factor data after the limit bars.
const POLL_TIMEOUT: Duration = Duration::from_secs(12);
/// Idle window — once we go this long without reading bytes after
/// the modal first appeared, assume rendering is done.
const QUIESCE_AFTER: Duration = Duration::from_millis(800);

/// Spawn the background poll loop. Idempotent: subsequent calls
/// no-op, so a hot-reloaded `setup()` doesn't spawn duplicate
/// pollers.
pub fn start(app: AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = thread::Builder::new()
        .name("loom-usage-poller".into())
        .stack_size(512 * 1024)
        .spawn(move || run_loop(app))
    {
        // Recoverable: the rate-limit badge just won't update. Hard-
        // aborting the whole app over a missing background poller used
        // to be the behavior here — `.expect()` panicked the setup
        // closure and killed Tauri before the window even showed.
        log::error!("failed to spawn usage poller thread: {e}");
    }
}

fn run_loop(app: AppHandle) {
    thread::sleep(STARTUP_DELAY);
    loop {
        // catch_unwind: the parse path uses Regex::new().expect(...) at
        // module init time, but a future change to parse_usage could
        // panic on malformed claude output. Without this, the poll
        // thread would silently die and the rate-limit badge would
        // freeze at its last value forever.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(poll_once));
        match outcome {
            Ok(Ok((five, seven))) => rate_limits::update_from_poll(&app, five, seven),
            Ok(Err(e)) => {
                // Soft failure: claude may be mid-update, missing from
                // PATH, or the modal format may have shifted. Badge
                // keeps its last value; we'll try again next tick.
                log::warn!("usage poll failed: {e}");
            }
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| {
                        panic
                            .downcast_ref::<String>()
                            .map(std::string::String::as_str)
                    })
                    .unwrap_or("<non-string panic>");
                log::error!("usage poll panicked, will retry next interval: {msg}");
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Run one `/usage` scrape end-to-end. Returns the two parsed windows.
fn poll_once() -> Result<(Option<Window>, Option<Window>), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(shell_env::claude_bin());
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn claude: {e}"))?;
    drop(pair.slave);

    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {e}"))?;

    let collected = Arc::new(Mutex::new(Vec::<u8>::new()));
    let collected_w = collected.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_r = stop.clone();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while !stop_r.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => collected_w.lock().extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
    });

    // Wait for claude to render its welcome screen, then handle the
    // first-time workspace-trust dialog. Claude shows it whenever it
    // hasn't run in this cwd before — including our $HOME launch on
    // a fresh install. The default highlighted choice is "Yes, I
    // trust this folder", so a single Enter accepts it.
    thread::sleep(Duration::from_millis(800));
    {
        let buf = collected.lock();
        let stripped = strip_ansi(&buf);
        if stripped.contains("trust this folder") || stripped.contains("Accessing workspace") {
            drop(buf);
            writer
                .write_all(b"\r")
                .map_err(|e| format!("write trust confirm: {e}"))?;
            writer.flush().ok();
            thread::sleep(Duration::from_millis(1200));
        }
    }
    writer
        .write_all(b"/usage\r")
        .map_err(|e| format!("write /usage: {e}"))?;
    writer.flush().ok();

    // Poll until we've seen the modal AND the output has gone idle,
    // or we hit the hard timeout. We probe against the stripped
    // form because the TUI splits "Current session" across cursor-
    // forward escapes — the raw bytes would never match.
    let deadline = Instant::now() + POLL_TIMEOUT;
    let mut last_len = 0;
    let mut last_change = Instant::now();
    let mut saw_modal = false;
    let plain: String;
    loop {
        thread::sleep(Duration::from_millis(120));
        let now = Instant::now();
        let cur_len = collected.lock().len();
        if cur_len != last_len {
            last_len = cur_len;
            last_change = now;
        }
        if !saw_modal {
            let buf = collected.lock();
            let probe = strip_ansi(&buf);
            if probe.contains("% used") || probe.contains("Current session") {
                saw_modal = true;
                last_change = now;
            }
        }
        let idle_long_enough = saw_modal && now.duration_since(last_change) >= QUIESCE_AFTER;
        if idle_long_enough || now >= deadline {
            let buf = collected.lock();
            plain = strip_ansi(&buf);
            break;
        }
    }

    // Tell claude to exit. Esc closes the modal, then two Ctrl+C's
    // — claude requires the second to confirm exit.
    let _ = writer.write_all(b"\x1b");
    let _ = writer.flush();
    thread::sleep(Duration::from_millis(80));
    let _ = writer.write_all(b"\x03");
    let _ = writer.flush();
    thread::sleep(Duration::from_millis(80));
    let _ = writer.write_all(b"\x03");
    let _ = writer.flush();
    thread::sleep(Duration::from_millis(120));
    let _ = child.kill();
    // Reap with a hard cap: a wedged `claude` binary used to hang the
    // poller thread forever on `child.wait()`, freezing the rate-limit
    // badge for the rest of the process lifetime. SIGKILL above plus a
    // 500 ms try_wait poll covers the normal case; if the OS hasn't
    // delivered SIGCHLD by then we leave the zombie for the kernel to
    // reap at process exit rather than block this thread.
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => break,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => break,
        }
    }
    stop.store(true, Ordering::Relaxed);
    drop(writer);
    drop(pair.master);
    let _ = reader_thread.join();

    Ok(parse_usage(&plain))
}

/// Parse the plain-text (ANSI-stripped) `/usage` modal. Returns the
/// two windows in (five_hour, seven_day) order, either Some when the
/// section was present.
///
/// Expected shape (one example):
///
/// ```text
///   Current session
///   ████████                                          16% used
///   Resets 9:30pm (Europe/Berlin)
///
///   Current week (all models)
///   █████▌                                            11% used
///   Resets May 20 at 9am (Europe/Berlin)
/// ```
///
/// Either window may be entirely absent (e.g. API-key users get a
/// different modal). The parser returns None for the missing slot.
fn parse_usage(text: &str) -> (Option<Window>, Option<Window>) {
    let pct = pct_regex();
    let resets = resets_regex();

    let five = extract_window(text, "Current session", pct, resets);
    // "Current week" or "Current 7-day" — Claude has shipped both
    // labels in different versions. Accept either.
    let seven = extract_window(text, "Current week", pct, resets)
        .or_else(|| extract_window(text, "Current 7-day", pct, resets));
    (five, seven)
}

fn extract_window(text: &str, header: &str, pct_re: &Regex, resets_re: &Regex) -> Option<Window> {
    let start = text.find(header)?;
    // Look inside a small window after the header so we don't pick
    // up percentages from a later section. Walk back to the nearest
    // char boundary — claude's modal contains box-drawing characters
    // (`─` is 3 bytes) so a raw byte offset can land mid-codepoint and
    // panic at the slice. `is_char_boundary` is true at `text.len()`
    // and at every char start, so the loop terminates.
    let mut slice_end = (start + 800).min(text.len());
    while !text.is_char_boundary(slice_end) {
        slice_end -= 1;
    }
    let slice = &text[start..slice_end];

    // At 0%, Claude may omit the "X% used" line (or render the bar
    // empty without a percentage). Treat header-present-but-no-percent
    // as 0% rather than dropping the window — the pill should still
    // show so the user can see "you have a fresh window".
    let used_percentage = pct_re
        .captures(slice)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f32>().ok())
        .unwrap_or(0.0);
    let resets_label = resets_re
        .captures(slice)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    Some(Window {
        used_percentage,
        resets_label,
        resets_at: None,
    })
}

/// Remove ANSI CSI / OSC escape sequences so the regex can match
/// against plain text. Operates on bytes (PTY chunks are not
/// guaranteed UTF-8 mid-stream) and converts to String at the end
/// via `from_utf8_lossy` — this preserves multi-byte unicode like
/// the █ block characters in claude's TUI bars.
///
/// Cursor-forward (`CSI n C`) is replaced with `n` literal spaces:
/// claude's TUI uses it to lay out columns instead of emitting
/// padding bytes, so plain stripping would glue adjacent words
/// together ("Currentsession" instead of "Current session").
fn strip_ansi(input: &[u8]) -> String {
    let bytes = crate::ansi::strip_ansi(input, crate::ansi::StripOpts::for_usage_parsing());
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_typical_usage_modal() {
        let sample = r"
some preamble

Current session
████████                                          16% used
Resets 9:30pm (Europe/Berlin)

Current week (all models)
█████▌                                            11% used
Resets May 20 at 9am (Europe/Berlin)

What's contributing to your limits usage?
";
        let (five, seven) = parse_usage(sample);
        let f = five.expect("five_hour parsed");
        assert_eq!(f.used_percentage as i32, 16);
        assert_eq!(f.resets_label.as_deref(), Some("9:30pm (Europe/Berlin)"));
        let s = seven.expect("seven_day parsed");
        assert_eq!(s.used_percentage as i32, 11);
        assert_eq!(
            s.resets_label.as_deref(),
            Some("May 20 at 9am (Europe/Berlin)")
        );
    }

    #[test]
    fn parse_handles_missing_seven_day() {
        let sample = r"
Current session
████████                                          16% used
Resets 9:30pm

Esc to cancel
";
        let (five, seven) = parse_usage(sample);
        assert_eq!(five.expect("five").used_percentage as i32, 16);
        assert!(seven.is_none());
    }

    #[test]
    fn parse_handles_alternative_seven_day_header() {
        let sample = r"
Current session
██                                                3% used

Current 7-day window
█                                                 1% used
";
        let (_five, seven) = parse_usage(sample);
        assert_eq!(seven.expect("seven").used_percentage as i32, 1);
    }

    #[test]
    fn parse_zero_percent_with_explicit_line() {
        // Belt-and-suspenders: if Claude *does* render "0% used"
        // literally at zero, the existing parse path already handles
        // it. Pin that behavior so a future regex tweak can't regress
        // it without us noticing.
        let sample = r"
Current session
                                                  0% used
Resets 9:30pm (Europe/Berlin)

Current week (all models)
                                                  0% used
Resets May 20 at 9am
";
        let (five, seven) = parse_usage(sample);
        let f = five.expect("five_hour parsed at 0%");
        assert_eq!(f.used_percentage, 0.0);
        assert_eq!(f.resets_label.as_deref(), Some("9:30pm (Europe/Berlin)"));
        let s = seven.expect("seven_day parsed at 0%");
        assert_eq!(s.used_percentage, 0.0);
    }

    #[test]
    fn parse_zero_percent_when_used_line_is_omitted() {
        // Defensive case: Claude may omit the "X% used" line entirely
        // when the window is at 0% (empty bar, header + resets only).
        // We still want the pill to render with 0%, not vanish.
        let sample = r"
Current session
Resets 9:30pm (Europe/Berlin)

Current week (all models)
Resets May 20 at 9am
";
        let (five, seven) = parse_usage(sample);
        let f = five.expect("five_hour falls back to 0% when % line absent");
        assert_eq!(f.used_percentage, 0.0);
        assert_eq!(f.resets_label.as_deref(), Some("9:30pm (Europe/Berlin)"));
        let s = seven.expect("seven_day falls back to 0% when % line absent");
        assert_eq!(s.used_percentage, 0.0);
    }

    #[test]
    fn parse_returns_none_for_api_key_modal() {
        let sample = "You are currently using an API key.\n\nNothing to show here.\n";
        let (five, seven) = parse_usage(sample);
        assert!(five.is_none());
        assert!(seven.is_none());
    }

    #[test]
    fn parse_does_not_panic_on_multi_byte_chars_at_window_boundary() {
        // Reproduction for the "byte index N is not a char boundary"
        // panic: claude's modal contains box-drawing characters (`─` is
        // 3 bytes) which can land mid-codepoint when `extract_window`
        // slices a fixed 800 bytes after the header. Pad so the slice
        // end lands inside a `─` run.
        let mut sample = String::from("Current session\n");
        // Fill ~780 bytes ahead of a `─` block so the 800-byte slice
        // end lands inside the 3-byte char.
        for _ in 0..260 {
            sample.push('─'); // 3 bytes each × 260 = 780 bytes
        }
        sample.push_str("\n  16% used\nResets 9:30pm\n");
        // Must return Some and not panic. We don't care about the
        // percentage here — the regression is the slice itself.
        let (five, _) = parse_usage(&sample);
        assert!(five.is_some());
    }

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        let raw = b"\x1b[31mred\x1b[0m and \x1b[1;32mbold green\x1b[m done";
        assert_eq!(strip_ansi(raw), "red and bold green done");
    }

    #[test]
    fn strip_ansi_removes_osc_sequences() {
        let raw = b"\x1b]0;title\x07after\x1b]133;D\x1b\\next";
        assert_eq!(strip_ansi(raw), "afternext");
    }

    #[test]
    fn strip_ansi_passes_through_plain_text() {
        let raw = b"Current session\n  16% used\n";
        assert_eq!(strip_ansi(raw), "Current session\n  16% used\n");
    }

    #[test]
    fn strip_ansi_expands_cursor_forward_to_spaces() {
        // Claude's TUI uses `CSI n C` for inter-word spacing rather
        // than emitting literal spaces. We substitute them back so
        // "trust\x1b[1Cthis\x1b[1Cfolder" → "trust this folder".
        let raw = b"trust\x1b[1Cthis\x1b[1Cfolder";
        assert_eq!(strip_ansi(raw), "trust this folder");
    }

    #[test]
    fn strip_ansi_expands_cursor_forward_multi_column() {
        // `CSI 5 C` → 5 spaces.
        assert_eq!(strip_ansi(b"a\x1b[5Cb"), "a     b");
    }

    #[test]
    fn strip_ansi_treats_bare_cursor_forward_as_one_space() {
        // `CSI C` (no count) → 1 space, matching the terminal default.
        assert_eq!(strip_ansi(b"a\x1b[Cb"), "a b");
    }
}
