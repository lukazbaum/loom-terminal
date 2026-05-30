import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { detectAgent } from "./agents";
import { AddShellsPrompt } from "./AddShellsPrompt";
import { getPaneWriter, shellQuotePath } from "./paneWriters";
import { AppHeader } from "./AppHeader";
import { ConfirmCloseModal } from "./ConfirmCloseModal";
import { ConfirmDialog } from "./ConfirmDialog";
import { shortenHome } from "./format";
import { KeyboardHelpOverlay } from "./KeyboardHelpOverlay";
import { mergeKeymap } from "./keybindings";
import { MainPanes } from "./MainPanes";
import { PaneContextMenu } from "./PaneContextMenu";
import { PortsPanel } from "./PortsPanel";
import { usePresets } from "./presets";
import { rememberRecentCommands } from "./recentCommands";
import {
  DEFAULT_TAB_ID,
  isSessionAgent,
  loadSession,
  saveSessionIdOverride,
  type SessionAgent,
} from "./sessionPersist";
import { playNotificationSound } from "./notificationSound";
import { useSettings } from "./settings";
import {
  Sidebar,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "./Sidebar";
import { applyTheme, getThemeOrDefault, useThemes } from "./themes";
import { pushToast, ToastViewport } from "./toast";
import { useAppShortcuts } from "./useAppShortcuts";
import { useLayoutHistory } from "./useLayoutHistory";
import { useSessionPersistence } from "./useSessionPersistence";
import { useTauriEvent } from "./useTauriEvent";
import {
  reorderWorkspaceInTab,
  useWorkspacesStore,
} from "./useWorkspacesStore";
import type { LaunchInput } from "./Welcome";
import { makePaneId, workspaceLabel } from "./WorkspaceTab";
import { tabLabel } from "./TabSwitcher";
import type { Pane, Session, WorkspaceTabMeta } from "./types";
import "./App.css";

type View = { kind: "workspace"; id: string } | { kind: "new" };

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isPanePinned(ws: Session, paneId: string): boolean {
  return !!ws.pinnedPaneIds?.includes(paneId);
}

// Map a hook-settings file path back to a user-facing agent label so the
// "hook upgraded" banner doesn't hardcode "Claude" for an event that
// fires for Claude / Codex / Gemini interchangeably.
function agentLabelFromHookPath(path: string): string {
  if (path.includes("/.codex/")) return "Codex";
  if (path.includes("/.gemini/")) return "Gemini";
  return "Claude";
}

function loadStoredWidth(): number {
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (!raw) return SIDEBAR_WIDTH_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n)
    ? clamp(n, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
    : SIDEBAR_WIDTH_DEFAULT;
}

function App() {
  // Hydrate workspaces / active selection from persisted session. If the
  // saved snapshot has any workspaces, we land directly on the last-active
  // one instead of showing the Welcome screen. Restored panes will respawn
  // their commands when the TerminalView mounts (PTY processes can't be
  // serialized, so this is "back to where you left off in shape, not in
  // mid-stream state").
  const persistedSession = useRef(loadSession()).current;
  const { workspaces, dispatch: dispatchWorkspaces } = useWorkspacesStore(
    persistedSession.workspaces.map((w) => ({
      id: w.id,
      path: w.path,
      name: w.name,
      tabId: w.tabId,
      pinnedPaneIds: w.pinnedPaneIds,
      gridCols: w.gridCols,
      gridRows: w.gridRows,
      idleQuietMs: w.idleQuietMs,
      panes: w.panes.map((p) => ({
        id: p.id,
        kind: p.kind,
        // Keep command canonical — `--resume <id>` is spliced at spawn
        // time inside TerminalView, never baked into persisted state.
        // That way a newer session id (e.g. after `/clear`) always wins
        // instead of being pinned by an old persisted command string.
        command: p.command,
        cwd: p.cwd,
        env: p.env,
        previewUrl: p.previewUrl,
        sessionId: p.sessionId,
        sessionAgent: p.sessionAgent,
      })),
    })),
  );
  // Layout-history snapshots replace the workspaces array wholesale,
  // so we adapt `dispatch` to a setWorkspaces-shaped callback for
  // useLayoutHistory.
  const replaceWorkspaces = useCallback(
    (next: Session[]) => dispatchWorkspaces({ type: "replace", next }),
    [dispatchWorkspaces],
  );
  // Mirror state into a ref so stable callbacks (e.g. activateWorkspace's
  // useCallback) can read the latest workspaces without listing them as a
  // dep and rebuilding on every shape edit.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  // ── Sidebar tabs ("pages") ─────────────────────────────────────────
  // Each tab owns its own workspace list — workspaces carry a `tabId` and
  // the sidebar shows only the active tab's. The flat `workspaces` array
  // stays the union of every tab so MainPanes keeps all terminals mounted
  // and background-tab agents keep running across tab switches.
  const [tabs, setTabs] = useState<WorkspaceTabMeta[]>(persistedSession.tabs);
  const initialActiveTabId =
    persistedSession.activeTabId &&
    persistedSession.tabs.some((t) => t.id === persistedSession.activeTabId)
      ? persistedSession.activeTabId
      : (persistedSession.tabs[0]?.id ?? DEFAULT_TAB_ID);
  const [activeTabId, setActiveTabId] = useState<string>(initialActiveTabId);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  // Mirror tabs into a ref so stable callbacks (delete / request-delete)
  // read the latest list without listing it as a dependency.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Per-tab memory of the last-active workspace, so switching back to a
  // tab restores where you were instead of its last workspace.
  const [activeWsByTab, setActiveWsByTab] = useState<Record<string, string>>(
    persistedSession.activeWsByTab ?? {},
  );
  const [tabToDelete, setTabToDelete] = useState<WorkspaceTabMeta | null>(null);

  const [workspaceMenu, setWorkspaceMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [addShellsPrompt, setAddShellsPrompt] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(
    null,
  );
  const startRenameWorkspace = useCallback((id: string) => {
    setWorkspaceMenu(null);
    setEditingWorkspaceId(id);
  }, []);
  const cancelRenameWorkspace = useCallback(() => {
    setEditingWorkspaceId(null);
  }, []);
  const commitRenameWorkspace = useCallback(
    (id: string, raw: string) => {
      const trimmed = raw.trim();
      dispatchWorkspaces({
        type: "rename",
        wsId: id,
        name: trimmed.length > 0 ? trimmed : undefined,
      });
      setEditingWorkspaceId(null);
    },
    [dispatchWorkspaces],
  );
  const requestWorkspaceMenu = useCallback(
    (id: string, x: number, y: number) => {
      setWorkspaceMenu({ id, x, y });
    },
    [],
  );
  const [view, setView] = useState<View>(() => {
    // Land inside the active tab only — its remembered (or last) workspace.
    const members = persistedSession.workspaces.filter(
      (w) => (w.tabId ?? DEFAULT_TAB_ID) === initialActiveTabId,
    );
    const last = members[members.length - 1];
    if (!last) return { kind: "new" };
    const wantedId =
      persistedSession.activeWsByTab?.[initialActiveTabId] ??
      persistedSession.activeWorkspaceId;
    const found =
      wantedId && members.some((w) => w.id === wantedId) ? wantedId : last.id;
    return { kind: "workspace", id: found };
  });
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
  );
  const [width, setWidth] = useState<number>(loadStoredWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
  // Per-pane unread tracking: workspace id → set of pane ids whose
  // last completion the user hasn't caught up on. Tracking at the
  // pane level (not the workspace level) means scrolling pane A2 to
  // the bottom doesn't clear an unseen completion in pane A1 — only
  // the pane that triggered the unread can clear its own entry.
  // The workspace tab pulses whenever its entry has any panes; once
  // every pane reaches the bottom (or the user activates the
  // workspace), the entry is removed.
  const [unread, setUnread] = useState<Map<string, Set<string>>>(
    () => new Map(),
  );
  // Parallel ref mirroring `unread` so callbacks can read the current
  // value synchronously. Needed by `markPaneUnread` to decide whether a
  // pane completion is genuinely new (and thus whether to play the
  // notification sound) without putting side effects inside a state
  // updater. Each mutation site below writes to both `setUnread` and
  // `unreadRef.current` to keep them aligned.
  const unreadRef = useRef<Map<string, Set<string>>>(unread);
  // Sidebar only needs to know "is this workspace's tab unread?", so
  // derive a Set of ids it can `has()`. Memoized on the underlying
  // Map identity so unrelated state churn doesn't rebuild it.
  const unreadWorkspaceIds = useMemo(() => new Set(unread.keys()), [unread]);
  /// Modal-page route. `null` = workspace view. `settings` and
  /// `themeEditor` are full-screen overlays; modeling them as one
  /// state field keeps the "open one, close the others" invariant
  /// from drifting as more pages are added.
  const [route, setRoute] = useState<"settings" | "themeEditor" | null>(null);
  const showSettings = route === "settings";
  const showThemeEditor = route === "themeEditor";
  const [activePaneByWs, setActivePaneByWs] = useState<Record<string, string>>(
    () => {
      // Restore active-pane-per-workspace, but only for entries that still
      // refer to a workspace+pane that exists in the restored state. Drops
      // any stale references silently.
      const out: Record<string, string> = {};
      const saved = persistedSession.activePaneByWs ?? {};
      for (const w of persistedSession.workspaces) {
        const wantedPane = saved[w.id];
        const valid =
          wantedPane && w.panes.some((p) => p.id === wantedPane)
            ? wantedPane
            : w.panes[0]?.id;
        if (valid) out[w.id] = valid;
      }
      return out;
    },
  );
  const [showPorts, setShowPorts] = useState<boolean>(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState<boolean>(false);
  // Per-pane "done" pill state lives inside Workspace itself —
  // owning it here meant every completion replaced the whole map and
  // re-rendered every workspace's entire pane grid.
  const settings = useSettings();
  const themes = useThemes();

  // Resolve the active theme reactively. The `find` returns the same
  // object reference as long as *this* theme's data didn't change —
  // edits to other custom themes recreate the registry array but leave
  // unaffected theme entries pointer-equal, so useMemo's output stays
  // stable and the dependent applyTheme effect doesn't re-fire on
  // unrelated theme edits.
  const activeTheme = useMemo(
    () =>
      themes.find((t) => t.id === settings.activeThemeId) ??
      getThemeOrDefault(settings.activeThemeId),
    [themes, settings.activeThemeId],
  );
  useEffect(() => {
    applyTheme(activeTheme);
  }, [activeTheme]);

  /// Effective keymap = built-in defaults overlaid with user overrides.
  /// Memoized on the overrides object so the dispatcher's parsing pass
  /// only re-runs when the user actually edits a binding.
  const keymap = useMemo(
    () => mergeKeymap(settings.keybindings),
    [settings.keybindings],
  );

  // App-level drag-drop listener. Tauri's `dragDropEnabled: true`
  // gives us the OS-level file path (WebKit strips it from
  // `dataTransfer.files`), but `ev.payload.position` on macOS with
  // our window config reports wrong y values, so we don't route by
  // drop coordinate — we route to the currently-focused pane in the
  // currently-active workspace. Click a pane, drop a file, path
  // appears there.
  //
  // One listener at the App level (instead of one per TerminalView):
  //   - No cross-workspace bug: with N per-pane listeners, every
  //     workspace's focused pane fired and wrote the path; here we
  //     dispatch to exactly one pane via the `paneWriters` registry.
  //   - No StrictMode-race "Unhandled Promise Rejection" spam: with
  //     a single listener, we only have one unlisten call to chase.
  //
  // Refs let the listener see the latest active workspace / active
  // pane without re-subscribing on every state change.
  const activePaneByWsRef = useRef(activePaneByWs);
  activePaneByWsRef.current = activePaneByWs;
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    win
      .onDragDropEvent((ev) => {
        if (cancelled) return;
        if (ev.payload.type !== "drop") return;
        const wsId = activeRef.current;
        if (!wsId) return;
        const paneId = activePaneByWsRef.current[wsId];
        if (!paneId) return;
        const write = getPaneWriter(paneId);
        if (!write) return;
        const paths = ev.payload.paths;
        if (!paths || paths.length === 0) return;
        write(paths.map(shellQuotePath).join(" ") + " ");
      })
      .then((u) => {
        // Wrap u() so a StrictMode mount→unmount→mount race in dev
        // doesn't surface as an "Unhandled Promise Rejection".
        // Tauri 2's `_unlisten` throws when the eventId has been
        // torn down already; we swallow that since the listener is
        // gone either way.
        const safeUnlisten = () => {
          try {
            const r = u() as unknown;
            if (
              r &&
              typeof r === "object" &&
              typeof (r as { then?: unknown }).then === "function"
            ) {
              (r as Promise<unknown>).catch(() => {});
            }
          } catch {
            // Already unregistered.
          }
        };
        if (cancelled) safeUnlisten();
        else unlisten = safeUnlisten;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[loom] failed to subscribe to drag-drop events", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ── Layout history (undo / redo) ─────────────────────────────────
  // Snapshots of `workspaces` taken before each add/close pane op (and
  // launchWorkspace / closeWorkspace). Tracking only the workspaces
  // shape covers the audit's intent: "Undo close pane X". Active
  // selection / split fractions live in their own state and are not
  // captured here. Implementation lives in `./useLayoutHistory`.
  const { captureLayoutSnapshot, undoLayout, redoLayout } = useLayoutHistory(
    workspacesRef,
    replaceWorkspaces,
  );

  // Detected dev-server URLs, surfaced as a toast under the title bar.
  // Backend's port detector fires `workspace-port-detected` once per URL
  // after a HEAD probe confirms the server is actually accepting
  // connections. We queue them — first in line is shown — so a burst
  // (multiple ports detected in quick succession) doesn't lose any.
  type DetectedPortEvent = {
    workspace_id: string;
    port: {
      pane_id: string;
      url: string;
      original_url: string;
      first_seen_ms: number;
      ready: boolean;
    };
  };
  const [portToasts, setPortToasts] = useState<DetectedPortEvent[]>([]);
  useTauriEvent<DetectedPortEvent>("workspace-port-detected", (e) => {
    setPortToasts((prev) => {
      // Dedup by URL — same event can fire if we re-detect after a restart.
      if (prev.some((p) => p.port.url === e.payload.port.url)) return prev;
      return [...prev, e.payload];
    });
  });

  // Agent session-id captures. The PTY reader emits this whenever a
  // `loom-session` OSC marker is parsed. Currently emitted by:
  //   - Claude Stop / SessionStart hook
  //   - Codex  Stop / SessionStart hook
  //   - Gemini SessionStart hook
  // We figure out which agent it is by inspecting the pane's current
  // command — if it's not a known resume-capable agent we ignore the
  // capture rather than persist an id we can't use.
  useTauriEvent<{ pane_id: string; session_id: string }>(
    "loom-session-captured",
    (e) => {
      const { pane_id, session_id } = e.payload;
      // Look up the pane's agent so the saveSessionIdOverride side
      // channel knows which slot to write into. Read via the ref so
      // we don't have to pull `workspaces` into the listener's deps.
      let agentForOverride: SessionAgent | null = null;
      for (const w of workspacesRef.current) {
        const pane = w.panes.find((p) => p.id === pane_id);
        if (!pane) continue;
        const detected = detectAgent(pane.command ?? "");
        // Default to "claude" when detection returns shell/custom —
        // e.g. a blank pane the user typed `claude` into manually.
        // Guessing wrong is safe: `sanitizePaneAgent` at load time
        // drops the id if the pane's command doesn't still match the
        // agent. Losing the id is worse than guessing.
        agentForOverride = isSessionAgent(detected) ? detected : "claude";
        break;
      }
      if (agentForOverride !== null) {
        dispatchWorkspaces({
          type: "patchPaneSession",
          paneId: pane_id,
          sessionId: session_id,
          agent: agentForOverride,
        });
        // Synchronously persist to a tiny override key — covers the
        // race where the user quits between this event firing and the
        // debounced shape-save committing the React state update.
        saveSessionIdOverride(pane_id, session_id, agentForOverride);
      }
    },
  );
  /// Slide the front toast off-screen. We do NOT call
  /// `dismiss_workspace_port` here — that would forget the port and the
  /// ports panel would show "0 detected". The panel has its own explicit
  /// dismiss that actually drops it from the backend.
  const dismissTopToast = () => {
    setPortToasts((prev) => (prev.length ? prev.slice(1) : prev));
  };

  // Session persistence: on-mount register + paths-exist warning, the
  // 1 s debounced shape save, the 200 ms selection save, and the
  // beforeunload flush all live in `./useSessionPersistence`.
  useSessionPersistence({
    persistedSession,
    workspaces,
    activeWorkspaceId: view.kind === "workspace" ? view.id : undefined,
    activePaneByWs,
    tabs,
    activeTabId,
    activeWsByTab,
  });
  const activeWorkspaceId = view.kind === "workspace" ? view.id : null;
  // activeRef tracks the *intended* active workspace. Updated
  // synchronously by setActiveView so a keyboard event firing in the
  // same tick as a workspace switch reads the new id, not the stale
  // closed-over `view`. Without this, ⌘N right after clicking a tab
  // would land the new pane in the previous workspace.
  const activeRef = useRef<string | null>(activeWorkspaceId);
  // Backstop: cover any setView path we missed.
  activeRef.current = activeWorkspaceId;
  const setActiveView = useCallback((next: View) => {
    activeRef.current = next.kind === "workspace" ? next.id : null;
    // Remember the active workspace for its tab so switching tabs returns
    // here later. Keyed by the workspace's own tab (not the active tab) so
    // it stays correct even if state is mid-transition.
    if (next.kind === "workspace") {
      const tid =
        workspacesRef.current.find((w) => w.id === next.id)?.tabId ??
        activeTabIdRef.current;
      setActiveWsByTab((prev) =>
        prev[tid] === next.id ? prev : { ...prev, [tid]: next.id },
      );
    }
    setView(next);
  }, []);
  const { presets, createPreset, updatePreset, deletePreset } = usePresets();

  const markPaneUnread = useCallback(
    (wsId: string, paneId: string, wasAtBottom: boolean) => {
      // Skip the pulse only when the user is actually looking at this
      // workspace AND was at the bottom of the relevant pane — they
      // saw the result, no need to nag. When they're on a different
      // workspace, or scrolled up in this one reading scrollback, the
      // tab pulses so they don't miss that Claude finished.
      if (activeRef.current === wsId && wasAtBottom) return;
      const existing = unreadRef.current.get(wsId);
      if (existing?.has(paneId)) return;
      const nextSet = new Set(existing ?? []);
      nextSet.add(paneId);
      const next = new Map(unreadRef.current);
      next.set(wsId, nextSet);
      unreadRef.current = next;
      setUnread(next);
      // Rides the same gate as the mint pulse above: we got past the
      // active-and-at-bottom early-return AND this is a fresh pane
      // completion (not a repeat). Sound is a no-op when disabled in
      // settings — checked inside `playNotificationSound`.
      playNotificationSound();
    },
    [],
  );

  /// Stable per-app handler for "this pane just finished a turn". Passed
  /// through Workspace to TerminalView. Workspace injects its own
  /// `workspaceId` so this can be a single shared identity for every pane
  /// across every workspace (the previous shape captured `w.id` in an
  /// inline arrow inside `.map()` and produced a fresh identity each
  /// parent render).
  const handlePaneCompletion = useCallback(
    (paneId: string, workspaceId: string, wasAtBottom: boolean) => {
      // The "done" pill is rendered locally by the workspace that owns
      // the pane; App's job here is just to pulse the sidebar tab.
      markPaneUnread(workspaceId, paneId, wasAtBottom);
    },
    [markPaneUnread],
  );

  const clearPaneUnread = useCallback((wsId: string, paneId: string) => {
    const existing = unreadRef.current.get(wsId);
    if (!existing?.has(paneId)) return;
    const nextSet = new Set(existing);
    nextSet.delete(paneId);
    const next = new Map(unreadRef.current);
    if (nextSet.size === 0) next.delete(wsId);
    else next.set(wsId, nextSet);
    unreadRef.current = next;
    setUnread(next);
  }, []);

  const clearWorkspaceUnread = useCallback((wsId: string) => {
    if (!unreadRef.current.has(wsId)) return;
    const next = new Map(unreadRef.current);
    next.delete(wsId);
    unreadRef.current = next;
    setUnread(next);
  }, []);

  /// Pane scrolled to the bottom — the user has caught up on whatever
  /// they were reading in *this* pane, so drop its entry. The workspace
  /// stops pulsing only when every pane with pending unread has been
  /// caught up on (i.e. its set becomes empty).
  const handlePaneReachedBottom = useCallback(
    (paneId: string, workspaceId: string) => {
      clearPaneUnread(workspaceId, paneId);
    },
    [clearPaneUnread],
  );

  const activateWorkspace = useCallback(
    (id: string) => {
      setActiveView({ kind: "workspace", id });
      clearWorkspaceUnread(id);
      setActivePaneByWs((prev) => {
        if (prev[id]) return prev;
        // Read latest workspaces via ref so this callback stays stable across
        // workspace shape edits — the WorkspaceTab memo would otherwise rebuild
        // every time anyone added or removed a pane.
        const ws = workspacesRef.current.find((w) => w.id === id);
        const firstPane = ws?.panes[0];
        if (!firstPane) return prev;
        return { ...prev, [id]: firstPane.id };
      });
    },
    [setActiveView, clearWorkspaceUnread],
  );

  const requestCloseWorkspace = useCallback((id: string) => {
    setCloseTargetId(id);
  }, []);

  // ── Tab actions ────────────────────────────────────────────────────
  /// Switch to a tab, landing on its remembered (or last) workspace. An
  /// empty tab drops to the new-workspace view. Background tabs' panes
  /// stay mounted, so their agents keep running.
  const switchTab = useCallback(
    (tabId: string) => {
      if (tabId === activeTabIdRef.current) return;
      setActiveTabId(tabId);
      const members = workspacesRef.current.filter(
        (w) => (w.tabId ?? DEFAULT_TAB_ID) === tabId,
      );
      const remembered = activeWsByTab[tabId];
      const target =
        remembered && members.some((w) => w.id === remembered)
          ? remembered
          : members.length > 0
            ? members[members.length - 1]!.id
            : null;
      if (target) activateWorkspace(target);
      else setActiveView({ kind: "new" });
    },
    [activeWsByTab, activateWorkspace, setActiveView],
  );

  const addTab = useCallback(() => {
    const newTab: WorkspaceTabMeta = { id: `tab_${crypto.randomUUID()}` };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
    // A fresh tab has no workspaces — land on the new-workspace view.
    setActiveView({ kind: "new" });
  }, [setActiveView]);

  const renameTab = useCallback((id: string, raw: string) => {
    const trimmed = raw.trim();
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, name: trimmed.length > 0 ? trimmed : undefined }
          : t,
      ),
    );
  }, []);

  /// Delete a tab and tear down every workspace it owns. Always leaves at
  /// least one tab; when the active tab is deleted, hands focus to a
  /// neighbor. Not snapshotted into layout-history undo — undo restores
  /// the workspaces array but not the tab list, which would orphan them.
  const performDeleteTab = useCallback(
    (id: string) => {
      const members = workspacesRef.current.filter(
        (w) => (w.tabId ?? DEFAULT_TAB_ID) === id,
      );
      const memberIds = new Set(members.map((w) => w.id));

      for (const w of members) {
        invoke("unregister_workspace", { workspaceId: w.id }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[loom] unregister_workspace failed", err);
        });
      }

      if (memberIds.size > 0) {
        dispatchWorkspaces({
          type: "replace",
          next: workspacesRef.current.filter((w) => !memberIds.has(w.id)),
        });
        // Drop closed workspaces' active-pane + unread bookkeeping.
        setActivePaneByWs((prev) => {
          let changed = false;
          const next: Record<string, string> = {};
          for (const [k, v] of Object.entries(prev)) {
            if (memberIds.has(k)) changed = true;
            else next[k] = v;
          }
          return changed ? next : prev;
        });
        let unreadChanged = false;
        const nextUnread = new Map(unreadRef.current);
        for (const wsId of memberIds) {
          if (nextUnread.delete(wsId)) unreadChanged = true;
        }
        if (unreadChanged) {
          unreadRef.current = nextUnread;
          setUnread(nextUnread);
        }
      }

      // Remove the tab, guaranteeing at least one always remains.
      const remainingTabs = tabsRef.current.filter((t) => t.id !== id);
      const nextTabs: WorkspaceTabMeta[] =
        remainingTabs.length > 0
          ? remainingTabs
          : [{ id: `tab_${crypto.randomUUID()}` }];
      setTabs(nextTabs);
      setActiveWsByTab((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _removed, ...rest } = prev;
        return rest;
      });

      // If the deleted tab was active, move to a neighbor and land on its
      // remembered / last workspace (or the new-workspace view).
      if (id === activeTabIdRef.current) {
        const deletedIdx = tabsRef.current.findIndex((t) => t.id === id);
        const neighbor =
          nextTabs[Math.min(Math.max(deletedIdx, 0), nextTabs.length - 1)]!;
        setActiveTabId(neighbor.id);
        const survivors = workspacesRef.current.filter(
          (w) =>
            !memberIds.has(w.id) && (w.tabId ?? DEFAULT_TAB_ID) === neighbor.id,
        );
        const remembered = activeWsByTab[neighbor.id];
        const target =
          remembered && survivors.some((w) => w.id === remembered)
            ? remembered
            : survivors.length > 0
              ? survivors[survivors.length - 1]!.id
              : null;
        if (target) activateWorkspace(target);
        else setActiveView({ kind: "new" });
      }
    },
    [dispatchWorkspaces, activeWsByTab, activateWorkspace, setActiveView],
  );

  /// Confirm only when the tab actually owns workspaces — an empty tab
  /// has nothing to lose, so it closes immediately.
  const requestDeleteTab = useCallback(
    (id: string) => {
      const hasWorkspaces = workspacesRef.current.some(
        (w) => (w.tabId ?? DEFAULT_TAB_ID) === id,
      );
      if (hasWorkspaces) {
        setTabToDelete(tabsRef.current.find((t) => t.id === id) ?? null);
      } else {
        performDeleteTab(id);
      }
    },
    [performDeleteTab],
  );

  const confirmDeleteTab = useCallback(() => {
    if (!tabToDelete) return;
    performDeleteTab(tabToDelete.id);
    setTabToDelete(null);
  }, [tabToDelete, performDeleteTab]);

  /// Gutter drop indicator — when the user drags over the empty space
  /// above the first tab or below the last tab, per-tab handlers can't
  /// fire (cursor isn't on any tab). The list container handles those
  /// cases and surfaces them here so we know which gutter line to render.
  const [gutterDropTarget, setGutterDropTarget] = useState<
    "top" | "bottom" | null
  >(null);

  /// Reorder a workspace in the sidebar. `to` is the insertion index in
  /// the pre-removal array (0..length), as produced by the drop handler
  /// from the cursor's "before vs after" position. A no-op for drops on
  /// the dragged tab itself (from === to or from === to - 1) keeps the
  /// debounced session save from firing on a non-change. Persistence
  /// piggybacks on the existing `[workspaces]` useEffect, so no extra
  /// save call is needed here.
  const moveWorkspace = useCallback(
    (from: number, to: number) => {
      // `from` / `to` index the active tab's filtered list (what the
      // sidebar renders), so reorder within that tab only — other tabs'
      // workspaces keep their global slots.
      dispatchWorkspaces({
        type: "replace",
        next: reorderWorkspaceInTab(
          workspacesRef.current,
          activeTabIdRef.current,
          from,
          to,
        ),
      });
    },
    [dispatchWorkspaces],
  );

  const activatePane = useCallback((wsId: string, paneId: string) => {
    setActivePaneByWs((prev) =>
      prev[wsId] === paneId ? prev : { ...prev, [wsId]: paneId },
    );
  }, []);

  /// Apply a fixed grid override (cols × rows) to one workspace. Stable
  /// callback identity so `<Workspace>` can stay memoized — the previous
  /// inline arrow at the call site captured `w.id` and re-created the
  /// prop on every App render.
  const setWorkspaceGrid = useCallback(
    (wsId: string, cols: number | undefined, rows: number | undefined) => {
      dispatchWorkspaces({ type: "setGrid", wsId, cols, rows });
    },
    [dispatchWorkspaces],
  );

  const addPane = (wsId: string) => {
    captureLayoutSnapshot();
    const newPane: Pane = { id: makePaneId() };
    dispatchWorkspaces({ type: "addPane", wsId, pane: newPane });
    setActivePaneByWs((prev) => ({ ...prev, [wsId]: newPane.id }));
  };

  /// Batched variant of `addPane` for the "Add N shells" workspace
  /// action. Appends `count` empty panes in one dispatch and promotes
  /// the last one to active. Single layout-snapshot capture keeps undo
  /// as one step rather than N.
  const addPanes = useCallback(
    (wsId: string, count: number) => {
      if (count < 1) return;
      captureLayoutSnapshot();
      const newPanes: Pane[] = Array.from({ length: count }, () => ({
        id: makePaneId(),
      }));
      dispatchWorkspaces({ type: "addPanes", wsId, panes: newPanes });
      const last = newPanes[newPanes.length - 1];
      if (last) {
        setActivePaneByWs((prev) => ({ ...prev, [wsId]: last.id }));
      }
    },
    [captureLayoutSnapshot, dispatchWorkspaces],
  );

  /// Spawn a fresh pane carrying the same launch shape (command / cwd / env)
  /// as `paneId`. Intentionally drops the agent session — duplicating gives
  /// the user a clean second seat for the same setup, not a clone of an
  /// already-running conversation.
  const duplicatePane = useCallback(
    (wsId: string, paneId: string) => {
      const ws = workspacesRef.current.find((w) => w.id === wsId);
      const src = ws?.panes.find((p) => p.id === paneId);
      if (!ws || !src) return;
      if ((src.kind ?? "terminal") !== "terminal") return;
      captureLayoutSnapshot();
      const newPane: Pane = {
        id: makePaneId(),
        command: src.command,
        cwd: src.cwd,
        env: src.env,
      };
      dispatchWorkspaces({ type: "addPane", wsId, pane: newPane });
      setActivePaneByWs((prev) => ({ ...prev, [wsId]: newPane.id }));
    },
    [captureLayoutSnapshot, dispatchWorkspaces],
  );

  /// Open a detected dev-server URL in a new in-app preview pane next to the
  /// terminal. If a preview pane for this URL already exists in the
  /// workspace, just focus it instead of creating a duplicate. Also flips
  /// the view to that workspace if the user is on a different one.
  const addPreviewPane = (wsId: string, url: string) => {
    const ws = workspacesRef.current.find((w) => w.id === wsId);
    if (!ws) return;
    const existing = ws.panes.find(
      (p) => p.kind === "preview" && p.previewUrl === url,
    );
    if (existing) {
      setActivePaneByWs((p) => ({ ...p, [wsId]: existing.id }));
    } else {
      const newPane: Pane = {
        id: makePaneId(),
        kind: "preview",
        previewUrl: url,
      };
      dispatchWorkspaces({ type: "addPreviewPane", wsId, url, pane: newPane });
      setActivePaneByWs((p) => ({ ...p, [wsId]: newPane.id }));
    }
    // The previewed workspace may live on a background tab (a dev server
    // started by another tab's agent keeps running). Follow it with the
    // active tab so the sidebar list + tab strip stay in sync with the
    // workspace we're about to show.
    const targetTabId = ws.tabId ?? DEFAULT_TAB_ID;
    if (targetTabId !== activeTabIdRef.current) setActiveTabId(targetTabId);
    setActiveView({ kind: "workspace", id: wsId });
  };

  const performClosePane = useCallback(
    (wsId: string, paneId: string) => {
      const ws = workspacesRef.current.find((w) => w.id === wsId);
      if (!ws) return;
      const idx = ws.panes.findIndex((p) => p.id === paneId);
      if (idx < 0) return;
      captureLayoutSnapshot();
      const remaining = ws.panes.filter((p) => p.id !== paneId);
      const nextActive = remaining[Math.min(idx, remaining.length - 1)];
      dispatchWorkspaces({ type: "removePane", wsId, paneId });
      // Drop any pending unread entry for the closed pane — without
      // this, a stale paneId would keep the workspace tab pulsing
      // forever (no `onReachedBottom` will ever fire for a gone pane).
      clearPaneUnread(wsId, paneId);
      if (nextActive) {
        setActivePaneByWs((prev) => ({ ...prev, [wsId]: nextActive.id }));
      }
    },
    [captureLayoutSnapshot, dispatchWorkspaces, clearPaneUnread],
  );

  const togglePinPane = useCallback(
    (wsId: string, paneId: string) => {
      dispatchWorkspaces({ type: "togglePin", wsId, paneId });
    },
    [dispatchWorkspaces],
  );

  const closePane = useCallback(
    (wsId: string, paneId: string) => {
      // Read workspaces via the ref so this callback's identity stays
      // stable across pane mutations. Without that, every pane add /
      // remove would re-create closePane and bust Workspace's React.memo.
      const ws = workspacesRef.current.find((w) => w.id === wsId);
      if (!ws) return;
      if (isPanePinned(ws, paneId)) {
        pushToast(
          "This pane is pinned. Unpin it from the right-click menu before closing.",
          { kind: "warn" },
        );
        return;
      }
      if (ws.panes.length <= 1) {
        // Closing the last pane closes the workspace — funnel through
        // the confirm modal so the user has a chance to back out.
        setCloseTargetId(wsId);
        return;
      }
      performClosePane(wsId, paneId);
    },
    [performClosePane],
  );

  const cyclePane = (wsId: string, dir: 1 | -1) => {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws || ws.panes.length < 2) return;
    const firstPane = ws.panes[0];
    if (!firstPane) return;
    const activeId = activePaneByWs[wsId] ?? firstPane.id;
    const idx = ws.panes.findIndex((p) => p.id === activeId);
    if (idx < 0) return;
    const nextIdx = (idx + dir + ws.panes.length) % ws.panes.length;
    const nextPane = ws.panes[nextIdx];
    if (!nextPane) return;
    setActivePaneByWs((prev) => ({ ...prev, [wsId]: nextPane.id }));
  };

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // ignore quota / disabled storage
      }
      return next;
    });
  };

  // Keep the CSS variable in sync with React state. The nav element reads
  // its width from `var(--loom-sidebar-width)` — by writing the variable
  // imperatively during a drag we avoid forcing App-tree re-renders on
  // every mousemove (the audit traced this to ~2k renders per 3-second
  // drag because App.tsx is enormous).
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--loom-sidebar-width",
      `${width}px`,
    );
    widthRef.current = width;
  }, [width]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    let lastWidth = startWidth;
    const onMove = (ev: MouseEvent) => {
      const next = clamp(
        startWidth + (ev.clientX - startX),
        SIDEBAR_WIDTH_MIN,
        SIDEBAR_WIDTH_MAX,
      );
      lastWidth = next;
      document.documentElement.style.setProperty(
        "--loom-sidebar-width",
        `${next}px`,
      );
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizing(false);
      setWidth(lastWidth);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(lastWidth));
      } catch {
        // ignore quota / disabled storage
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const launchWorkspace = (input: LaunchInput) => {
    captureLayoutSnapshot();
    const id = `ws_${crypto.randomUUID()}`;
    const panes: Pane[] = Array.from({ length: input.count }).map((_, i) => ({
      id: makePaneId(),
      command: input.commands?.[i],
    }));
    const next: Session = {
      id,
      path: input.path,
      name: input.name,
      tabId: activeTabIdRef.current,
      panes,
    };
    dispatchWorkspaces({ type: "add", workspace: next });
    setActivePaneByWs((prev) => ({ ...prev, [id]: panes[0]?.id ?? "" }));
    setActiveView({ kind: "workspace", id });
    invoke("register_workspace", { workspaceId: id, path: input.path }).catch(
      (err) => {
        // Soft failure: MCP tools (which look workspaces up by id) will
        // miss this workspace until the next register attempt. Surface
        // to the console so the failure mode has a breadcrumb, but
        // don't toast — the user just launched a workspace and a
        // "registration failed" toast is more confusing than helpful.
        // eslint-disable-next-line no-console
        console.warn("[loom] register_workspace failed", err);
      },
    );
    rememberRecentCommands(input.commands);
    // Cheap free-disk probe; warns once if the workspace is on a drive
    // with less than 500 MB free.
    invoke<{ free_bytes: number | null }>("workspace_disk_space", {
      workspaceId: id,
    })
      .then((res) => {
        const free = res.free_bytes;
        if (typeof free === "number" && free < 500 * 1024 * 1024) {
          const mb = (free / (1024 * 1024)).toFixed(0);
          pushToast(
            `Low disk space on this workspace's drive (${mb} MB free). Agents may misbehave.`,
            { kind: "warn", timeoutMs: 8000 },
          );
        }
      })
      .catch((err) => {
        // Probe failure is expected on weird filesystems (`df` unsupported)
        // and shouldn't toast the user — but log so a real regression
        // doesn't disappear silently.
        // eslint-disable-next-line no-console
        console.warn("[loom] workspace_disk_space probe failed", err);
      });
  };

  const closeWorkspace = (id: string) => {
    captureLayoutSnapshot();
    // Re-target the active view before the dispatch so the active
    // workspace doesn't briefly point at a session that's just been
    // removed (would surface as a one-frame "workspace not found"
    // flash on the next render).
    if (view.kind === "workspace" && view.id === id) {
      // Stay inside the closed workspace's tab — jump to its last
      // sibling, or the new-workspace view if it was the tab's last.
      const tid =
        workspacesRef.current.find((w) => w.id === id)?.tabId ?? DEFAULT_TAB_ID;
      const siblings = workspacesRef.current.filter(
        (w) => w.id !== id && (w.tabId ?? DEFAULT_TAB_ID) === tid,
      );
      const last = siblings[siblings.length - 1];
      if (!last) setActiveView({ kind: "new" });
      else setActiveView({ kind: "workspace", id: last.id });
    }
    dispatchWorkspaces({ type: "remove", wsId: id });
    clearWorkspaceUnread(id);
    setActivePaneByWs((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
    // Drop any per-tab "remembered active workspace" pointer at the closed
    // id so it doesn't linger as dead state in localStorage. Reads of this
    // map are already existence-checked, so this is hygiene, not a fix for
    // a live bug.
    setActiveWsByTab((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [tid, wsId] of Object.entries(prev)) {
        if (wsId === id) changed = true;
        else next[tid] = wsId;
      }
      return changed ? next : prev;
    });
    invoke("unregister_workspace", { workspaceId: id }).catch((err) => {
      // The frontend has already removed the workspace from state, so
      // for the user the close is a done deal — but if the backend
      // hangs on to the entry we'll keep emitting events for it. Log
      // so a stuck backend state has a breadcrumb.
      // eslint-disable-next-line no-console
      console.warn("[loom] unregister_workspace failed", err);
    });
  };

  // Banner shown when any of the configure_*_notification_hook installers
  // upgraded an existing hook entry on app start. Already-running agent
  // processes have the OLD hook cached in their settings.json snapshot —
  // the user has to restart those panes to get the new behavior.
  //
  // The payload carries the rewritten settings path, which we map to a
  // friendly agent label so the banner copy isn't Claude-only.
  const [hookUpgraded, setHookUpgraded] = useState<string | null>(null);
  useTauriEvent<{ path: string }>("loom-hook-upgraded", (e) => {
    setHookUpgraded(agentLabelFromHookPath(e.payload.path));
  });

  // Surface backend hook-setup failure as a toast. Without this, a
  // missing/un-writable settings file silently disables the completion
  // trigger and the agent appears to hang.
  useTauriEvent<{ error: string; agent?: string }>("loom-hook-failed", (e) => {
    const agent = e.payload.agent ?? "agent";
    pushToast(
      `Couldn't configure the ${agent} notification hook: ${e.payload.error}. Completion pings will fall back to a silence-based heuristic.`,
      { kind: "warn", timeoutMs: 12000 },
    );
  });

  // All top-level keyboard shortcuts (capture-phase chords that xterm
  // would otherwise swallow + ⌘-modified app shortcuts) live in
  // `./useAppShortcuts`.
  useAppShortcuts({
    activeWorkspaceIdRef: activeRef,
    workspacesRef,
    workspaces,
    activeTabId,
    activeTabIdRef,
    activePaneByWs,
    keymap,
    restartShortcutEnabled: settings.restartShortcutEnabled,
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
  });

  const isNewView = view.kind === "new";

  // Workspaces belonging to the active tab — what the sidebar shows.
  // MainPanes still receives the full `workspaces` union so every tab's
  // terminals stay mounted.
  const tabWorkspaces = useMemo(
    () => workspaces.filter((w) => (w.tabId ?? DEFAULT_TAB_ID) === activeTabId),
    [workspaces, activeTabId],
  );

  const activeWorkspace =
    view.kind === "workspace"
      ? (workspaces.find((w) => w.id === view.id) ?? null)
      : null;
  // Number the workspace within ITS OWN tab, not the active tab. The two
  // usually coincide, but a path that focuses a background-tab workspace
  // (e.g. previewing a port from another tab) would otherwise miss in the
  // active-tab list and render "Workspace 00" (pad2(-1 + 1)) in the header.
  const activeWorkspaceIdx = activeWorkspace
    ? workspaces
        .filter(
          (w) =>
            (w.tabId ?? DEFAULT_TAB_ID) ===
            (activeWorkspace.tabId ?? DEFAULT_TAB_ID),
        )
        .findIndex((w) => w.id === activeWorkspace.id)
    : -1;
  const headerLabel = showSettings
    ? "Settings"
    : activeWorkspace
      ? workspaceLabel(activeWorkspace, activeWorkspaceIdx)
      : isNewView
        ? "New workspace"
        : "Loom";
  const headerPath =
    !showSettings && activeWorkspace ? shortenHome(activeWorkspace.path) : "";

  return (
    <div className="flex h-screen flex-col bg-ink-0">
      <AppHeader
        headerLabel={headerLabel}
        headerPath={headerPath}
        viewKind={view.kind}
        showPorts={showPorts}
        showSettings={showSettings}
        onOpenPorts={() => setShowPorts(true)}
        onOpenSettings={() => setRoute("settings")}
        hookUpgraded={hookUpgraded}
        onDismissHookBanner={() => setHookUpgraded(null)}
        portToasts={portToasts}
        onPreviewPort={addPreviewPane}
        onDismissTopPort={dismissTopToast}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          workspaces={tabWorkspaces}
          activeWorkspaceId={view.kind === "workspace" ? view.id : null}
          isNewView={isNewView}
          unread={unreadWorkspaceIds}
          collapsed={collapsed}
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={switchTab}
          onAddTab={addTab}
          onRenameTab={renameTab}
          onRequestDeleteTab={requestDeleteTab}
          resizing={resizing}
          gutterDropTarget={gutterDropTarget}
          setGutterDropTarget={setGutterDropTarget}
          editingWorkspaceId={editingWorkspaceId}
          onNewWorkspace={() => setActiveView({ kind: "new" })}
          onToggleCollapsed={toggleCollapsed}
          onResetWidth={() => {
            setWidth(SIDEBAR_WIDTH_DEFAULT);
            try {
              localStorage.setItem(
                SIDEBAR_WIDTH_KEY,
                String(SIDEBAR_WIDTH_DEFAULT),
              );
            } catch {
              // ignore quota / disabled storage
            }
          }}
          onStartResize={startResize}
          onActivateWorkspace={activateWorkspace}
          onRequestCloseWorkspace={requestCloseWorkspace}
          onRequestWorkspaceMenu={requestWorkspaceMenu}
          onStartRename={startRenameWorkspace}
          onCommitRename={commitRenameWorkspace}
          onCancelRename={cancelRenameWorkspace}
          onMoveWorkspace={moveWorkspace}
        />

        <MainPanes
          workspaces={workspaces}
          activeWorkspaceId={view.kind === "workspace" ? view.id : null}
          isNewView={isNewView}
          activePaneByWs={activePaneByWs}
          activatePane={activatePane}
          closePane={closePane}
          togglePinPane={togglePinPane}
          duplicatePane={duplicatePane}
          handlePaneCompletion={handlePaneCompletion}
          handlePaneReachedBottom={handlePaneReachedBottom}
          presets={presets}
          onLaunch={launchWorkspace}
          onSavePreset={createPreset}
          onUpdatePreset={updatePreset}
          onDeletePreset={deletePreset}
          onCancelWelcome={(() => {
            const last = tabWorkspaces[tabWorkspaces.length - 1];
            if (!last) return undefined;
            return () => setActiveView({ kind: "workspace", id: last.id });
          })()}
          showSettings={showSettings}
          showThemeEditor={showThemeEditor}
          onSettingsClose={() => setRoute(null)}
          onThemeEditorOpen={() => setRoute("themeEditor")}
          onThemeEditorClose={() => setRoute(null)}
        />
      </div>

      {(() => {
        if (!closeTargetId) return null;
        const idx = workspaces.findIndex((w) => w.id === closeTargetId);
        if (idx < 0) return null;
        const target = workspaces[idx];
        if (!target) return null;
        return (
          <ConfirmCloseModal
            label={workspaceLabel(target, idx)}
            shellCount={target.panes.length}
            workspaceId={closeTargetId}
            onCancel={() => setCloseTargetId(null)}
            onConfirm={() => {
              closeWorkspace(closeTargetId);
              setCloseTargetId(null);
            }}
          />
        );
      })()}
      {tabToDelete &&
        (() => {
          const idx = Math.max(
            0,
            tabs.findIndex((t) => t.id === tabToDelete.id),
          );
          const count = workspaces.filter(
            (w) => (w.tabId ?? DEFAULT_TAB_ID) === tabToDelete.id,
          ).length;
          return (
            <ConfirmDialog
              title={`Close ${tabLabel(tabToDelete, idx)}?`}
              tone="danger"
              confirmLabel="Close tab"
              body={`This tab has ${count} workspace${
                count === 1 ? "" : "s"
              }. Closing it terminates ${
                count === 1 ? "its" : "their"
              } running shells. This can't be undone.`}
              onCancel={() => setTabToDelete(null)}
              onConfirm={confirmDeleteTab}
            />
          );
        })()}
      {showPorts && view.kind === "workspace" && (
        <PortsPanel
          workspaceId={view.id}
          onClose={() => setShowPorts(false)}
          onPreview={(url) => addPreviewPane(view.id, url)}
        />
      )}
      {showShortcutHelp && (
        <KeyboardHelpOverlay
          keymap={keymap}
          onClose={() => setShowShortcutHelp(false)}
        />
      )}
      {workspaceMenu && (
        <PaneContextMenu
          items={[
            {
              id: "rename",
              label: "Rename workspace…",
              onClick: () => startRenameWorkspace(workspaceMenu.id),
            },
            {
              id: "add-shells",
              label: "Add shells…",
              onClick: () =>
                setAddShellsPrompt({
                  id: workspaceMenu.id,
                  x: workspaceMenu.x,
                  y: workspaceMenu.y,
                }),
            },
            {
              id: "grid-auto",
              label: "Grid: auto-fit",
              onClick: () =>
                setWorkspaceGrid(workspaceMenu.id, undefined, undefined),
            },
            {
              id: "grid-2x2",
              label: "Grid: 2×2",
              onClick: () => setWorkspaceGrid(workspaceMenu.id, 2, 2),
            },
            {
              id: "grid-3x2",
              label: "Grid: 3×2",
              onClick: () => setWorkspaceGrid(workspaceMenu.id, 3, 2),
            },
          ]}
          x={workspaceMenu.x}
          y={workspaceMenu.y}
          onClose={() => setWorkspaceMenu(null)}
        />
      )}
      {addShellsPrompt && (
        <AddShellsPrompt
          x={addShellsPrompt.x}
          y={addShellsPrompt.y}
          onSubmit={(count) => addPanes(addShellsPrompt.id, count)}
          onClose={() => setAddShellsPrompt(null)}
        />
      )}
      <ToastViewport />
    </div>
  );
}

export default App;
