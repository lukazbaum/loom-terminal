use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

/// Per-pane detector that watches PTY scrollback for dev-server URLs.
/// Maintains a small rolling tail so URLs split across chunks are caught,
/// and a `detected` set so the same `host:port` doesn't fire twice.
pub struct UrlDetector {
    tail: Vec<u8>,
    detected: HashSet<String>,
}

const TAIL_CAP: usize = 4096;

impl UrlDetector {
    pub fn new() -> Self {
        Self {
            tail: Vec::with_capacity(TAIL_CAP),
            detected: HashSet::new(),
        }
    }

    /// Feeds a fresh chunk of pane output. Returns `Some(normalized_url)`
    /// on the first match for a previously-unseen host:port. Caller is
    /// responsible for the readiness HEAD probe + event emission.
    pub fn feed(&mut self, stripped_chunk: &[u8]) -> Option<DetectedUrl> {
        // Append + cap. We work with stripped (ANSI-free) bytes so the
        // regexes don't have to know about color codes.
        self.tail.extend_from_slice(stripped_chunk);
        if self.tail.len() > TAIL_CAP {
            let drop = self.tail.len() - TAIL_CAP;
            self.tail.drain(..drop);
        }

        let text = String::from_utf8_lossy(&self.tail);
        let text_len = text.len();

        for re in [re_local(), re_phrase(), re_bare()] {
            for cap in re.captures_iter(&text) {
                let Some(m) = cap.get(1) else { continue };
                // Defer if the URL match runs to the end of our buffer —
                // the next chunk might extend it (would otherwise match
                // partial like `http://localhost:5` and announce wrongly).
                if m.end() == text_len {
                    continue;
                }
                let url = m.as_str();
                if rejected(&text, url) {
                    continue;
                }
                let normalized = normalize(url);
                let key = host_port_key(&normalized);
                if !self.detected.insert(key) {
                    continue;
                }
                return Some(DetectedUrl {
                    url: normalized,
                    original: url.to_string(),
                });
            }
        }
        None
    }
}

#[derive(Clone, Serialize, Debug)]
pub struct WorkspacePort {
    pub pane_id: String,
    pub url: String,
    pub original_url: String,
    pub first_seen_ms: u64,
    /// Refreshed every time the URL is re-detected by the URL scanner.
    /// Used by `list_workspace_ports` to drop entries older than
    /// PORT_STALE_MS so the map can't grow without bound across long
    /// sessions.
    pub last_detected_ms: u64,
    pub ready: bool,
}

pub struct DetectedUrl {
    pub url: String,
    pub original: String,
}

// ── Regex set ────────────────────────────────────────────────────────────

static RE_LOCAL: OnceLock<Regex> = OnceLock::new();
static RE_PHRASE: OnceLock<Regex> = OnceLock::new();
static RE_BARE: OnceLock<Regex> = OnceLock::new();

fn re_local() -> &'static Regex {
    RE_LOCAL.get_or_init(|| {
        // "Local: http://..." with leading box/list/icon noise tolerated.
        // Vite, Astro, Nuxt, CRA, Webpack v5, Storybook, Next.js.
        Regex::new(r#"(?im)\bLocal(?:host)?\s*:\s+(https?://[^\s)<>"']+)"#).unwrap()
    })
}

fn re_phrase() -> &'static Regex {
    RE_PHRASE.get_or_init(|| {
        // Phrase-led: Django, Flask, Hugo, Jekyll, Rails, Eleventy,
        // Remix-classic, Webpack v4. Captures the URL after a known cue.
        Regex::new(
            r#"(?i)\b(?:Running on|Listening on|Server (?:address|at|running on)|started at|available at|view\s+\S+\s+in the browser at|Project is running at|Loopback:)\s+(https?://[^\s)<>"']+)"#,
        )
        .unwrap()
    })
}

fn re_bare() -> &'static Regex {
    RE_BARE.get_or_init(|| {
        // Bare loopback URL on its own line — Gatsby, ad-hoc Express.
        Regex::new(
            r#"(?im)^\s*(https?://(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?(?:/\S*)?)\s*$"#,
        )
        .unwrap()
    })
}

// ── Filters ──────────────────────────────────────────────────────────────

static REJECT_PATH: OnceLock<Regex> = OnceLock::new();
static REJECT_HOST: OnceLock<Regex> = OnceLock::new();

fn reject_path() -> &'static Regex {
    REJECT_PATH.get_or_init(|| {
        // Devtools / introspection routes — never the user-facing URL.
        Regex::new(r"(?i)/(?:___graphql|__nuxt_devtools__|__webpack_hmr|sockjs-node|hot-update|webpack-dev-server)").unwrap()
    })
}

fn reject_host() -> &'static Regex {
    REJECT_HOST.get_or_init(|| {
        // Allowlist of acceptable hosts. Anything else is filtered.
        // Loopback in any form, plus tunnel domains the user might use.
        //
        // The trailing `(?:[:/?#]|$)` is load-bearing: a naive `\b` would
        // accept `http://localhost.attacker.com` because `\b` matches at
        // any word/non-word transition (the `.` after `localhost`). Pinning
        // the post-host char to `:`, `/`, `?`, `#`, or end-of-string forces
        // an actual host boundary so an agent can't print a lookalike URL
        // (`http://127.0.0.1.evil.com`) and have it survive the filter
        // through to the "Open in browser" path.
        Regex::new(
            r#"(?i)\bhttps?://(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[a-z0-9-]+\.ngrok\.(?:io|app|dev)|[a-z0-9-]+\.tunnelmole\.[a-z]+|[a-z0-9-]+\.trycloudflare\.com|[a-z0-9-]+\.loca\.lt)(?:[:/?#]|$)"#,
        )
        .unwrap()
    })
}

fn rejected(text: &str, url: &str) -> bool {
    if reject_path().is_match(url) {
        return true;
    }
    if !reject_host().is_match(url) {
        return true;
    }
    // Reject if the URL line itself looks like a Network/LAN advertisement.
    // Find the line containing the URL and inspect it.
    if let Some(idx) = text.find(url) {
        let line_start = text[..idx].rfind('\n').map_or(0, |i| i + 1);
        let line_end = text[idx..].find('\n').map_or(text.len(), |i| idx + i);
        let line = &text[line_start..line_end];
        if line.contains("Network")
            || line.contains("On Your Network")
            || line.contains("On your network")
            || line.contains("external")
            || line.contains("On your devices")
        {
            return true;
        }
    }
    false
}

// ── Normalization ────────────────────────────────────────────────────────

/// Rewrite `0.0.0.0` / `127.0.0.1` / `[::1]` → `localhost` for the iframe
/// src; strip trailing slash + path for keying. Iframe will load fine
/// without the path.
fn normalize(url: &str) -> String {
    url.trim_end_matches('/')
        .replace("://0.0.0.0", "://localhost")
        .replace("://127.0.0.1", "://localhost")
        .replace("://[::1]", "://localhost")
}

fn host_port_key(url: &str) -> String {
    // Extract scheme://host:port (no path) for dedup.
    if let Some(stripped) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    {
        let end = stripped.find('/').unwrap_or(stripped.len());
        return stripped[..end].to_string();
    }
    url.to_string()
}

// ── ANSI stripping ───────────────────────────────────────────────────────

/// Strip CSI / OSC escape sequences and carriage returns from a byte slice.
/// The detector regexes work over plain text, so the reader thread runs
/// this on chunks that contain a `://` before feeding the URL detector.
pub fn strip_ansi(bytes: &[u8]) -> Vec<u8> {
    crate::ansi::strip_ansi(bytes, crate::ansi::StripOpts::for_url_detection())
}

// ── HEAD probe ───────────────────────────────────────────────────────────

/// Cheap HTTP HEAD probe via `ureq`. Returns true if the server responds
/// 2xx or 3xx. Times out at 1s. Used to gate "URL printed" → "URL ready"
/// (Next.js et al print before the listener actually accepts).
///
/// Returns false (rather than panicking or surfacing an error) on every
/// failure mode — DNS, dial timeout, TLS, 4xx, 5xx. The caller retries
/// on a poll loop so a transient failure is harmless; a permanent one
/// just keeps the port marked "not ready" until the reader thread
/// re-detects it.
///
/// In-process — used to shell out to `curl`, which fork+exec'd per probe
/// tick and broke on minimalist macOS images / Windows curl variants
/// whose `-w` formatting differs.
pub fn url_is_ready(url: &str) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(1))
        .build();
    match agent.head(url).call() {
        Ok(resp) => (200..=399).contains(&resp.status()),
        // `Error::Status(code, _)` is returned for 4xx / 5xx — those are
        // valid HTTP responses, just not "ready" in our sense. Anything
        // else (dial / DNS / TLS / timeout) is also "not ready".
        Err(ureq::Error::Status(code, _)) => (200..=399).contains(&code),
        Err(_) => false,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn detect(text: &str) -> Option<String> {
        let mut d = UrlDetector::new();
        d.feed(text.as_bytes()).map(|d| d.url)
    }

    /// Bind a TCP listener on an ephemeral port and serve a single
    /// minimal HTTP response from a background thread. Returns the URL
    /// the test can probe. The thread accepts exactly `n_responses`
    /// requests, then exits — keep the count >= the number of
    /// `url_is_ready` calls in the test.
    fn serve_n(status: u16, n_responses: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for _ in 0..n_responses {
                let Ok((mut sock, _)) = listener.accept() else {
                    return;
                };
                // Drain headers (HEAD/GET request) — we don't care
                // what they say, just that we read enough that the
                // client doesn't see RST.
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf);
                let body = format!("HTTP/1.1 {status} OK\r\nContent-Length: 0\r\n\r\n");
                let _ = sock.write_all(body.as_bytes());
                let _ = sock.flush();
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn url_is_ready_returns_true_for_a_real_200_responder() {
        let url = serve_n(200, 1);
        assert!(
            url_is_ready(&url),
            "200 responder should be considered ready"
        );
    }

    #[test]
    fn url_is_ready_returns_true_for_a_3xx_redirect() {
        let url = serve_n(302, 1);
        assert!(url_is_ready(&url), "3xx range counts as ready");
    }

    #[test]
    fn url_is_ready_returns_false_for_an_unbound_port() {
        // Bind + drop = port is now stale; nothing's listening.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        // Curl will get ECONNREFUSED. Either curl exits non-zero (most
        // platforms) or stdout is "000" — both → false.
        assert!(!url_is_ready(&format!("http://127.0.0.1:{port}")));
    }

    #[test]
    fn vite_local() {
        let s = "  VITE v5.4.10  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n";
        assert_eq!(detect(s), Some("http://localhost:5173".into()));
    }

    #[test]
    fn next_local_with_lan() {
        let s = "  ▲ Next.js 15.0.3\n  - Local:        http://localhost:3000\n  - Network:      http://192.168.1.5:3000\n";
        // Should pick the Local line, not the Network one.
        assert_eq!(detect(s), Some("http://localhost:3000".into()));
    }

    #[test]
    fn rejects_lan_only() {
        let s = "  - Network:      http://192.168.1.5:3000\n";
        assert_eq!(detect(s), None);
    }

    #[test]
    fn django_phrase() {
        let s = "Starting development server at http://127.0.0.1:8000/\nQuit the server with CONTROL-C.\n";
        assert_eq!(detect(s), Some("http://localhost:8000".into()));
    }

    #[test]
    fn rails_listening() {
        let s = "* Listening on http://127.0.0.1:3000\n* Listening on http://[::1]:3000\n";
        // First match wins; both normalize to the same key so the second is filtered as duplicate.
        assert_eq!(detect(s), Some("http://localhost:3000".into()));
    }

    #[test]
    fn gatsby_bare_url_picks_first() {
        let s = "You can now view gatsby-starter-default in the browser.\n\n  http://localhost:8000/\n\nView the GraphiQL, an in-browser IDE, to explore your site's data and schema\n\n  http://localhost:8000/___graphql\n";
        // First bare URL is the site; the GraphiQL one is rejected by path filter.
        assert_eq!(detect(s), Some("http://localhost:8000".into()));
    }

    #[test]
    fn rejects_devtools_path() {
        let s = "Local: http://localhost:3000/__nuxt_devtools__/client/\n";
        assert_eq!(detect(s), None);
    }

    #[test]
    fn dedup_within_session() {
        let s1 = "Local: http://localhost:5173/\n";
        let s2 = "Local: http://localhost:5173/\n";
        let mut d = UrlDetector::new();
        assert!(d.feed(s1.as_bytes()).is_some());
        assert!(d.feed(s2.as_bytes()).is_none());
    }

    #[test]
    fn split_across_chunks() {
        let mut d = UrlDetector::new();
        assert!(d.feed(b"Local: http://localhost:5").is_none());
        let r = d.feed(b"173/\n");
        assert_eq!(r.map(|x| x.url), Some("http://localhost:5173".into()));
    }

    #[test]
    fn normalize_zero_address() {
        let s = "* Running on http://0.0.0.0:5000\n";
        assert_eq!(detect(s), Some("http://localhost:5000".into()));
    }

    /// A malicious agent could print `Local: http://localhost.attacker.com:3000/`.
    /// The allowlist must NOT treat that as a loopback host: the post-host
    /// char has to be `:` / `/` / `?` / `#` / EOS, not `.`. If this slips
    /// through, the URL flows to the ports panel and a one-click "Open in
    /// browser" sends an attacker-controlled URL to the user's default
    /// browser. See `reject_host` for the trailing-anchor rationale.
    #[test]
    fn rejects_lookalike_localhost_subdomain() {
        let s = "Local: http://localhost.attacker.com:3000/\n";
        assert_eq!(detect(s), None);
    }

    #[test]
    fn rejects_lookalike_loopback_ip_subdomain() {
        let s = "Local: http://127.0.0.1.evil.com:3000/\n";
        assert_eq!(detect(s), None);
    }

    #[test]
    fn rejects_lookalike_localhost_subdomain_with_port() {
        let s = "Local: http://localhost.evil.com:3000/\n";
        assert_eq!(detect(s), None);
    }
}
