import { memo, useRef, useState } from "react";

import { pad2, shortenHome } from "./format";
import type { Session } from "./types";

export function makePaneId(): string {
  // crypto.randomUUID is available on both the webview (Tauri's WebKit /
  // WebView2) and Node; collision space is effectively zero, where the
  // previous `Date.now + 5-char random` shape had ~46k. The `p_` prefix
  // stays as a sanity check when grepping logs.
  return `p_${crypto.randomUUID()}`;
}

export function workspaceLabel(w: Session, index: number): string {
  return w.name?.trim() || `Workspace ${pad2(index + 1)}`;
}

export function ActiveRail() {
  return (
    <span
      aria-hidden
      className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 bg-amber shadow-[0_0_8px_rgba(245,163,90,0.45)]"
    />
  );
}

export type WorkspaceTabProps = {
  id: string;
  index: number;
  label: string;
  path: string;
  shellCount: number;
  isActive: boolean;
  isUnread: boolean;
  collapsed: boolean;
  /// Initial value when the tab enters edit mode. Empty string means the
  /// workspace had no custom name (so the input starts blank rather than
  /// pre-filled with the auto "Workspace NN" label).
  editingInitial: string | null;
  onActivate: (id: string) => void;
  onRequestClose: (id: string) => void;
  onRequestMenu: (id: string, x: number, y: number) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onReorder: (from: number, to: number) => void;
};

/// Custom MIME type for the workspace-tab drag payload. Used both as a
/// marker (so we only react to our own drags, not stray file drops) and as
/// the carrier for the source index. Tracked module-level too because
/// `dataTransfer.getData` is restricted to the `drop` event in most
/// browsers — `dragover` can only inspect `types`, not values.
export const WS_DRAG_MIME = "application/x-loom-workspace-tab";
let draggingTabIndex: number | null = null;

/// Resolve a gutter drop target from the cursor's Y position relative to
/// the workspace list. Returns "top" when above the first tab, "bottom"
/// when below the last, otherwise null (cursor is somewhere over a tab
/// or in a mid-list gap — handled by per-tab handlers).
export function computeGutterTarget(
  container: HTMLElement,
  clientY: number,
): "top" | "bottom" | null {
  const tabs = container.querySelectorAll<HTMLElement>("[data-loom-ws-tab]");
  if (tabs.length === 0) return null;
  const firstTop = tabs[0]!.getBoundingClientRect().top;
  const lastBottom = tabs[tabs.length - 1]!.getBoundingClientRect().bottom;
  if (clientY < firstTop) return "top";
  if (clientY > lastBottom) return "bottom";
  return null;
}

function InlineRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const cancelledRef = useRef(false);
  return (
    <input
      type="text"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (cancelledRef.current) return;
        onCommit(value);
      }}
      className="min-w-0 flex-1 border border-amber/50 bg-ink-0 px-1 py-px text-[12.5px] font-medium tracking-[-0.005em] text-paper outline-none focus:border-amber"
    />
  );
}

export const WorkspaceTab = memo(function WorkspaceTab({
  id,
  index,
  label,
  path,
  shellCount,
  isActive,
  isUnread,
  collapsed,
  editingInitial,
  onActivate,
  onRequestClose,
  onRequestMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onReorder,
}: WorkspaceTabProps) {
  const isEditing = editingInitial !== null;
  const [dropPos, setDropPos] = useState<"before" | "after" | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Drag is only enabled when the tab is in its plain state. Renaming uses
  // the same wrapper for keyboard input, and collapsed mode lacks the
  // affordance space for a drop indicator — disabling there matches how
  // the close × is hidden in collapsed mode.
  const dragEnabled = !isEditing && !collapsed;
  const tabClass = isActive
    ? "border-amber/40 bg-amber/[0.07]"
    : isUnread
      ? "border-mint/55 bg-mint/[0.05] animate-pulse-mint"
      : "border-transparent hover:border-rule hover:bg-ink-2";
  const badgeClass = isActive
    ? "border-amber/55 bg-amber/[0.10] text-amber"
    : isUnread
      ? "border-mint/55 bg-mint/[0.08] text-mint"
      : "border-rule/70 text-faint group-hover:border-rule group-hover:text-muted";
  const labelColor = isActive
    ? "text-amber"
    : isUnread
      ? "text-mint"
      : "text-paper";
  const tooltip = `${label} — ${shortenHome(path)}${
    isUnread ? "\nAgent finished" : ""
  }`;
  return (
    // The wrapper is draggable (workspace reorder) and the tab body
    // inside contains a real <button> for activate, plus inline rename
    // input and close button. Keyboard activation flows through those
    // child buttons; drag is mouse-only — same gap as the sidebar
    // gutter drop target. Tracked separately.
    // biome-ignore lint/a11y/noStaticElementInteractions: draggable wrapper; activate / close / rename are real buttons inside
    <div
      data-loom-ws-tab=""
      draggable={dragEnabled}
      onDragStart={(e) => {
        if (!dragEnabled) return;
        draggingTabIndex = index;
        setIsDragging(true);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(WS_DRAG_MIME, String(index));
      }}
      onDragEnd={() => {
        draggingTabIndex = null;
        setIsDragging(false);
        setDropPos(null);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(WS_DRAG_MIME)) return;
        // Don't show an indicator while hovering the dragged tab itself —
        // dropping onto the source is a no-op anyway.
        if (draggingTabIndex === index) {
          if (dropPos !== null) setDropPos(null);
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const next = e.clientY < midY ? "before" : "after";
        if (next !== dropPos) setDropPos(next);
      }}
      onDragLeave={(e) => {
        // dragleave fires when crossing onto a child; only clear when
        // leaving the tab entirely (relatedTarget outside).
        const rt = e.relatedTarget as Node | null;
        if (rt && e.currentTarget.contains(rt)) return;
        setDropPos(null);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(WS_DRAG_MIME)) return;
        e.preventDefault();
        const raw = e.dataTransfer.getData(WS_DRAG_MIME);
        setDropPos(null);
        const from = Number(raw);
        if (!Number.isInteger(from) || from === index) return;
        // Compute drop position from cursor Y at drop time — avoids a
        // stale-closure read of dropPos if onDragOver hasn't re-rendered.
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const to = e.clientY < midY ? index : index + 1;
        onReorder(from, to);
      }}
      className={`group relative flex items-stretch border transition-colors duration-150 ${tabClass} ${
        isDragging ? "opacity-40" : ""
      }`}
      onContextMenu={(e) => {
        if (isEditing) return;
        e.preventDefault();
        onRequestMenu(id, e.clientX, e.clientY);
      }}
    >
      {dropPos === "before" && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-[3px] left-0 right-0 z-10 h-[2px] bg-amber shadow-[0_0_6px_rgba(245,163,90,0.55)]"
        />
      )}
      {dropPos === "after" && (
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-[3px] left-0 right-0 z-10 h-[2px] bg-amber shadow-[0_0_6px_rgba(245,163,90,0.55)]"
        />
      )}
      {isActive && <ActiveRail />}
      {isEditing && !collapsed ? (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 px-1.5">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center border font-mono text-[11.5px] font-medium tabular-nums leading-none transition-colors duration-150 [font-feature-settings:'tnum'] ${badgeClass}`}
          >
            {pad2(index + 1)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <InlineRenameInput
              initial={editingInitial ?? ""}
              onCommit={(next) => onCommitRename(id, next)}
              onCancel={onCancelRename}
            />
            <span className="block w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] tracking-[-0.005em] text-faint">
              {shortenHome(path)}
            </span>
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onActivate(id)}
          onDoubleClick={(e) => {
            if (collapsed) return;
            e.preventDefault();
            onStartRename(id);
          }}
          aria-current={isActive ? "page" : undefined}
          title={tooltip}
          className={`flex min-w-0 flex-1 cursor-pointer items-center text-left ${
            collapsed ? "justify-center py-1.5 px-0" : "gap-2.5 py-1.5 px-1.5"
          }`}
        >
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center border font-mono text-[11.5px] font-medium tabular-nums leading-none transition-colors duration-150 [font-feature-settings:'tnum'] ${badgeClass}`}
          >
            {pad2(index + 1)}
          </span>
          {!collapsed && (
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex w-full items-center gap-1.5">
                <span
                  className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium tracking-[-0.005em] ${labelColor}`}
                >
                  {label}
                </span>
                {shellCount > 0 && (
                  <span className="shrink-0 font-mono text-[9.5px] tabular-nums leading-none text-faint [font-feature-settings:'tnum']">
                    {pad2(shellCount)}
                  </span>
                )}
              </span>
              <span className="block w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] tracking-[-0.005em] text-faint">
                {shortenHome(path)}
              </span>
            </span>
          )}
        </button>
      )}
      {!collapsed && !isEditing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRequestClose(id);
          }}
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          className="flex w-7 shrink-0 cursor-pointer items-center justify-center text-[14px] leading-none text-faint opacity-0 transition-all duration-150 hover:text-coral focus:opacity-100 group-hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
});
