import { useEffect, useRef, useState } from "react";

import { pad2 } from "./format";
import type { WorkspaceTabMeta } from "./types";

/// Auto label for a tab with no custom name — mirrors `workspaceLabel`'s
/// "Workspace NN" convention so the two lists read consistently.
export function tabLabel(tab: WorkspaceTabMeta, index: number): string {
  return tab.name?.trim() || `Tab ${pad2(index + 1)}`;
}

type Props = {
  tabs: WorkspaceTabMeta[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onRequestDelete: (id: string) => void;
};

/// Inline rename field shown inside a tab's popover. Commits on Enter /
/// blur, abandons on Escape. `cancelledRef` suppresses the trailing blur
/// (fired when committing unmounts the input) so onCommit runs exactly
/// once — same pattern as `WorkspaceTab`'s `InlineRenameInput`.
function TabRenameInput({
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
      placeholder="Tab name"
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          cancelledRef.current = true;
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
      className="w-full border border-amber/50 bg-ink-0 px-1.5 py-1 text-[12px] font-medium tracking-[-0.005em] text-paper outline-none focus:border-amber"
    />
  );
}

/// Compact tab ("pages") control pinned to the bottom of the sidebar,
/// just above the collapse footer. Each tab is a small numbered dot:
/// click to switch, hover for the name (tooltip), double-click to open a
/// tiny rename / close popover. A trailing + adds a tab. Hidden by the
/// sidebar when collapsed.
export function TabSwitcher({
  tabs,
  activeTabId,
  onSelect,
  onAdd,
  onRename,
  onRequestDelete,
}: Props) {
  // Id of the tab whose rename/close popover is open (null = none).
  const [menuId, setMenuId] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Dismiss the popover on an outside click or Escape.
  useEffect(() => {
    if (!menuId) return;
    const onDown = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
        setMenuId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuId(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  // Close any open popover if its tab disappears (e.g. deleted elsewhere).
  useEffect(() => {
    if (menuId && !tabs.some((t) => t.id === menuId)) setMenuId(null);
  }, [tabs, menuId]);

  return (
    <div
      ref={rowRef}
      className="relative flex shrink-0 items-center gap-1 overflow-x-auto border-t border-rule px-2 py-1.5"
    >
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeTabId;
        const label = tabLabel(tab, i);
        const menuOpen = menuId === tab.id;
        return (
          <div key={tab.id} className="relative shrink-0">
            {menuOpen && (
              <div className="absolute bottom-full left-1/2 z-30 mb-1.5 w-44 -translate-x-1/2 border border-rule bg-ink-1 p-1.5 shadow-[0_-12px_30px_rgba(0,0,0,0.45)]">
                <TabRenameInput
                  initial={tab.name ?? ""}
                  onCommit={(next) => {
                    onRename(tab.id, next);
                    setMenuId(null);
                  }}
                  onCancel={() => setMenuId(null)}
                />
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuId(null);
                      onRequestDelete(tab.id);
                    }}
                    className="mt-1.5 flex w-full cursor-pointer items-center gap-1.5 px-1.5 py-1 text-left text-[11.5px] text-muted transition-colors duration-150 hover:bg-coral/[0.08] hover:text-coral"
                  >
                    <span aria-hidden className="text-[12px] leading-none">
                      ×
                    </span>
                    Close tab
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              onDoubleClick={(e) => {
                e.preventDefault();
                setMenuId(tab.id);
              }}
              aria-current={isActive ? "true" : undefined}
              aria-label={label}
              title={`${label} — double-click to rename`}
              className={`flex h-5 w-5 cursor-pointer items-center justify-center border font-mono text-[10.5px] tabular-nums leading-none transition-colors duration-150 [font-feature-settings:'tnum'] ${
                isActive
                  ? "border-amber/55 bg-amber/[0.10] text-amber"
                  : "border-rule/70 text-faint hover:border-rule hover:text-muted"
              }`}
            >
              {i + 1}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        aria-label="New tab"
        title="New tab"
        className="ml-0.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center text-[14px] leading-none text-faint transition-colors duration-150 hover:bg-ink-2 hover:text-amber"
      >
        +
      </button>
    </div>
  );
}
