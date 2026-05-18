import { lazy, Suspense } from "react";

import { ErrorBoundary } from "./ErrorBoundary";
import { SettingsPage } from "./SettingsPage";
import { ThemeEditor } from "./ThemeEditor";
import { Workspace } from "./Workspace";
import type { LaunchInput } from "./Welcome";
import type { Preset } from "./presets";
import type { Session } from "./types";

/// Welcome is the largest non-vendor module (~1500 lines including its
/// preset editor). Defer it until the user actually opens the
/// new-workspace view — the cold-start path lands on a workspace, not
/// Welcome, when the user has any prior session.
const Welcome = lazy(() =>
  import("./Welcome").then((m) => ({ default: m.Welcome })),
);

type Props = {
  workspaces: Session[];
  activeWorkspaceId: string | null;
  /// `view.kind === "new"`. Renders the Welcome overlay on top of any
  /// background workspace.
  isNewView: boolean;
  activePaneByWs: Record<string, string>;

  /// Pane action callbacks forwarded to each `<Workspace>`.
  activatePane: (workspaceId: string, paneId: string) => void;
  closePane: (workspaceId: string, paneId: string) => void;
  togglePinPane: (workspaceId: string, paneId: string) => void;
  duplicatePane: (workspaceId: string, paneId: string) => void;
  /// Forwarded to each `<Workspace>`. Workspace re-injects its own id
  /// before bubbling, so this is a single shared identity across panes.
  handlePaneCompletion: (
    paneId: string,
    workspaceId: string,
    wasAtBottom: boolean,
  ) => void;
  /// Forwarded to each `<Workspace>`. Fires when the user scrolls a
  /// pane back to the bottom; used to clear the workspace's unread pulse.
  handlePaneReachedBottom: (paneId: string, workspaceId: string) => void;

  /// Welcome plumbing.
  presets: Preset[];
  onLaunch: (input: LaunchInput) => void;
  onSavePreset: (input: Omit<Preset, "id" | "createdAt">) => Preset;
  onUpdatePreset: (
    id: string,
    patch: Partial<Omit<Preset, "id" | "createdAt">>,
  ) => void;
  onDeletePreset: (id: string) => void;
  /// Optional escape route from Welcome back to the most recent
  /// workspace. Caller-side because it depends on App's full setView
  /// machinery.
  onCancelWelcome: (() => void) | undefined;

  /// Modal-page route. Settings + ThemeEditor are full-screen overlays
  /// rendered above the workspace grid.
  showSettings: boolean;
  showThemeEditor: boolean;
  onSettingsClose: () => void;
  onThemeEditorOpen: () => void;
  onThemeEditorClose: () => void;
};

/// Right-of-sidebar pane area: the workspace grid switcher (one absolute
/// layer per workspace, only the active one visible), the Welcome
/// overlay when `view.kind === "new"`, and the full-screen Settings /
/// ThemeEditor overlays.
///
/// Each Workspace and the Welcome overlay are wrapped in their own
/// ErrorBoundary so a crash in one of them doesn't take down the rest
/// of the app — the user can keep working in their other workspaces
/// while a recoverable crash card surfaces for the broken one.
export function MainPanes({
  workspaces,
  activeWorkspaceId,
  isNewView,
  activePaneByWs,
  activatePane,
  closePane,
  togglePinPane,
  duplicatePane,
  handlePaneCompletion,
  handlePaneReachedBottom,
  presets,
  onLaunch,
  onSavePreset,
  onUpdatePreset,
  onDeletePreset,
  onCancelWelcome,
  showSettings,
  showThemeEditor,
  onSettingsClose,
  onThemeEditorOpen,
  onThemeEditorClose,
}: Props) {
  return (
    <main className="relative min-h-0 min-w-0 flex-1">
      {workspaces.map((w) => {
        const isActive = activeWorkspaceId === w.id;
        return (
          <div
            key={w.id}
            aria-hidden={!isActive}
            className={`absolute inset-0 ${
              isActive
                ? "z-10 opacity-100"
                : "pointer-events-none z-0 opacity-0"
            }`}
          >
            {/*
             * Per-workspace ErrorBoundary so a render crash in one
             * Workspace (or its TerminalView children) doesn't take down
             * the rest of the app — the user can keep working in their
             * other workspaces while we surface a recoverable crash
             * card for the one that broke.
             */}
            <ErrorBoundary>
              <Workspace
                session={w}
                activePaneId={activePaneByWs[w.id] ?? null}
                visible={isActive}
                onActivatePane={activatePane}
                onClosePane={closePane}
                onTogglePin={togglePinPane}
                onDuplicatePane={duplicatePane}
                onCompletion={handlePaneCompletion}
                onReachedBottom={handlePaneReachedBottom}
              />
            </ErrorBoundary>
          </div>
        );
      })}

      {isNewView && (
        <div className="absolute inset-0 z-20">
          <Suspense fallback={null}>
            {/* Welcome is large and full of form state; isolate its
             * failure mode from the workspace shell. */}
            <ErrorBoundary>
              <Welcome
                presets={presets}
                onLaunch={onLaunch}
                onSavePreset={onSavePreset}
                onUpdatePreset={onUpdatePreset}
                onDeletePreset={onDeletePreset}
                onCancel={onCancelWelcome}
              />
            </ErrorBoundary>
          </Suspense>
        </div>
      )}

      {showSettings && (
        <SettingsPage
          onClose={onSettingsClose}
          onOpenThemeEditor={onThemeEditorOpen}
        />
      )}

      {showThemeEditor && <ThemeEditor onClose={onThemeEditorClose} />}
    </main>
  );
}
