//! Dev-server URL HEAD probe. Spawned from the reader thread the
//! moment `port_detect::UrlDetector` recognizes a fresh URL.
//!
//! Probes until the server responds 2xx/3xx (or 6 s elapses), then
//! registers the result on the workspace ports list and emits
//! `workspace-port-detected`. Skipped if a probe for the same URL is
//! already running for this workspace — without that guard a fast
//! burst of URL-shaped output (e.g. `npm ls`) would spawn dozens of
//! duplicate threads.

use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::port_detect;
use crate::AppState;

pub(crate) fn spawn_url_probe(
    app: AppHandle,
    workspace_id: String,
    pane_id: String,
    detected: port_detect::DetectedUrl,
) {
    let key = (workspace_id.clone(), detected.url.clone());
    {
        let state: tauri::State<'_, AppState> = app.state();
        let mut in_flight = state.probe_in_flight.lock();
        if !in_flight.insert(key.clone()) {
            return;
        }
    }
    let key_for_thread = key.clone();
    let key_for_fallback = key;
    let app_for_fallback = app.clone();
    let result = thread::Builder::new()
        .name(format!(
            "loom-probe-{}",
            &detected.url[..32.min(detected.url.len())]
        ))
        .stack_size(256 * 1024)
        .spawn(move || {
            // Guard ensures the in-flight entry is removed even on panic
            // so we don't permanently block re-probing the same URL.
            struct InFlightGuard {
                app: AppHandle,
                key: (String, String),
            }
            impl Drop for InFlightGuard {
                fn drop(&mut self) {
                    let state: tauri::State<'_, AppState> = self.app.state();
                    state.probe_in_flight.lock().remove(&self.key);
                }
            }
            let _guard = InFlightGuard {
                app: app.clone(),
                key: key_for_thread,
            };

            // Probe body in catch_unwind so a panic in `url_is_ready`
            // (or anywhere downstream) is logged + lets the InFlightGuard
            // clear the slot, instead of bringing down the process under
            // panic = unwind (and being invisible under panic = abort).
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut ready = false;
                for _ in 0..30 {
                    // Bail early on app shutdown so quit isn't blocked
                    // waiting for the rest of a 6 s readiness loop.
                    if crate::constants::SHUTTING_DOWN.load(Ordering::Relaxed) {
                        return;
                    }
                    if port_detect::url_is_ready(&detected.url) {
                        ready = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(200));
                }

                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let port = port_detect::WorkspacePort {
                    pane_id: pane_id.clone(),
                    url: detected.url.clone(),
                    original_url: detected.original.clone(),
                    first_seen_ms: now_ms,
                    last_detected_ms: now_ms,
                    ready,
                };

                let state: tauri::State<'_, AppState> = app.state();
                let should_emit = {
                    let mut map = state.workspace_ports.lock();
                    let ports = map.entry(workspace_id.clone()).or_default();
                    // Dedup on URL; if same URL is here from a prior
                    // detection, refresh last_detected_ms (so
                    // list_workspace_ports won't TTL it out) and upgrade
                    // `ready` if we now have it.
                    if let Some(existing) = ports.iter_mut().find(|p| p.url == port.url) {
                        existing.last_detected_ms = now_ms;
                        if ready && !existing.ready {
                            existing.ready = true;
                            true
                        } else {
                            false
                        }
                    } else {
                        ports.push(port.clone());
                        true
                    }
                };
                if should_emit {
                    let _ = app.emit(
                        "workspace-port-detected",
                        serde_json::json!({
                            "workspace_id": workspace_id,
                            "port": port,
                        }),
                    );
                }
            }));
            if let Err(e) = result {
                let msg = e
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| e.downcast_ref::<String>().map(std::string::String::as_str))
                    .unwrap_or("<non-string panic>");
                log::error!("URL probe panicked: {msg}");
            }
        });
    if result.is_err() {
        // Spawn failed (rare — kernel out of threads). Clear the guard
        // so retry is possible.
        let state: tauri::State<'_, AppState> = app_for_fallback.state();
        state.probe_in_flight.lock().remove(&key_for_fallback);
    }
}
