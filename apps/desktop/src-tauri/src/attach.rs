/// Reads a file from a registered workspace for the "attach to chat"
/// affordance. Capped at 100 KB so dropping a giant log doesn't blow up
/// the IPC payload or the model's context.
///
/// The path is canonicalized and required to lie under one of the
/// currently-registered workspace roots. A webview pivot can otherwise
/// turn this command into an arbitrary-file-read primitive against
/// `~/.ssh/id_*`, `~/.aws/credentials`, etc. — most secrets fit
/// comfortably inside the 100 KB cap.
///
/// We also refuse anything that isn't a regular file (symlinks, FIFOs,
/// devices) via `symlink_metadata` so a planted symlink under a
/// workspace root can't redirect the read outside.
use std::io::Read;

use tauri::State;

use crate::AppState;

const MAX_BYTES: usize = 100_000;

#[tauri::command]
pub fn read_file_for_attach(state: State<'_, AppState>, path: String) -> Result<String, String> {
    // Canonicalize before any scope check — otherwise `..` segments slip
    // through a naive `starts_with` against a workspace root.
    let canonical =
        std::fs::canonicalize(&path).map_err(|e| format!("canonicalize {path}: {e}"))?;

    // Refuse symlinks explicitly: `canonicalize` already resolved them,
    // but we want the input path itself to be a regular file so an
    // attacker can't drop a symlink-to-/dev/zero into a workspace and
    // bypass the file-type check on the resolved target.
    let lmeta = std::fs::symlink_metadata(&path).map_err(|e| format!("lstat {path}: {e}"))?;
    if lmeta.file_type().is_symlink() {
        return Err(format!("attach: {path} is a symlink (refused)"));
    }
    if !lmeta.is_file() {
        return Err(format!(
            "attach: {path} is not a regular file ({:?})",
            lmeta.file_type()
        ));
    }

    // Scope: must live under a registered workspace root. Canonicalize
    // the workspace path too so symlink-rooted workspaces still match.
    let workspace_roots: Vec<std::path::PathBuf> = {
        let wmap = state.workspaces.lock();
        wmap.values()
            .filter_map(|w| std::fs::canonicalize(&w.path).ok())
            .collect()
    };
    if !workspace_roots
        .iter()
        .any(|root| canonical.starts_with(root))
    {
        return Err(format!(
            "attach: {path} is not inside any registered workspace"
        ));
    }

    let file = std::fs::File::open(&canonical).map_err(|e| format!("open {path}: {e}"))?;
    let mut buf = Vec::with_capacity(crate::constants::ATTACH_READ_BUFFER_BYTES);
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read {path}: {e}"))?;

    let truncated = buf.len() > MAX_BYTES;
    if truncated {
        buf.truncate(MAX_BYTES);
    }

    let text = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        Ok(format!(
            "{text}\n\n[…truncated, file is larger than {} KB]",
            MAX_BYTES / 1000
        ))
    } else {
        Ok(text)
    }
}
