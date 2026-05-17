import { invoke } from "@tauri-apps/api/core";

import { RateLimitBadge } from "./RateLimitBadge";
import { GearIcon, PortsIcon, ToolbarButton, ToolbarDivider } from "./Toolbar";
import { useActionChord } from "./useActionChord";

export type DetectedPortToast = {
  workspace_id: string;
  port: {
    pane_id: string;
    url: string;
    original_url: string;
    first_seen_ms: number;
    ready: boolean;
  };
};

type Props = {
  /// Centered title — computed by App from view + active workspace.
  headerLabel: string;
  /// Path subtitle (or empty string when not applicable).
  headerPath: string;
  /// `view.kind` from App. Used to disable the Ports button when no
  /// workspace is focused.
  viewKind: "workspace" | "new";
  showPorts: boolean;
  showSettings: boolean;
  onOpenPorts: () => void;
  onOpenSettings: () => void;
  /// Agent label ("Claude" / "Codex" / "Gemini") whose hook was just
  /// upgraded by the backend, surfacing the orange banner below the
  /// titlebar. `null` hides the banner.
  hookUpgraded: string | null;
  onDismissHookBanner: () => void;
  /// Queue of detected dev-server URLs. The first one (`portToasts[0]`)
  /// renders the mint-bordered banner below the header.
  portToasts: DetectedPortToast[];
  onPreviewPort: (workspaceId: string, url: string) => void;
  onDismissTopPort: () => void;
};

/// Top chrome: titlebar (drag region) + hook-upgraded banner +
/// port-detected toast. Extracted from App.tsx so each banner can be
/// added/removed without touching App's render block.
///
/// The titlebar's `data-tauri-drag-region` makes the whole bar
/// window-draggable except for explicit `data-tauri-drag-region="false"`
/// regions (the toolbar on the right). The centered title is
/// `pointer-events-none` so drag passes through it to the header.
export function AppHeader({
  headerLabel,
  headerPath,
  viewKind,
  showPorts,
  showSettings,
  onOpenPorts,
  onOpenSettings,
  hookUpgraded,
  onDismissHookBanner,
  portToasts,
  onPreviewPort,
  onDismissTopPort,
}: Props) {
  const head = portToasts[0];
  const settingsChord = useActionChord("view.settings");
  return (
    <>
      <header
        data-tauri-drag-region
        className="relative flex h-[34px] shrink-0 items-center border-b border-rule bg-ink-1/85 select-none"
      >
        {/* Top-left: Claude rate-limit badge. Hidden until backend has data. */}
        <RateLimitBadge />
        {/* Centered title — pointer-events-none so drag passes through
            to the header */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 flex max-w-[min(50%,520px)] -translate-x-1/2 -translate-y-1/2 items-baseline gap-2">
          <span className="truncate font-sans text-[12.5px] font-medium tracking-[-0.005em] text-paper">
            {headerLabel}
          </span>
          {headerPath && (
            <>
              <span aria-hidden className="text-[10px] text-fade">
                ·
              </span>
              <span className="truncate font-mono text-[11px] text-faint">
                {headerPath}
              </span>
            </>
          )}
        </div>
        <div
          className="ml-auto flex shrink-0 items-center gap-1 pr-2"
          data-tauri-drag-region="false"
        >
          <ToolbarButton
            icon={<PortsIcon />}
            label="Ports"
            description="Detected dev servers"
            tone="mint"
            active={showPorts}
            disabled={viewKind !== "workspace"}
            onClick={onOpenPorts}
          />
          <ToolbarDivider />
          <ToolbarButton
            icon={<GearIcon />}
            label="Settings"
            shortcut={settingsChord}
            description="Preferences and shortcuts"
            tone="mint"
            active={showSettings}
            onClick={onOpenSettings}
          />
        </div>
      </header>
      {hookUpgraded && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber/40 bg-amber/[0.10] px-3 py-1.5 text-[11.5px] text-paper">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber">
            hook updated
          </span>
          <span className="text-muted">
            Loom upgraded the {hookUpgraded} notification hook. Restart any
            running {hookUpgraded.toLowerCase()} panes to pick it up.
          </span>
          <button
            type="button"
            onClick={onDismissHookBanner}
            aria-label="Dismiss"
            className="ml-auto cursor-pointer px-1.5 py-0.5 font-mono text-[14px] leading-none text-faint transition-colors duration-150 hover:text-paper"
          >
            ×
          </button>
        </div>
      )}
      {head && (
        <div className="flex shrink-0 items-center gap-2 border-b border-mint/40 bg-mint/[0.08] px-3 py-1.5 text-[11.5px] text-paper">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-mint">
            dev server
          </span>
          <span className="text-muted">
            detected at <code className="text-mint">{head.port.url}</code>
            {portToasts.length > 1 && (
              <span className="ml-1 text-faint">
                (+{portToasts.length - 1} more)
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              onPreviewPort(head.workspace_id, head.port.url);
              onDismissTopPort();
            }}
            className="ml-auto cursor-pointer rounded-sm bg-mint/[0.12] px-2 py-0.5 font-sans text-[11px] text-mint transition-colors duration-100 hover:bg-mint/20"
          >
            preview
          </button>
          <button
            type="button"
            onClick={() => {
              invoke("plugin:opener|open_url", { url: head.port.url }).catch(
                () => {},
              );
              onDismissTopPort();
            }}
            title="Open in default browser"
            className="cursor-pointer rounded-sm px-1.5 py-0.5 font-mono text-[12px] text-faint transition-colors duration-150 hover:bg-ink-2 hover:text-paper"
          >
            ↗
          </button>
          <button
            type="button"
            onClick={onDismissTopPort}
            aria-label="Dismiss"
            className="cursor-pointer px-1.5 py-0.5 font-mono text-[14px] leading-none text-faint transition-colors duration-150 hover:text-paper"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
