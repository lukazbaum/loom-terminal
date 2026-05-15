//! Shared timing / size constants used across the backend.

use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// Process-wide shutdown signal. Flipped from the Tauri run-loop's
/// `RunEvent::Exit` so background threads (URL probe poll loop, usage
/// poller) can bail at the next iteration instead of blocking the app
/// quit for the rest of their current cycle. Stays false for the entire
/// lifetime of a normal run; only ever flips true during teardown.
pub static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Read buffer used when slurping a small file for attachments. Files
/// are capped at MAX_ATTACH_BYTES; this is just the initial Vec
/// capacity to avoid the first few growths.
pub const ATTACH_READ_BUFFER_BYTES: usize = 8 * 1024;

/// Brief pause between the new shell coming up and Loom replaying the
/// original startup command after an in-place pane restart. Without it,
/// the command lands before the shell is reading stdin and shows up as
/// a paste instead of a real keypress (some shells echo, history skip,
/// etc.).
pub const RESTART_COMMAND_DELAY: Duration = Duration::from_millis(60);
