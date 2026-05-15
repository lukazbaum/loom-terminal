import { useReducer } from "react";

import type { Pane, Session } from "./types";

/// Discriminated-union of every shape-mutation the workspaces array
/// goes through. The reducer is intentionally pure — side effects
/// (Tauri invokes, layout-history snapshots, active-pane updates,
/// toasts) stay at the call site so the reducer can be unit-tested in
/// isolation. App-side wrappers like `addPane` still bundle the
/// side-effect + dispatch under the same name, so callers don't see
/// the reducer at all.
export type WorkspacesAction =
  | { type: "add"; workspace: Session }
  | { type: "remove"; wsId: string }
  | { type: "move"; from: number; to: number }
  | { type: "rename"; wsId: string; name: string | undefined }
  | {
      type: "setGrid";
      wsId: string;
      cols: number | undefined;
      rows: number | undefined;
    }
  | { type: "addPane"; wsId: string; pane: Pane }
  | { type: "addPanes"; wsId: string; panes: Pane[] }
  | { type: "addPreviewPane"; wsId: string; url: string; pane: Pane }
  | { type: "removePane"; wsId: string; paneId: string }
  | { type: "togglePin"; wsId: string; paneId: string }
  | {
      type: "patchPaneSession";
      paneId: string;
      sessionId: string;
      agent: NonNullable<Pane["sessionAgent"]>;
    }
  /// Replace the array wholesale. Used by the undo / redo layer in
  /// `useLayoutHistory`, which restores a saved snapshot rather than
  /// re-deriving it through actions. Kept in the union (instead of a
  /// side-channel setter) so undo / redo go through the same dispatch
  /// path as everything else — easier to log / instrument.
  | { type: "replace"; next: Session[] };

/// Pure reducer. Every arm returns the input untouched when the action
/// can't make progress (unknown workspace id, no-op reorder, duplicate
/// preview pane url) so callers can dispatch unconditionally and the
/// React shallow-equality check skips an unnecessary commit.
export function workspacesReducer(
  state: Session[],
  action: WorkspacesAction,
): Session[] {
  switch (action.type) {
    case "add":
      return [...state, action.workspace];

    case "remove":
      return state.filter((w) => w.id !== action.wsId);

    case "move": {
      const { from, to } = action;
      if (from < 0 || from >= state.length) return state;
      if (to < 0 || to > state.length) return state;
      if (from === to || from === to - 1) return state;
      const next = state.slice();
      const item = next.splice(from, 1)[0];
      if (!item) return state;
      const adjusted = from < to ? to - 1 : to;
      next.splice(adjusted, 0, item);
      return next;
    }

    case "rename":
      return state.map((w) =>
        w.id === action.wsId
          ? {
              ...w,
              name:
                action.name && action.name.length > 0 ? action.name : undefined,
            }
          : w,
      );

    case "setGrid":
      return state.map((w) =>
        w.id === action.wsId
          ? { ...w, gridCols: action.cols, gridRows: action.rows }
          : w,
      );

    case "addPane":
      return state.map((w) =>
        w.id === action.wsId ? { ...w, panes: [...w.panes, action.pane] } : w,
      );

    case "addPanes":
      return state.map((w) =>
        w.id === action.wsId
          ? { ...w, panes: [...w.panes, ...action.panes] }
          : w,
      );

    case "addPreviewPane":
      return state.map((w) => {
        if (w.id !== action.wsId) return w;
        const existing = w.panes.find(
          (p) => p.kind === "preview" && p.previewUrl === action.url,
        );
        if (existing) return w;
        return { ...w, panes: [...w.panes, action.pane] };
      });

    case "removePane":
      return state.map((w) =>
        w.id === action.wsId
          ? { ...w, panes: w.panes.filter((p) => p.id !== action.paneId) }
          : w,
      );

    case "togglePin":
      return state.map((w) => {
        if (w.id !== action.wsId) return w;
        const set = new Set(w.pinnedPaneIds ?? []);
        if (set.has(action.paneId)) set.delete(action.paneId);
        else set.add(action.paneId);
        return { ...w, pinnedPaneIds: Array.from(set) };
      });

    case "patchPaneSession": {
      let changed = false;
      const next = state.map((w) => {
        const idx = w.panes.findIndex((p) => p.id === action.paneId);
        if (idx < 0) return w;
        const pane = w.panes[idx];
        if (!pane) return w;
        if (
          pane.sessionId === action.sessionId &&
          pane.sessionAgent === action.agent
        ) {
          return w;
        }
        changed = true;
        const panes = w.panes.slice();
        panes[idx] = {
          ...pane,
          sessionId: action.sessionId,
          sessionAgent: action.agent,
        };
        return { ...w, panes };
      });
      return changed ? next : state;
    }

    case "replace":
      return action.next;
  }
}

/// Thin hook around `useReducer`. Exposed as a hook (rather than just a
/// reducer) so it can grow side-effect plumbing later — e.g. an
/// internal undo stack — without changing every call site.
export function useWorkspacesStore(initial: Session[]): {
  workspaces: Session[];
  dispatch: React.Dispatch<WorkspacesAction>;
} {
  const [workspaces, dispatch] = useReducer(workspacesReducer, initial);
  return { workspaces, dispatch };
}
