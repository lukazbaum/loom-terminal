//! Per-pane reader thread + the pure `process_chunk` it runs each tick.
//!
//! The reader thread is spawned by `spawn::spawn_terminal` (for fresh
//! panes) and by `commands::restart_pane_session` (which reuses the same
//! `session_id` so React's existing channel handlers stay valid). It
//! reads PTY output forever, pushes to the ring buffer, scans for OSC
//! markers, runs URL detection, and emits chunks until the reader
//! EOFs / the channel closes / the shutdown flag flips.
//!
//! `process_chunk` is split out as a pure function so the chunk-handling
//! logic can be unit-tested without spinning up a real PTY. All shared
//! state is mutated in place behind the locks; the function returns
//! actionable signals (new session id, detected URL) for the calling
//! thread to do the I/O.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::port_detect;
use crate::pty_buffer::{OscScanner, RingBuffer};

use super::spawn::{ExitPayload, OutputPayload, PaneSignals};

/// Spawn the per-pane reader thread. Returns `Err` only when the OS
/// refuses the thread spawn (thread limit, OOM) — callers must roll
/// back the session state they already inserted so the failed pane
/// doesn't stick around as a phantom entry.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_pane_reader_thread(
    app: AppHandle,
    session_id: String,
    pane_id: String,
    workspace_id: String,
    mut reader: Box<dyn Read + Send>,
    buffer: Arc<Mutex<RingBuffer>>,
    signals: Arc<Mutex<PaneSignals>>,
    shutdown: Arc<AtomicBool>,
    output_channel: Channel<OutputPayload>,
    exit_channel: Channel<ExitPayload>,
) -> Result<(), String> {
    thread::Builder::new()
        .name(format!(
            "loom-pty-{}",
            &session_id[..8.min(session_id.len())]
        ))
        .stack_size(256 * 1024)
        .spawn(move || {
            let mut scanner = OscScanner::new();
            let mut url_detector = port_detect::UrlDetector::new();
            let mut buf = [0u8; 8192];
            loop {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        let outcome = process_chunk(
                            chunk,
                            &buffer,
                            &signals,
                            &mut scanner,
                            &mut url_detector,
                        );
                        if let Some(sid) = outcome.new_session_id {
                            // Side-channel: nudge the frontend so it can
                            // persist this id to localStorage immediately,
                            // instead of waiting for the next debounced
                            // shape-save (which might never run if the
                            // user quits within 1s of the turn ending).
                            let _ = app.emit(
                                "loom-session-captured",
                                serde_json::json!({
                                    "pane_id": pane_id,
                                    "session_id": sid,
                                }),
                            );
                        }
                        if let Some(detected) = outcome.detected_url {
                            super::probe::spawn_url_probe(
                                app.clone(),
                                workspace_id.clone(),
                                pane_id.clone(),
                                detected,
                            );
                        }

                        if output_channel
                            .send(OutputPayload {
                                id: session_id.clone(),
                                data: B64.encode(chunk),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = exit_channel.send(ExitPayload {
                id: session_id.clone(),
            });
        })
        .map(|_| ())
        .map_err(|e| format!("spawn pty reader thread: {e}"))
}

/// What `process_chunk` saw that the reader-thread caller needs to act
/// on. The caller fires `app.emit` + `spawn_url_probe`; the inner
/// function stays pure-ish (mutates the shared buffer / signals / scanner
/// state but doesn't touch the runtime) so it can be unit-tested.
pub(crate) struct ChunkOutcome {
    /// A fresh Claude/Codex/Gemini session id was captured this chunk
    /// *and* it differs from the prior value (we de-dupe to avoid
    /// flooding the frontend with one event per chatty hook turn).
    pub new_session_id: Option<String>,
    /// URL detector recognized a fresh dev-server URL. Caller spawns
    /// the HEAD-probe thread; this function doesn't touch the runtime.
    pub detected_url: Option<port_detect::DetectedUrl>,
}

/// Push one chunk through the per-pane state: ring buffer, OSC scanner,
/// signals, URL detector. Returns the actionable signals so the calling
/// thread can do the I/O (emit, spawn). All shared state is mutated in
/// place behind the locks.
pub(crate) fn process_chunk(
    chunk: &[u8],
    buffer: &Arc<Mutex<RingBuffer>>,
    signals: &Arc<Mutex<PaneSignals>>,
    scanner: &mut OscScanner,
    url_detector: &mut port_detect::UrlDetector,
) -> ChunkOutcome {
    {
        let mut b = buffer.lock();
        b.push(chunk);
    }
    let sessions = scanner.feed(chunk);
    let now = Instant::now();
    let new_session_id = {
        let mut s = signals.lock();
        s.last_output_at = now;
        let captured = sessions.into_iter().last();
        let changed = match (&captured, &s.last_claude_session_id) {
            (Some(new_id), Some(prev)) => new_id != prev,
            (Some(_), None) => true,
            _ => false,
        };
        if let Some(sid) = captured {
            s.last_claude_session_id = Some(sid.clone());
            if changed {
                Some(sid)
            } else {
                None
            }
        } else {
            None
        }
    };

    // URL detection hot-path skip: only strip ANSI + run the regex if
    // the chunk could plausibly contain a URL. Most PTY output never
    // does, so this saves a Vec allocation + regex on the common path.
    let detected_url = if memchr::memmem::find(chunk, b"://").is_some() {
        let stripped = port_detect::strip_ansi(chunk);
        url_detector.feed(&stripped)
    } else {
        None
    };

    ChunkOutcome {
        new_session_id,
        detected_url,
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::*;
    use crate::pty_buffer::OscScanner;

    fn fresh() -> (
        Arc<Mutex<RingBuffer>>,
        Arc<Mutex<PaneSignals>>,
        OscScanner,
        port_detect::UrlDetector,
    ) {
        (
            Arc::new(Mutex::new(RingBuffer::new(64 * 1024))),
            Arc::new(Mutex::new(PaneSignals::new())),
            OscScanner::new(),
            port_detect::UrlDetector::new(),
        )
    }

    #[test]
    fn plain_text_chunk_buffers_and_returns_no_signals() {
        let (buffer, signals, mut scanner, mut detector) = fresh();
        let outcome = process_chunk(
            b"hello world\n",
            &buffer,
            &signals,
            &mut scanner,
            &mut detector,
        );
        assert!(outcome.new_session_id.is_none());
        assert!(outcome.detected_url.is_none());
        // Buffer received the bytes.
        let snap = buffer.lock().snapshot();
        assert_eq!(snap, b"hello world\n");
        // Signals: only last_output_at advanced.
        let s = signals.lock();
        assert!(s.last_claude_session_id.is_none());
    }

    #[test]
    fn stop_marker_in_stream_is_ignored_by_signals() {
        // `loom-stop` is consumed by xterm.js on the frontend; the
        // backend scanner only tracks session ids now. A stop marker
        // mid-stream must not affect any signals field.
        let (buffer, signals, mut scanner, mut detector) = fresh();
        let stop = b"prefix\x1b]9;loom-stop\x1b\\suffix";
        let outcome = process_chunk(stop, &buffer, &signals, &mut scanner, &mut detector);
        assert!(outcome.new_session_id.is_none());
        let s = signals.lock();
        assert!(s.last_claude_session_id.is_none());
    }

    #[test]
    fn first_session_marker_emits_id_and_stores_it() {
        let (buffer, signals, mut scanner, mut detector) = fresh();
        let chunk = b"\x1b]9;loom-session;abc-123-def\x1b\\";
        let outcome = process_chunk(chunk, &buffer, &signals, &mut scanner, &mut detector);
        assert_eq!(outcome.new_session_id.as_deref(), Some("abc-123-def"));
        let s = signals.lock();
        assert_eq!(s.last_claude_session_id.as_deref(), Some("abc-123-def"));
    }

    #[test]
    fn repeated_session_marker_dedupes_emit() {
        let (buffer, signals, mut scanner, mut detector) = fresh();
        let chunk = b"\x1b]9;loom-session;same-id\x1b\\";
        let first = process_chunk(chunk, &buffer, &signals, &mut scanner, &mut detector);
        assert_eq!(first.new_session_id.as_deref(), Some("same-id"));
        // Second time with the same id should not re-emit (frontend
        // would otherwise see one event per chatty hook turn).
        let second = process_chunk(chunk, &buffer, &signals, &mut scanner, &mut detector);
        assert!(second.new_session_id.is_none());
    }

    #[test]
    fn changed_session_marker_re_emits() {
        let (buffer, signals, mut scanner, mut detector) = fresh();
        process_chunk(
            b"\x1b]9;loom-session;old\x1b\\",
            &buffer,
            &signals,
            &mut scanner,
            &mut detector,
        );
        let outcome = process_chunk(
            b"\x1b]9;loom-session;new\x1b\\",
            &buffer,
            &signals,
            &mut scanner,
            &mut detector,
        );
        assert_eq!(outcome.new_session_id.as_deref(), Some("new"));
    }

    #[test]
    fn url_in_chunk_is_detected_and_returned() {
        let (buffer, signals, mut scanner, mut detector) = fresh();
        let chunk = b"  ready in 312 ms\n\n  Local:   http://localhost:5173/\n";
        let outcome = process_chunk(chunk, &buffer, &signals, &mut scanner, &mut detector);
        let detected = outcome.detected_url.expect("URL detected");
        assert_eq!(detected.url, "http://localhost:5173");
    }

    #[test]
    fn chunk_without_url_marker_does_not_invoke_detector() {
        // Sanity: chunks without `://` skip strip_ansi + regex entirely.
        // We can't directly observe the skip from outside but the
        // outcome must be None.
        let (buffer, signals, mut scanner, mut detector) = fresh();
        let chunk = b"Vite v5  ready in 312 ms\n  (no protocol marker here)\n";
        let outcome = process_chunk(chunk, &buffer, &signals, &mut scanner, &mut detector);
        assert!(outcome.detected_url.is_none());
    }

    #[test]
    fn split_session_marker_across_two_chunks_emits_after_second() {
        let (buffer, signals, mut scanner, mut detector) = fresh();
        let first = process_chunk(
            b"\x1b]9;loom-ses",
            &buffer,
            &signals,
            &mut scanner,
            &mut detector,
        );
        assert!(first.new_session_id.is_none());
        let second = process_chunk(
            b"sion;split-uuid\x1b\\",
            &buffer,
            &signals,
            &mut scanner,
            &mut detector,
        );
        assert_eq!(second.new_session_id.as_deref(), Some("split-uuid"));
    }
}
