/// Global registry of pane-id → "type this text into that pane's PTY"
/// callbacks. Populated by each TerminalView at spawn time; read by the
/// App-level drag-drop listener so a Finder drop can be routed to a
/// specific pane without prop-drilling a writer down through Workspace.
///
/// Module-level mutable map rather than React context because the
/// consumer (a `onDragDropEvent` callback) needs a synchronous read
/// from outside the React tree, and the producers (per-pane mount
/// effects) need a synchronous write at mount with no re-render
/// fanout. The map's keys are stable pane ids, so concurrent
/// register / unregister calls don't collide.

type Writer = (text: string) => void;

const writers = new Map<string, Writer>();

/// Register `write` under `paneId`; returns an unregister fn that
/// only deletes when the entry still points at THIS write — guards
/// against a stale cleanup overwriting a fresher mount under the
/// same pane id (React StrictMode dev-mode remounts hit this).
export function registerPaneWriter(paneId: string, write: Writer): () => void {
  writers.set(paneId, write);
  return () => {
    if (writers.get(paneId) === write) writers.delete(paneId);
  };
}

export function getPaneWriter(paneId: string): Writer | null {
  return writers.get(paneId) ?? null;
}

/// POSIX shell-quote: leave shell-safe characters bare, single-quote
/// the rest with the standard `'\''` escape for embedded single
/// quotes. Matches what macOS Terminal.app pastes when you drop a
/// file onto it, so the user can hit Enter without further editing.
export function shellQuotePath(p: string): string {
  return /^[A-Za-z0-9_./@:+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}
