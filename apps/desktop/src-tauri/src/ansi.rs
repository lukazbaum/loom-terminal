//! Shared ANSI / OSC stripper. The PTY-output consumers (URL detection
//! in `port_detect`, usage-modal parsing in `usage_poller`) want subtly
//! different shapes — usage parsing needs cursor-forward replaced with
//! spaces so claude's column layout doesn't glue words together, URL
//! detection needs `\r` stripped so a CRLF doesn't split a printed URL
//! line — but the byte-scanner state machine is the same in both.
//!
//! The previous setup had two near-identical ~60-line copies; a fix to
//! one (e.g. handling a new escape) had to be mirrored to the other.

/// Upper bound on the number of literal spaces a `CSI n C` (cursor-
/// forward) sequence expands to. Caps runaway parameter values so a
/// malformed input can't blow up the output buffer.
pub const MAX_CURSOR_FORWARD: usize = 200;

#[derive(Clone, Copy)]
pub struct StripOpts {
    /// Replace `CSI n C` (cursor-forward) with `n` literal spaces
    /// (clamped to `MAX_CURSOR_FORWARD`). Claude's TUI uses cursor
    /// forwards for column layout instead of emitting padding bytes —
    /// stripping without expansion produces "Currentsession" instead
    /// of "Current session".
    pub expand_cursor_forward: bool,
    /// Drop bare `\r` bytes. URL detection wants this so a CRLF doesn't
    /// split a printed URL across two scan rows; usage parsing leaves
    /// them in (the modal content has none to begin with).
    pub strip_carriage_return: bool,
}

impl StripOpts {
    /// Strip `\r` so URL-shaped lines stay intact across CRLF boundaries.
    /// Cursor-forward stays as-is — URL detection works on the raw text.
    pub const fn for_url_detection() -> Self {
        Self {
            expand_cursor_forward: false,
            strip_carriage_return: true,
        }
    }

    /// Expand cursor-forward to spaces so claude's column layout maps to
    /// a flat string the usage parser can grep on.
    pub const fn for_usage_parsing() -> Self {
        Self {
            expand_cursor_forward: true,
            strip_carriage_return: false,
        }
    }
}

/// Strip CSI / OSC escape sequences and (optionally) bare `\r` from a
/// byte slice. When `opts.expand_cursor_forward` is set, `CSI n C` is
/// replaced with `n` literal spaces.
pub fn strip_ansi(input: &[u8], opts: StripOpts) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let b = input[i];
        if b == 0x1b && i + 1 < input.len() {
            let next = input[i + 1];
            match next {
                b'[' => {
                    // CSI: collect parameter bytes, then consume the
                    // final byte (0x40..=0x7e). If final byte is `C`
                    // (cursor-forward) and the caller asked for it,
                    // substitute spaces.
                    i += 2;
                    let mut params: Vec<u8> = Vec::new();
                    let mut final_byte: u8 = 0;
                    while i < input.len() {
                        let c = input[i];
                        i += 1;
                        if (0x40..=0x7e).contains(&c) {
                            final_byte = c;
                            break;
                        }
                        params.push(c);
                    }
                    if opts.expand_cursor_forward && final_byte == b'C' {
                        let count: usize = std::str::from_utf8(&params)
                            .ok()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(1);
                        let count = count.min(MAX_CURSOR_FORWARD);
                        out.extend(std::iter::repeat_n(b' ', count));
                    }
                    continue;
                }
                b']' => {
                    // OSC: skip until BEL (0x07) or ST (ESC \).
                    i += 2;
                    while i < input.len() {
                        let c = input[i];
                        if c == 0x07 {
                            i += 1;
                            break;
                        }
                        if c == 0x1b && i + 1 < input.len() && input[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                    continue;
                }
                b'(' | b')' => {
                    // G0/G1 charset designators: `ESC ( <selector>` /
                    // `ESC ) <selector>`. Three bytes total.
                    i += 3.min(input.len() - i);
                    continue;
                }
                _ => {
                    // Other 2-byte ESC sequence — skip both bytes.
                    i += 2;
                    continue;
                }
            }
        }
        if opts.strip_carriage_return && b == b'\r' {
            i += 1;
            continue;
        }
        out.push(b);
        i += 1;
    }
    out
}
