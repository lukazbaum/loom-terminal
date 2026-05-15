/// Backend ring buffer for PTY scrollback + the OSC-9 marker scanner
/// the reader thread runs over each chunk. Both are pure data
/// structures with no Tauri / app coupling, so they live together
/// here away from the bigger lib.rs.
use std::collections::VecDeque;

pub struct RingBuffer {
    bytes: VecDeque<u8>,
    cap: usize,
    /// Monotonic count of every byte ever pushed (not the current buffer size).
    /// Used as an opaque cursor by `snapshot_since` so callers can do
    /// incremental reads without re-receiving the whole scrollback.
    total_pushed: u64,
}

pub struct SnapshotSlice {
    pub bytes: Vec<u8>,
    pub new_token: u64,
    /// True when the caller's `since_token` was older than the current
    /// buffer window — i.e. some bytes between then and now have been
    /// evicted. The returned `bytes` is the entire current window so the
    /// caller can resync, but be aware that data was lost.
    pub dropped: bool,
}

impl RingBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(cap),
            cap,
            total_pushed: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            // Incoming chunk alone is bigger than the window — keep the tail.
            self.bytes.clear();
            self.bytes
                .extend(data[data.len() - self.cap..].iter().copied());
        } else {
            let new_total = self.bytes.len() + data.len();
            if new_total > self.cap {
                let drop = new_total - self.cap;
                self.bytes.drain(..drop);
            }
            self.bytes.extend(data.iter().copied());
        }
        self.total_pushed += data.len() as u64;
    }

    pub fn snapshot(&self) -> Vec<u8> {
        // VecDeque is a ring; `as_slices()` returns its contents as up
        // to two contiguous slices. Building the Vec via
        // `extend_from_slice` lets the allocator memcpy whole runs
        // instead of copying byte-by-byte through the iterator chain.
        // Material at the 4 MiB cap: each snapshot runs under the
        // buffer lock that the reader thread holds during chunk push.
        let (a, b) = self.bytes.as_slices();
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }

    pub fn snapshot_since(&self, token: u64) -> SnapshotSlice {
        let total = self.total_pushed;
        if token >= total {
            return SnapshotSlice {
                bytes: Vec::new(),
                new_token: total,
                dropped: false,
            };
        }
        let buf_len = self.bytes.len() as u64;
        let oldest_token = total - buf_len;
        if token < oldest_token {
            return SnapshotSlice {
                bytes: self.snapshot(),
                new_token: total,
                dropped: true,
            };
        }
        let skip = (token - oldest_token) as usize;
        // Walk the up-to-two contiguous slices once and copy via
        // memcpy. The previous `iter().skip(skip).copied().collect()`
        // was a per-byte loop that the optimizer can't always vectorize
        // through the `skip` adaptor.
        let (a, b) = self.bytes.as_slices();
        let take = self.bytes.len() - skip;
        let mut bytes = Vec::with_capacity(take);
        if skip < a.len() {
            bytes.extend_from_slice(&a[skip..]);
            bytes.extend_from_slice(b);
        } else {
            bytes.extend_from_slice(&b[skip - a.len()..]);
        }
        SnapshotSlice {
            bytes,
            new_token: total,
            dropped: false,
        }
    }

    pub fn total_pushed(&self) -> u64 {
        self.total_pushed
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// Streaming scanner for Loom's `loom-session` OSC 9 marker. Maintains
/// state across reads so a marker (or its payload) split across PTY
/// chunks is handled correctly.
///
/// Recognized marker:
///   `ESC ] 9 ; loom-session ; <uuid> ESC \`  — agent session id
///
/// The OSC string terminator may be either `ESC \` (ST) or `\x07` (BEL),
/// per VT spec; both are accepted.
///
/// Loom's other hook-emitted markers (`loom-stop`, formerly `loom-report`)
/// are consumed at the frontend (xterm.js OSC 9 handler) rather than the
/// backend — they don't need a backend capture path. From this scanner's
/// POV their bytes are plain output and pass through unobserved.
pub struct OscScanner {
    pending: Vec<u8>,
    /// When Some, we're collecting the session payload until its terminator.
    payload: Option<Vec<u8>>,
}

const OSC_SESSION_PREFIX: &[u8] = b"\x1b]9;loom-session;";
pub(crate) const OSC_PAYLOAD_MAX_BYTES: usize = 64 * 1024;

impl OscScanner {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            payload: None,
        }
    }

    /// Returns the session ids captured from this chunk. Each ID has
    /// already passed `is_valid_session_id`; hostile bytes are dropped.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(chunk);

        let mut sessions: Vec<String> = Vec::new();
        let mut i = 0;
        while i < data.len() {
            // Inside the session payload — collect bytes until terminator.
            if let Some(buf) = self.payload.as_mut() {
                let b = data[i];
                if b == 0x07 {
                    push_session(&mut sessions, std::mem::take(buf));
                    self.payload = None;
                    i += 1;
                    continue;
                }
                if b == 0x1b {
                    if i + 1 < data.len() {
                        if data[i + 1] == b'\\' {
                            push_session(&mut sessions, std::mem::take(buf));
                            self.payload = None;
                            i += 2;
                            continue;
                        }
                    } else {
                        // ESC at end of chunk — could start the ST
                        // terminator. Defer to next feed.
                        self.pending = data[i..].to_vec();
                        return sessions;
                    }
                }
                buf.push(b);
                if buf.len() > OSC_PAYLOAD_MAX_BYTES {
                    // Oversized payload — drop and resync.
                    self.payload = None;
                }
                i += 1;
                continue;
            }

            if data[i..].starts_with(OSC_SESSION_PREFIX) {
                self.payload = Some(Vec::new());
                i += OSC_SESSION_PREFIX.len();
                continue;
            }

            // Could be a partial session-prefix at the tail; defer if so
            // so the marker still resolves once the next chunk arrives.
            let rest = &data[i..];
            if rest.len() < OSC_SESSION_PREFIX.len() && OSC_SESSION_PREFIX.starts_with(rest) {
                self.pending = rest.to_vec();
                return sessions;
            }
            i += 1;
        }
        sessions
    }
}

fn push_session(sessions: &mut Vec<String>, buf: Vec<u8>) {
    let Ok(s) = String::from_utf8(buf) else {
        return;
    };
    // Session ids get spliced into a shell command string on the next
    // launch (`claude --resume <id>`). The frontend regex-validates
    // before that splice, but defense-in-depth: refuse anything that
    // doesn't look like a Claude session UUID at capture time so a
    // hostile PTY emitter can't get arbitrary bytes into event streams /
    // persisted state in the first place.
    if is_valid_session_id(&s) {
        sessions.push(s);
    } else {
        log::warn!(
            "loom-session OSC payload rejected ({} bytes, charset violation)",
            s.len()
        );
    }
}

fn is_valid_session_id(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 {
        return false;
    }
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod session_id_tests {
    use super::*;

    fn feed(input: &[u8]) -> Vec<String> {
        OscScanner::new().feed(input)
    }

    #[test]
    fn accepts_real_claude_session_id() {
        let s = b"\x1b]9;loom-session;abc123_def-456\x1b\\";
        assert_eq!(feed(s), vec!["abc123_def-456".to_string()]);
    }

    #[test]
    fn rejects_shell_injection_in_session_id() {
        // Exactly the attack the FE SESSION_ID_RE was added to block.
        // Defense-in-depth: refuse it at PTY capture too, so the bad
        // bytes don't reach event listeners / persisted state at all.
        let s = b"\x1b]9;loom-session;abc;rm -rf ~;#\x1b\\";
        assert!(feed(s).is_empty(), "shell-meta session id must be dropped");
    }

    #[test]
    fn rejects_space_in_session_id() {
        let s = b"\x1b]9;loom-session;abc def\x1b\\";
        assert!(feed(s).is_empty());
    }

    #[test]
    fn rejects_path_traversal_in_session_id() {
        let s = b"\x1b]9;loom-session;../../etc/passwd\x1b\\";
        assert!(feed(s).is_empty());
    }

    #[test]
    fn rejects_empty_session_id() {
        let s = b"\x1b]9;loom-session;\x1b\\";
        assert!(feed(s).is_empty());
    }

    #[test]
    fn rejects_oversized_session_id() {
        // 129 ASCII letters → over the 128-byte cap.
        let inner = "a".repeat(129);
        let raw = format!("\x1b]9;loom-session;{inner}\x1b\\");
        assert!(feed(raw.as_bytes()).is_empty());
    }

    #[test]
    fn accepts_max_length_session_id() {
        let inner = "a".repeat(128);
        let raw = format!("\x1b]9;loom-session;{inner}\x1b\\");
        assert_eq!(feed(raw.as_bytes()).len(), 1);
    }

    #[test]
    fn rejects_session_id_with_embedded_newline_replacement_chars() {
        // Even after the OSC scanner state machine ends the payload on
        // an ESC/ST, a hostile emitter could try fitting other control
        // chars inside. The charset filter catches those.
        let s = b"\x1b]9;loom-session;abc\x01def\x1b\\";
        assert!(feed(s).is_empty());
    }
}
