import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import { reportInvokeError } from "./toast";
import type { Session } from "./types";

type View = { kind: "workspace"; id: string } | { kind: "new" };

type Args = {
  /// Refs feeding the capture-phase handler. Read via `.current` so
  /// the listener doesn't re-bind on every workspace mutation — without
  /// this, fast typing during a busy render queue could miss a Cmd+1.
  activeWorkspaceIdRef: MutableRefObject<string | null>;
  workspacesRef: MutableRefObject<Session[]>;

  /// Live state read by the bubble-phase handler. Listed in the effect's
  /// dep list so a workspace add/remove or pane-active change re-binds
  /// (cheap — one listener swap, no React commit).
  workspaces: Session[];
  activePaneByWs: Record<string, string>;
  restartShortcutEnabled: boolean;

  // ── Mutators / dispatchers ───────────────────────────────────────
  setActivePaneByWs: Dispatch<SetStateAction<Record<string, string>>>;
  setShowShortcutHelp: Dispatch<SetStateAction<boolean>>;
  setActiveView: (next: View) => void;
  setCloseTargetId: Dispatch<SetStateAction<string | null>>;
  setRoute: Dispatch<SetStateAction<"settings" | "themeEditor" | null>>;
  toggleCollapsed: () => void;

  // ── Workspace / pane actions ────────────────────────────────────
  moveWorkspace: (from: number, to: number) => void;
  activateWorkspace: (id: string) => void;
  addPane: (workspaceId: string) => void;
  closePane: (workspaceId: string, paneId: string) => void;
  cyclePane: (workspaceId: string, delta: 1 | -1) => void;
  undoLayout: () => void;
  redoLayout: () => void;
};

/// All top-level keyboard shortcuts, lifted out of App.tsx.
///
/// Split into two listeners by phase:
///
/// 1. **Capture phase** (runs BEFORE xterm.js sees the event) catches
///    chords the terminal would otherwise swallow — bare `?` and
///    `Alt+1..9` emit characters into xterm, so we stop them at the
///    document boundary. Also handles `⌥↑` / `⌥↓` for workspace
///    reorder.
/// 2. **Bubble phase** handles every other `⌘`-modified shortcut.
///    xterm.js leaves `⌘` chords alone, so terminals don't swallow
///    these.
///
/// Hot loops never read closure state for things that can change
/// mid-render: `activeWorkspaceIdRef` and `workspacesRef` are threaded
/// in so we don't have to re-bind the listener on every workspace
/// mutation. The bubble-phase handler's deps DO list its live state
/// because re-binding on workspace add/remove is desirable: those
/// happen rarely (compared to the per-chunk reader-thread events that
/// drove the ref-pattern here in the first place).
export function useAppShortcuts({
  activeWorkspaceIdRef,
  workspacesRef,
  workspaces,
  activePaneByWs,
  restartShortcutEnabled,
  setActivePaneByWs,
  setShowShortcutHelp,
  setActiveView,
  setCloseTargetId,
  setRoute,
  toggleCollapsed,
  moveWorkspace,
  activateWorkspace,
  addPane,
  closePane,
  cyclePane,
  undoLayout,
  redoLayout,
}: Args): void {
  // Capture-phase listener for shortcuts that the terminal would
  // otherwise intercept (bare `?` and Alt+digit emit characters into
  // xterm). Runs BEFORE xterm's own handler and stops propagation
  // when we claim the event, so we don't end up sending stray "¡" / "?"
  // into the shell.
  useEffect(() => {
    const onCaptureKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // `?` opens/closes the keyboard help overlay. Skip when typing.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === "?" && !inField) {
        e.preventDefault();
        e.stopPropagation();
        setShowShortcutHelp((prev) => !prev);
        return;
      }

      // Alt+1..9 — focus pane by index in active workspace.
      // e.code dodges the Option-key symbol mapping on macOS
      // (Option+1 = ¡), letting us claim by physical key position
      // regardless of layout.
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const m = /^Digit([1-9])$/.exec(e.code);
        const digit = m?.[1];
        if (digit) {
          const wsId = activeWorkspaceIdRef.current;
          if (!wsId) return;
          const ws = workspacesRef.current.find((w) => w.id === wsId);
          if (!ws) return;
          const idx = parseInt(digit, 10) - 1;
          const pane = ws.panes[idx];
          if (!pane) return;
          e.preventDefault();
          e.stopPropagation();
          setActivePaneByWs((prev) =>
            prev[wsId] === pane.id ? prev : { ...prev, [wsId]: pane.id },
          );
          return;
        }

        // ⌥↑ / ⌥↓ — reorder the active workspace up / down in the
        // sidebar. Closes the keyboard gap surfaced by the a11y pass
        // (workspace tabs were previously reorder-via-drag-only).
        // `inField` guard so the same chord doesn't get hijacked while
        // typing in Welcome or a settings input.
        if (
          (e.code === "ArrowUp" || e.code === "ArrowDown") &&
          !inField &&
          activeWorkspaceIdRef.current
        ) {
          const list = workspacesRef.current;
          const wsId = activeWorkspaceIdRef.current;
          const idx = list.findIndex((w) => w.id === wsId);
          if (idx < 0) return;
          if (e.code === "ArrowUp" && idx === 0) return;
          if (e.code === "ArrowDown" && idx === list.length - 1) return;
          e.preventDefault();
          e.stopPropagation();
          // moveWorkspace's `to` is the destination index in the
          // *pre-removal* array (see its `adjusted = from < to ? to - 1
          // : to` math): up-one is `idx - 1`, down-one is `idx + 2`.
          const to = e.code === "ArrowUp" ? idx - 1 : idx + 2;
          moveWorkspace(idx, to);
          return;
        }
      }
    };
    window.addEventListener("keydown", onCaptureKey, true);
    return () => window.removeEventListener("keydown", onCaptureKey, true);
    // Listener body reads refs; only `moveWorkspace`'s identity and the
    // setter identities ever change, and React's setters are stable.
  }, [
    moveWorkspace,
    setActivePaneByWs,
    setShowShortcutHelp,
    activeWorkspaceIdRef,
    workspacesRef,
  ]);

  // Bubble phase: every other ⌘-modified shortcut.
  // biome-ignore lint/correctness/useExhaustiveDependencies: handler closes over many in-scope helpers (activateWorkspace, closePane, etc.) that themselves capture state listed in the dep array; honest fix would need a useRef bag, deferred
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only handle pure ⌘ shortcuts. xterm.js leaves ⌘ alone, so
      // terminals don't swallow these.
      if (!e.metaKey || e.altKey || e.ctrlKey) return;

      const k = e.key.toLowerCase();
      const shifted = e.shiftKey;

      // ── Workspaces ─────────────────────────
      if (k === "t" && !shifted) {
        e.preventDefault();
        setActiveView({ kind: "new" });
        return;
      }
      if (k === "w" && shifted && activeWorkspaceIdRef.current) {
        e.preventDefault();
        setCloseTargetId(activeWorkspaceIdRef.current);
        return;
      }
      // ⌘⇧] on US layout produces "}", ⌘⇧[ produces "{". Also accept
      // the physical key positions for non-US layouts.
      if (
        activeWorkspaceIdRef.current &&
        workspaces.length > 1 &&
        (e.key === "}" || (shifted && e.code === "BracketRight"))
      ) {
        e.preventDefault();
        const cur = activeWorkspaceIdRef.current;
        const idx = workspaces.findIndex((w) => w.id === cur);
        const target =
          idx >= 0 ? workspaces[(idx + 1) % workspaces.length] : undefined;
        if (target) activateWorkspace(target.id);
        return;
      }
      if (
        activeWorkspaceIdRef.current &&
        workspaces.length > 1 &&
        (e.key === "{" || (shifted && e.code === "BracketLeft"))
      ) {
        e.preventDefault();
        const cur = activeWorkspaceIdRef.current;
        const idx = workspaces.findIndex((w) => w.id === cur);
        const target =
          idx >= 0
            ? workspaces[(idx - 1 + workspaces.length) % workspaces.length]
            : undefined;
        if (target) activateWorkspace(target.id);
        return;
      }
      if (/^[1-9]$/.test(e.key) && !shifted) {
        const idx = parseInt(e.key, 10) - 1;
        const target = workspaces[idx];
        if (target) {
          e.preventDefault();
          activateWorkspace(target.id);
        }
        return;
      }

      // ── View ───────────────────────────────
      if (k === "b" && !shifted) {
        e.preventDefault();
        toggleCollapsed();
        return;
      }
      if (e.key === "," && !shifted) {
        e.preventDefault();
        setRoute((prev) => (prev === "settings" ? null : "settings"));
        return;
      }

      // ── Panes ──────────────────────────────
      // The grid layout is uniform, so split-horizontal and
      // split-vertical currently both just append a pane. True
      // directional splits would need a tree-based layout instead of
      // cols×rows.
      // Reading activeWorkspaceIdRef.current (instead of view.id from
      // the closure) closes the race where ⌘N fires between a workspace
      // tab click and the next render — we want the new pane in the
      // *new* workspace, not the stale one captured when the handler
      // was bound.
      const wsId = activeWorkspaceIdRef.current;
      if (!wsId) return;
      if (k === "n" && !shifted) {
        e.preventDefault();
        addPane(wsId);
        return;
      }
      if (k === "d") {
        e.preventDefault();
        addPane(wsId);
        return;
      }
      if (k === "w" && !shifted) {
        e.preventDefault();
        const activeId = activePaneByWs[wsId];
        if (activeId) closePane(wsId, activeId);
        return;
      }
      if (k === "z" && !shifted) {
        e.preventDefault();
        undoLayout();
        return;
      }
      if (k === "z" && shifted) {
        e.preventDefault();
        redoLayout();
        return;
      }
      if (k === "r" && !shifted && restartShortcutEnabled) {
        e.preventDefault();
        const activeId = activePaneByWs[wsId];
        if (activeId) {
          invoke("restart_pane", { paneId: activeId }).catch((err) =>
            reportInvokeError("restart_pane", err),
          );
        }
        return;
      }
      if (e.key === "]" && !shifted) {
        e.preventDefault();
        cyclePane(wsId, 1);
        return;
      }
      if (e.key === "[" && !shifted) {
        e.preventDefault();
        cyclePane(wsId, -1);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    workspaces,
    activePaneByWs,
    restartShortcutEnabled,
    undoLayout,
    redoLayout,
  ]);
}
