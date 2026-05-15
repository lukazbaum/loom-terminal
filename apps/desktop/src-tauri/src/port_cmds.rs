/// Frontend wrappers for the per-workspace detected-ports list that
/// the PTY reader thread populates. Read by the Ports panel; pruned
/// whenever the user dismisses an entry or it ages out.
use tauri::State;

use crate::port_detect;
use crate::AppState;

/// Detected ports older than this without re-detection are pruned the
/// next time the frontend asks for the list. Long-running workspaces
/// otherwise accumulate stale entries forever.
const PORT_STALE_MS: u64 = 60 * 60 * 1000; // 1 hour

#[tauri::command]
pub fn list_workspace_ports(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Vec<port_detect::WorkspacePort> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut map = state.workspace_ports.lock();
    if let Some(ports) = map.get_mut(&workspace_id) {
        ports.retain(|p| now_ms.saturating_sub(p.last_detected_ms) < PORT_STALE_MS);
        ports.clone()
    } else {
        Vec::new()
    }
}

#[tauri::command]
pub fn dismiss_workspace_port(
    state: State<'_, AppState>,
    workspace_id: String,
    url: String,
) -> Result<(), String> {
    let mut map = state.workspace_ports.lock();
    if let Some(ports) = map.get_mut(&workspace_id) {
        ports.retain(|p| p.url != url);
    }
    Ok(())
}
