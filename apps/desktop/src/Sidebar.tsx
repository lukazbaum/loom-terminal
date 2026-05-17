import { pad2 } from "./format";
import type { Session } from "./types";
import { useActionChord } from "./useActionChord";
import {
  ActiveRail,
  computeGutterTarget,
  workspaceLabel,
  WorkspaceTab,
  WS_DRAG_MIME,
} from "./WorkspaceTab";

export const SIDEBAR_COLLAPSED_WIDTH = 56;
export const SIDEBAR_WIDTH_DEFAULT = 220;
export const SIDEBAR_WIDTH_MIN = 160;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_COLLAPSED_KEY = "loom.sidebarCollapsed";
export const SIDEBAR_WIDTH_KEY = "loom.sidebarWidth";

type Props = {
  workspaces: Session[];
  activeWorkspaceId: string | null;
  isNewView: boolean;
  unread: Set<string>;
  collapsed: boolean;
  /// True while the user is dragging the right-edge resize handle.
  /// Drives the `transition-[width]` toggle on the nav element so the
  /// drag feels instant instead of laggy.
  resizing: boolean;
  /// "top" / "bottom" while a workspace-tab drag is hovering over a
  /// gutter; null otherwise. Drives the amber drop indicator.
  gutterDropTarget: "top" | "bottom" | null;
  setGutterDropTarget: (target: "top" | "bottom" | null) => void;
  editingWorkspaceId: string | null;

  onNewWorkspace: () => void;
  onToggleCollapsed: () => void;
  onResetWidth: () => void;
  onStartResize: (e: React.MouseEvent<HTMLDivElement>) => void;

  // Per-tab callbacks bubbled to App
  onActivateWorkspace: (id: string) => void;
  onRequestCloseWorkspace: (id: string) => void;
  onRequestWorkspaceMenu: (id: string, x: number, y: number) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, raw: string) => void;
  onCancelRename: () => void;
  onMoveWorkspace: (from: number, to: number) => void;
};

/// Left-rail sidebar: brand header, "New workspace" pinned button,
/// workspace-tab list with drag-and-drop reorder + gutter drops,
/// collapse/expand toggle, and the right-edge resize handle.
///
/// Width / collapsed state lives in App so the keyboard shortcut layer
/// (⌘B toggle) can flip them without prop-drilling through here. We
/// receive the current values + callbacks; reset-to-default width is
/// done via `onResetWidth` rather than reaching into localStorage so
/// the side-effect surface stays in one place.
export function Sidebar({
  workspaces,
  activeWorkspaceId,
  isNewView,
  unread,
  collapsed,
  resizing,
  gutterDropTarget,
  setGutterDropTarget,
  editingWorkspaceId,
  onNewWorkspace,
  onToggleCollapsed,
  onResetWidth,
  onStartResize,
  onActivateWorkspace,
  onRequestCloseWorkspace,
  onRequestWorkspaceMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onMoveWorkspace,
}: Props) {
  const newChord = useActionChord("workspace.new");
  const sidebarChord = useActionChord("view.toggleSidebar");
  return (
    <nav
      aria-label="Workspaces"
      style={{
        width: collapsed
          ? SIDEBAR_COLLAPSED_WIDTH
          : "var(--loom-sidebar-width)",
      }}
      className={`relative flex shrink-0 flex-col border-r border-rule bg-ink-1/60 ${
        resizing ? "" : "transition-[width] duration-150 ease-out"
      }`}
    >
      <div
        className={`flex shrink-0 items-center border-b border-rule py-3.5 ${
          collapsed ? "justify-center px-2" : "gap-2.5 px-3.5"
        }`}
      >
        <span className="brand-mark h-3.5 w-3.5 shrink-0" aria-hidden />
        {!collapsed && (
          <>
            <span className="font-sans text-[13.5px] font-semibold tracking-[-0.01em] text-paper">
              Loom
            </span>
            {workspaces.length > 0 && (
              <span className="ml-auto font-mono text-[10px] tabular-nums tracking-[0.16em] text-faint [font-feature-settings:'tnum']">
                {pad2(workspaces.length)}
              </span>
            )}
          </>
        )}
      </div>

      <div
        className={`shrink-0 border-b border-rule ${collapsed ? "p-1.5" : "p-2"}`}
      >
        <button
          type="button"
          onClick={onNewWorkspace}
          aria-current={isNewView ? "page" : undefined}
          title={
            collapsed
              ? newChord
                ? `New workspace (${newChord})`
                : "New workspace"
              : undefined
          }
          className={`group relative flex w-full cursor-pointer items-stretch border transition-colors duration-150 ${
            isNewView
              ? "border-amber/45 bg-amber/[0.07]"
              : "border-rule/60 hover:border-amber/40 hover:bg-amber/[0.04]"
          } ${collapsed ? "justify-center" : ""}`}
        >
          {isNewView && <ActiveRail />}
          <span
            className={`flex shrink-0 items-center justify-center border font-mono leading-none transition-colors duration-150 ${
              isNewView
                ? "border-amber/55 bg-amber/[0.10] text-amber"
                : "border-rule/70 text-faint group-hover:border-amber/45 group-hover:text-amber"
            } ${collapsed ? "h-7 w-7 text-[14px]" : "my-1.5 ml-1.5 h-7 w-7 text-[14px]"}`}
          >
            +
          </span>
          {!collapsed && (
            <span
              className={`flex flex-1 items-center px-2.5 text-[12px] font-medium tracking-[-0.005em] transition-colors duration-150 ${
                isNewView ? "text-amber" : "text-muted group-hover:text-amber"
              }`}
            >
              New workspace
            </span>
          )}
          {!collapsed && newChord && (
            <span
              className={`flex shrink-0 items-center pr-2.5 font-mono text-[9.5px] uppercase tracking-[0.16em] transition-colors duration-150 ${
                isNewView
                  ? "text-amber/70"
                  : "text-fade group-hover:text-amber/70"
              }`}
            >
              {newChord}
            </span>
          )}
        </button>
      </div>

      {!collapsed && workspaces.length > 0 && (
        <div className="shrink-0 px-3.5 pt-3 pb-1.5 text-[9.5px] uppercase tracking-[0.18em] text-faint">
          Open
        </div>
      )}

      {/* Drop target for workspace-tab reorder. Drag handlers don't
          map cleanly to a keyboard pattern — keyboard reorder is a
          real gap (tracked separately) — and a container can't be a
          button. The TAB elements themselves are real buttons with
          their own focus / keyboard handling; this wrapper only
          catches drag drops in the gutters. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop reorder; per-tab keyboard handling lives on the tab buttons, gutter drops have no keyboard equivalent today */}
      <div
        onDragOver={(e) => {
          // Per-tab handlers fire first (cursor on a tab). Only act
          // when the cursor is over the container itself — i.e., in
          // the gutter above the first tab or below the last.
          if (e.target !== e.currentTarget) {
            if (gutterDropTarget !== null) setGutterDropTarget(null);
            return;
          }
          if (!e.dataTransfer.types.includes(WS_DRAG_MIME)) return;
          const target = computeGutterTarget(e.currentTarget, e.clientY);
          if (target !== null) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
          if (target !== gutterDropTarget) setGutterDropTarget(target);
        }}
        onDragLeave={(e) => {
          const rt = e.relatedTarget as Node | null;
          if (rt && e.currentTarget.contains(rt)) return;
          setGutterDropTarget(null);
        }}
        onDrop={(e) => {
          if (e.target !== e.currentTarget) return;
          if (!e.dataTransfer.types.includes(WS_DRAG_MIME)) return;
          e.preventDefault();
          const raw = e.dataTransfer.getData(WS_DRAG_MIME);
          setGutterDropTarget(null);
          const from = Number(raw);
          if (!Number.isInteger(from)) return;
          const target = computeGutterTarget(e.currentTarget, e.clientY);
          if (target === null) return;
          const to = target === "top" ? 0 : workspaces.length;
          onMoveWorkspace(from, to);
        }}
        className={`flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-2.5 ${
          collapsed ? "px-1.5 pt-2" : "px-2"
        }`}
      >
        {gutterDropTarget === "top" && (
          <div
            aria-hidden
            className="pointer-events-none h-[2px] w-full bg-amber shadow-[0_0_6px_rgba(245,163,90,0.55)]"
          />
        )}
        {workspaces.length === 0 && !collapsed && (
          <div className="m-1 border border-dashed border-rule/60 bg-transparent px-3 py-3 text-[11px] leading-[1.5] text-faint">
            No open workspaces.{" "}
            {newChord ? (
              <>
                Hit <span className="font-mono text-muted">{newChord}</span> or{" "}
              </>
            ) : null}
            <button
              type="button"
              onClick={onNewWorkspace}
              className="cursor-pointer text-amber transition-colors duration-150 hover:underline"
            >
              start a new one
            </button>
            .
          </div>
        )}
        {workspaces.map((w, i) => {
          const isActive = activeWorkspaceId === w.id;
          const isUnread = !isActive && unread.has(w.id);
          const shellCount = w.panes.filter(
            (p) => (p.kind ?? "terminal") === "terminal",
          ).length;
          return (
            <WorkspaceTab
              key={w.id}
              id={w.id}
              index={i}
              label={workspaceLabel(w, i)}
              path={w.path}
              shellCount={shellCount}
              isActive={isActive}
              isUnread={isUnread}
              collapsed={collapsed}
              editingInitial={
                editingWorkspaceId === w.id ? (w.name ?? "") : null
              }
              onActivate={onActivateWorkspace}
              onRequestClose={onRequestCloseWorkspace}
              onRequestMenu={onRequestWorkspaceMenu}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onReorder={onMoveWorkspace}
            />
          );
        })}
        {gutterDropTarget === "bottom" && (
          <div
            aria-hidden
            className="pointer-events-none h-[2px] w-full bg-amber shadow-[0_0_6px_rgba(245,163,90,0.55)]"
          />
        )}
      </div>

      <div
        className={`shrink-0 border-t border-rule ${
          collapsed ? "p-1.5" : "flex items-center gap-2 px-2 py-1.5"
        }`}
      >
        {!collapsed && sidebarChord && (
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-fade">
            {sidebarChord}
          </span>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={
            collapsed
              ? sidebarChord
                ? `Expand sidebar (${sidebarChord})`
                : "Expand sidebar"
              : sidebarChord
                ? `Collapse sidebar (${sidebarChord})`
                : "Collapse sidebar"
          }
          className={`cursor-pointer text-[13px] leading-none text-faint transition-colors duration-150 hover:bg-ink-2 hover:text-paper ${
            collapsed
              ? "flex w-full items-center justify-center py-1.5"
              : "ml-auto flex h-6 w-6 items-center justify-center"
          }`}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>

      {!collapsed && (
        // Sidebar resize handle. Mouse drag + double-click-to-default,
        // no keyboard support yet. As with the workspace-grid
        // separators, we don't claim `role="separator"` /
        // `aria-orientation` since that contract requires focusable
        // splitter behavior (arrow keys, value reporting) which we
        // haven't implemented. Annotated `aria-hidden` so assistive
        // tech ignores the visual handle.
        <div
          aria-hidden
          onMouseDown={onStartResize}
          onDoubleClick={onResetWidth}
          className={`absolute top-0 right-0 z-20 h-full w-1.5 translate-x-1/2 cursor-col-resize transition-colors duration-150 hover:bg-amber/30 ${
            resizing ? "bg-amber/30" : ""
          }`}
        />
      )}
    </nav>
  );
}
