/// Types shared across more than one App-level component. Component-local
/// types live next to the component that owns them.
import type { SessionAgent } from "./sessionPersist";

export type Pane = {
  id: string;
  /// "terminal" (default — runs `command` in a PTY) or "preview" (renders
  /// `previewUrl` in an iframe). Default keeps existing panes terminal-typed
  /// without a migration.
  kind?: "terminal" | "preview";
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  /// Only set for kind="preview" panes — the URL to load in the iframe.
  previewUrl?: string;
  /// Most recently captured agent session id (from a Loom hook's OSC
  /// marker). Threaded into the spawn invoke so TerminalView can splice
  /// the agent-specific resume flag at command-build time. Held in
  /// state so a debounced save can fall back to it when the backend
  /// has nothing yet. See `sessionAgent` for which agent captured it.
  sessionId?: string;
  /// Which agent captured `sessionId`. Set when the OSC marker fires
  /// by looking up the pane's command at capture time. Undefined for
  /// legacy snapshots → assumed "claude" on resume.
  sessionAgent?: SessionAgent;
};

export type Session = {
  id: string;
  path: string;
  panes: Pane[];
  name?: string;
  /// User-pinned pane ids. Pinned panes can't be closed via the close ×
  /// or ⌘W until they are explicitly unpinned.
  pinnedPaneIds?: string[];
  /// Manual grid layout override (cols x rows). When set, the workspace
  /// renders this fixed grid instead of auto-fitting from pane count.
  gridCols?: number;
  gridRows?: number;
  /// Workspace-scoped idle quiet window (ms). Falls back to the global
  /// terminal setting when unset.
  idleQuietMs?: number;
};

export type DirtySummary = {
  dirty_files: number | null;
  branch: string | null;
};
