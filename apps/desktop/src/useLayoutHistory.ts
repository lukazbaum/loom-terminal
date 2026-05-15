import { type MutableRefObject, useCallback, useRef } from "react";

import { pushToast } from "./toast";
import type { Session } from "./types";

const LAYOUT_HISTORY_LIMIT = 50;

/// Undo / redo of the `workspaces` shape. Snapshots are taken via
/// `captureLayoutSnapshot()` before each destructive op (close pane,
/// close workspace, duplicate pane, etc.); `undoLayout` / `redoLayout`
/// pop from the relevant stack and hand the result to `setWorkspaces`.
///
/// State lives in refs so capture is cheap (no React commit) and the
/// undo stack survives unrelated workspace re-renders. The 50-snapshot
/// cap protects against unbounded growth in a long session — the user
/// is realistically never undoing more than a handful of steps.
///
/// Why only the workspaces shape: undoing pane add/close is what users
/// asked for. Active-pane selection, sidebar width, and per-pane grid
/// fractions live in their own state and are deliberately NOT captured;
/// rewinding them would feel jumpy rather than helpful.
export function useLayoutHistory(
  workspacesRef: MutableRefObject<Session[]>,
  setWorkspaces: (next: Session[]) => void,
): {
  captureLayoutSnapshot: () => void;
  undoLayout: () => void;
  redoLayout: () => void;
} {
  const layoutPastRef = useRef<Session[][]>([]);
  const layoutFutureRef = useRef<Session[][]>([]);

  const captureLayoutSnapshot = useCallback(() => {
    layoutPastRef.current.push(workspacesRef.current);
    if (layoutPastRef.current.length > LAYOUT_HISTORY_LIMIT) {
      layoutPastRef.current.shift();
    }
    layoutFutureRef.current = [];
  }, [workspacesRef]);

  const undoLayout = useCallback(() => {
    const past = layoutPastRef.current;
    if (past.length === 0) {
      pushToast("Nothing to undo.", { kind: "info", timeoutMs: 2000 });
      return;
    }
    const snapshot = past.pop();
    if (!snapshot) return;
    layoutFutureRef.current.push(workspacesRef.current);
    setWorkspaces(snapshot);
  }, [workspacesRef, setWorkspaces]);

  const redoLayout = useCallback(() => {
    const future = layoutFutureRef.current;
    if (future.length === 0) {
      pushToast("Nothing to redo.", { kind: "info", timeoutMs: 2000 });
      return;
    }
    const snapshot = future.pop();
    if (!snapshot) return;
    layoutPastRef.current.push(workspacesRef.current);
    setWorkspaces(snapshot);
  }, [workspacesRef, setWorkspaces]);

  return { captureLayoutSnapshot, undoLayout, redoLayout };
}
