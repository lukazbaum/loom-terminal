import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useMemo,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  ACTION_IDS,
  type ActionId,
  type Chord,
  type Keymap,
  isDispatchLocked,
  matchesChord,
  parseChord,
} from "./keybindings";
import { isMac } from "./platform";
import { DEFAULT_TAB_ID } from "./sessionPersist";
import { reportInvokeError } from "./toast";
import type { Session } from "./types";

type View = { kind: "workspace"; id: string } | { kind: "new" };

type Args = {
  /// Refs feeding the listener. Read via `.current` so the handler
  /// always sees fresh state without forcing a re-bind on every
  /// workspace mutation.
  activeWorkspaceIdRef: MutableRefObject<string | null>;
  workspacesRef: MutableRefObject<Session[]>;

  /// Live state that's read directly (not via ref). Listed in the
  /// effect's dep list so a workspace add/remove or pane-active change
  /// re-binds — those events happen rarely compared to the keystroke
  /// rate that drove the ref pattern in the first place.
  workspaces: Session[];
  /// Active sidebar tab. Workspace navigation (next/prev/move, ⌘1-9) is
  /// scoped to this tab's workspaces, matching what the sidebar shows.
  activeTabId: string;
  activeTabIdRef: MutableRefObject<string>;
  activePaneByWs: Record<string, string>;
  keymap: Keymap;
  restartShortcutEnabled: boolean;

  // ── Mutators / dispatchers ─────────────────────────────────────────
  setActivePaneByWs: Dispatch<SetStateAction<Record<string, string>>>;
  setShowShortcutHelp: Dispatch<SetStateAction<boolean>>;
  setActiveView: (next: View) => void;
  setCloseTargetId: Dispatch<SetStateAction<string | null>>;
  setRoute: Dispatch<SetStateAction<"settings" | "themeEditor" | null>>;
  toggleCollapsed: () => void;

  // ── Workspace / pane actions ──────────────────────────────────────
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
/// One capture-phase listener handles everything. Capture phase runs
/// before xterm.js sees the event, which matters on Windows/Linux where
/// `Ctrl+letter` would otherwise be consumed by the terminal as a
/// control character (Ctrl+N → ^N). When we don't claim the event, we
/// let it propagate so the terminal still receives ordinary input.
///
/// Action dispatch is data-driven: iterate over `keymap`, match each
/// chord against the event, fire the first handler that hits. The two
/// digit-range patterns (Mod+1..9, Alt+1..9) stay hardcoded because
/// they're patterns rather than individual bindings; both still go
/// through the same OS-aware modifier check as customizable chords.
export function useAppShortcuts({
  activeWorkspaceIdRef,
  workspacesRef,
  workspaces,
  activeTabId,
  activeTabIdRef,
  activePaneByWs,
  keymap,
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
  /// Parse the keymap once per change. Parsing on every keystroke would
  /// re-run a few hundred regex+split operations per chord; this caches
  /// the parsed form so the hot path is just a memo lookup + comparison.
  const parsedKeymap = useMemo(() => {
    const out = {} as Record<ActionId, Chord[]>;
    for (const id of ACTION_IDS) {
      out[id] = keymap[id]
        .map(parseChord)
        .filter((c): c is Chord => c !== null);
    }
    return out;
  }, [keymap]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: handler closes over many in-scope helpers (activateWorkspace, closePane, ...) that themselves capture state listed in the dep array; refactoring to a ref bag would be honest but is deferred
  useEffect(() => {
    const handlers: Record<ActionId, () => boolean> = {
      "workspace.new": () => {
        setActiveView({ kind: "new" });
        return true;
      },
      "workspace.close": () => {
        if (!activeWorkspaceIdRef.current) return false;
        setCloseTargetId(activeWorkspaceIdRef.current);
        return true;
      },
      "workspace.next": () => {
        const members = workspaces.filter(
          (w) => (w.tabId ?? DEFAULT_TAB_ID) === activeTabId,
        );
        if (members.length < 2) return false;
        const cur = activeWorkspaceIdRef.current;
        if (!cur) return false;
        const idx = members.findIndex((w) => w.id === cur);
        const target =
          idx >= 0 ? members[(idx + 1) % members.length] : undefined;
        if (!target) return false;
        activateWorkspace(target.id);
        return true;
      },
      "workspace.prev": () => {
        const members = workspaces.filter(
          (w) => (w.tabId ?? DEFAULT_TAB_ID) === activeTabId,
        );
        if (members.length < 2) return false;
        const cur = activeWorkspaceIdRef.current;
        if (!cur) return false;
        const idx = members.findIndex((w) => w.id === cur);
        const target =
          idx >= 0
            ? members[(idx - 1 + members.length) % members.length]
            : undefined;
        if (!target) return false;
        activateWorkspace(target.id);
        return true;
      },
      "workspace.moveUp": () => {
        const cur = activeWorkspaceIdRef.current;
        if (!cur) return false;
        // moveWorkspace indexes the active tab's filtered list.
        const members = workspacesRef.current.filter(
          (w) => (w.tabId ?? DEFAULT_TAB_ID) === activeTabIdRef.current,
        );
        const idx = members.findIndex((w) => w.id === cur);
        if (idx <= 0) return false;
        moveWorkspace(idx, idx - 1);
        return true;
      },
      "workspace.moveDown": () => {
        const cur = activeWorkspaceIdRef.current;
        if (!cur) return false;
        const members = workspacesRef.current.filter(
          (w) => (w.tabId ?? DEFAULT_TAB_ID) === activeTabIdRef.current,
        );
        const idx = members.findIndex((w) => w.id === cur);
        if (idx < 0 || idx >= members.length - 1) return false;
        // moveWorkspace's `to` is the destination index in the pre-removal
        // list (see its `adjusted = from < to ? to - 1 : to` math): the
        // down-one target is `idx + 2`.
        moveWorkspace(idx, idx + 2);
        return true;
      },
      "pane.new": () => {
        const wsId = activeWorkspaceIdRef.current;
        if (!wsId) return false;
        addPane(wsId);
        return true;
      },
      "pane.splitHorizontal": () => {
        const wsId = activeWorkspaceIdRef.current;
        if (!wsId) return false;
        // The current layout is a uniform grid — both split actions just
        // append a pane. True directional splits would need a tree layout.
        addPane(wsId);
        return true;
      },
      "pane.splitVertical": () => {
        const wsId = activeWorkspaceIdRef.current;
        if (!wsId) return false;
        addPane(wsId);
        return true;
      },
      "pane.close": () => {
        const wsId = activeWorkspaceIdRef.current;
        if (!wsId) return false;
        const activeId = activePaneByWs[wsId];
        if (!activeId) return false;
        closePane(wsId, activeId);
        return true;
      },
      "pane.next": () => {
        const wsId = activeWorkspaceIdRef.current;
        if (!wsId) return false;
        cyclePane(wsId, 1);
        return true;
      },
      "pane.prev": () => {
        const wsId = activeWorkspaceIdRef.current;
        if (!wsId) return false;
        cyclePane(wsId, -1);
        return true;
      },
      "pane.restart": () => {
        if (!restartShortcutEnabled) return false;
        const wsId = activeWorkspaceIdRef.current;
        if (!wsId) return false;
        const activeId = activePaneByWs[wsId];
        if (!activeId) return false;
        invoke("restart_pane", { paneId: activeId }).catch((err) =>
          reportInvokeError("restart_pane", err),
        );
        return true;
      },
      "layout.undo": () => {
        undoLayout();
        return true;
      },
      "layout.redo": () => {
        redoLayout();
        return true;
      },
      "view.toggleSidebar": () => {
        toggleCollapsed();
        return true;
      },
      "view.settings": () => {
        setRoute((prev) => (prev === "settings" ? null : "settings"));
        return true;
      },
      "view.help": () => {
        setShowShortcutHelp((prev) => !prev);
        return true;
      },
    };

    const onKey = (e: KeyboardEvent) => {
      // A focused chord recorder (Settings page) pauses dispatch while
      // capturing the user's next keystroke.
      if (isDispatchLocked()) return;

      const target = e.target as HTMLElement | null;
      const inField =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // ── Customizable actions ────────────────────────────────────────
      for (const id of ACTION_IDS) {
        const chords = parsedKeymap[id];
        for (const chord of chords) {
          if (!matchesChord(e, chord)) continue;
          // Chords without a primary modifier (Mod/Ctrl) are skipped
          // inside text fields so the user can still type — otherwise
          // a `?` shortcut would steal the question-mark keystroke.
          if (inField && !chord.mod && !chord.ctrl) return;
          if (handlers[id]()) {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
      }

      // ── Static digit ranges (not customizable) ──────────────────────
      // Mod+Digit1..9 → switch workspace. Mod is ⌘ on macOS, Ctrl on
      // Windows/Linux. Win-key on Win/Linux is ignored.
      const modOnly = isMac
        ? e.metaKey && !e.altKey && !e.ctrlKey
        : e.ctrlKey && !e.altKey && !e.metaKey;
      if (modOnly && !e.shiftKey) {
        const m = /^Digit([1-9])$/.exec(e.code);
        const digit = m?.[1];
        if (digit) {
          // Scope to the active tab's workspaces so ⌘1-9 matches the
          // visible sidebar order, not the cross-tab global array.
          const members = workspacesRef.current.filter(
            (w) => (w.tabId ?? DEFAULT_TAB_ID) === activeTabIdRef.current,
          );
          const idx = parseInt(digit, 10) - 1;
          const target = members[idx];
          if (target) {
            e.preventDefault();
            e.stopPropagation();
            activateWorkspace(target.id);
          }
          return;
        }
      }

      // Alt+Digit1..9 → focus pane by index in the active workspace.
      // `e.code` dodges the Option-key symbol mapping on macOS
      // (Option+1 = ¡), letting us claim by physical key position.
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
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
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    workspaces,
    activeTabId,
    activePaneByWs,
    parsedKeymap,
    restartShortcutEnabled,
    undoLayout,
    redoLayout,
    moveWorkspace,
  ]);
}
