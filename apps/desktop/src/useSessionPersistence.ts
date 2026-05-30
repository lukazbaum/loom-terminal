import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import { detectAgent } from "./agents";
import {
  isSessionAgent,
  type PersistedSession,
  sanitizePaneAgent,
  saveSession,
  saveSessionSelection,
  saveSessionShape,
} from "./sessionPersist";
import { pushToast } from "./toast";
import type { Session, WorkspaceTabMeta } from "./types";

type Args = {
  /// Snapshot loaded once at App mount via `loadSession()`. The on-mount
  /// effects use it (not the live `workspaces` state) so we don't
  /// register / probe workspaces that the user has since closed.
  persistedSession: PersistedSession;
  /// Live state — drives the debounced shape save.
  workspaces: Session[];
  /// Active workspace's id (`view.kind === "workspace" ? view.id :
  /// undefined`). Computed by App so the hook stays View-type-agnostic.
  activeWorkspaceId: string | undefined;
  /// Active pane per workspace — saved with `activeWorkspaceId` under
  /// the small selection key.
  activePaneByWs: Record<string, string>;
  /// Sidebar tabs (id + optional name), in display order. Part of the
  /// shape save so renaming / adding / removing a tab persists even when
  /// no workspace changed.
  tabs: WorkspaceTabMeta[];
  /// Currently-open tab + per-tab last-active workspace. Selection-sized,
  /// so they ride the fast selection save.
  activeTabId: string;
  activeWsByTab: Record<string, string>;
};

/// All session-persistence side effects, lifted out of App.tsx:
///
///  1. On-mount: re-register restored workspaces with the backend and
///     warn about ones whose path no longer exists on disk.
///  2. 1 s debounced save of the workspace *shape* (the big blob) keyed
///     on `workspaces`. Enriches each pane with the backend's live
///     `claude_session_id` so the next launch can `--resume <id>`.
///  3. 200 ms debounced save of the *selection* (tiny key) keyed on
///     active workspace + per-workspace active pane.
///  4. `beforeunload` synchronous flush — saves whatever's in state with
///     no async round-trip, kept current via a ref so the listener
///     binds exactly once per mount.
///
/// No return value: every output is a side effect on localStorage or
/// the backend. Errors from `invoke` are deliberately swallowed at the
/// edges — a failed persistence write is annoying but not user-fatal,
/// and the warn-channel noise from "tried to save and we're quitting"
/// hurts more than it helps.
export function useSessionPersistence({
  persistedSession,
  workspaces,
  activeWorkspaceId,
  activePaneByWs,
  tabs,
  activeTabId,
  activeWsByTab,
}: Args): void {
  // Re-register restored workspaces with the backend so MCP tools can
  // find them. Idempotent — safe to call repeatedly. Runs once per
  // restored workspace at App mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — persistedSession is the initial-load snapshot captured at mount, intentionally not reactive
  useEffect(() => {
    for (const w of persistedSession.workspaces) {
      invoke("register_workspace", { workspaceId: w.id, path: w.path }).catch(
        () => {},
      );
    }
  }, []);

  // Verify restored workspace paths still exist on disk. Without this,
  // a deleted/moved folder surfaces as a cryptic spawn error per pane
  // instead of one upfront warning. Best-effort: backend failures are
  // swallowed (we'd rather miss the warning than fail to open the app).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — uses the load-time snapshot, not the live workspaces state
  useEffect(() => {
    const restored = persistedSession.workspaces;
    if (restored.length === 0) return;
    const paths = restored.map((w) => w.path);
    invoke<boolean[]>("paths_exist", { paths })
      .then((flags) => {
        if (!Array.isArray(flags)) return;
        const missing: string[] = [];
        restored.forEach((w, i) => {
          if (flags[i] === false) {
            missing.push(w.name ?? w.path);
          }
        });
        if (missing.length === 0) return;
        const label = missing.length === 1 ? "Workspace" : "Workspaces";
        pushToast(
          `${label} missing on disk: ${missing.slice(0, 3).join(", ")}${
            missing.length > 3 ? ` (+${missing.length - 3} more)` : ""
          }. Panes will fail to spawn — close the workspace or restore the folder.`,
          { kind: "warn", timeoutMs: 14000 },
        );
      })
      .catch(() => {});
  }, []);

  // Workspace-shape persistence. Debounced to 1 s and gated on actual
  // shape changes so a pane click no longer triggers a 20-pane
  // stringify. Selection (view + activePaneByWs) is persisted by the
  // separate effect below — keying this one on `workspaces` alone is
  // the whole point.
  //
  // The active-workspace id IS captured at the time of save but
  // intentionally NOT in the dep list: a workspace-tab click that
  // doesn't mutate the shape should fire only the selection save, not
  // this one.
  const activeIdRef = useRef(activeWorkspaceId);
  activeIdRef.current = activeWorkspaceId;
  // activeTabId is selection-sized and saved by the selection effect, but
  // it also rides along in the shape blob so a shape-triggering change
  // (e.g. launching a workspace) stamps the right open-tab. Read via ref
  // so a bare tab switch doesn't re-arm this heavier save.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  useEffect(() => {
    const handle = window.setTimeout(async () => {
      let ids: Record<string, string> = {};
      try {
        ids = await invoke<Record<string, string>>("get_pane_session_ids");
      } catch {
        // ignore — backend may have torn down; we'll save with whatever
        // session ids are still on each pane in state.
      }
      saveSessionShape(
        workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          tabId: w.tabId,
          pinnedPaneIds: w.pinnedPaneIds,
          gridCols: w.gridCols,
          gridRows: w.gridRows,
          idleQuietMs: w.idleQuietMs,
          panes: w.panes.map((p) => {
            // Backend wins on a fresh capture; otherwise fall back to
            // the in-state value so we don't wipe a hydrated id during
            // the first save after launch (Stop hook may not have fired
            // since restart, so the backend's map is empty for ~minutes).
            const fresh = ids?.[p.id];
            const detected = detectAgent(p.command ?? "");
            const freshAgent =
              fresh && isSessionAgent(detected) ? detected : null;
            const sanitized = sanitizePaneAgent(
              p.command,
              fresh ?? p.sessionId,
              freshAgent ?? p.sessionAgent,
            );
            return {
              id: p.id,
              kind: p.kind,
              command: p.command,
              cwd: p.cwd,
              env: p.env,
              previewUrl: p.previewUrl,
              sessionId: sanitized.sessionId,
              sessionAgent: sanitized.sessionAgent,
            };
          }),
        })),
        {
          activeWorkspaceId: activeIdRef.current,
          tabs,
          activeTabId: activeTabIdRef.current,
        },
      );
    }, 1000);
    return () => window.clearTimeout(handle);
    // `tabs` is in the deps so a tab add / rename / remove persists even
    // when the workspace shape itself didn't change.
  }, [workspaces, tabs]);

  // Selection persistence — tiny payload (which pane is active per
  // workspace, which workspace is on top). Separate key so a pane click
  // doesn't drag the workspace blob along for the ride.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      saveSessionSelection({
        activeWorkspaceId,
        activePaneByWs,
        activeTabId,
        activeWsByTab,
      });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [activeWorkspaceId, activePaneByWs, activeTabId, activeWsByTab]);

  // Belt-and-suspenders: synchronous flush on unload. No async
  // round-trip possible here, so we save whatever session ids are
  // currently on each pane in state — they're kept fresh by the
  // session-captured event listener, so this is now lossless instead
  // of a stale-disk-read.
  //
  // Ref-driven so we register the beforeunload listener exactly once
  // per mount instead of re-registering on every workspace/view/
  // active-pane change. Without the ref, each [workspaces,
  // activeWorkspaceId, activePaneByWs] change leaked the prior closure
  // (with its captured workspaces snapshot) until GC.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    saveSession({
      v: 1,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        tabId: w.tabId,
        pinnedPaneIds: w.pinnedPaneIds,
        gridCols: w.gridCols,
        gridRows: w.gridRows,
        idleQuietMs: w.idleQuietMs,
        panes: w.panes.map((p) => {
          const detected = detectAgent(p.command ?? "");
          const sanitized = sanitizePaneAgent(
            p.command,
            p.sessionId,
            isSessionAgent(detected) ? p.sessionAgent : p.sessionAgent,
          );
          return {
            id: p.id,
            kind: p.kind,
            command: p.command,
            cwd: p.cwd,
            env: p.env,
            previewUrl: p.previewUrl,
            sessionId: sanitized.sessionId,
            sessionAgent: sanitized.sessionAgent,
          };
        }),
      })),
      activeWorkspaceId,
      activePaneByWs,
      tabs,
      activeTabId,
      activeWsByTab,
    });
  };
  useEffect(() => {
    const flush = () => flushRef.current();
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);
}
