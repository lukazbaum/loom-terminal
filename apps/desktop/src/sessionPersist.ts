/// Session persistence — saves the workspace list, pane configs, and the
/// "what was I looking at" pointer to localStorage so closing/reopening
/// the app brings the user back. Does NOT persist live PTY state, mid-turn
/// agent state, or scrollback — those are inherently ephemeral. On restore,
/// each pane's command re-runs from scratch.

import { commandBasename, detectAgent, parseCommandLead } from "./agents";
import { pushToastOnce } from "./toast";

function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

/// Centralized quota-exceeded handler. localStorage failures used to be
/// dropped silently, leaving the user wondering why their session didn't
/// restore — now we surface a one-shot toast so they know storage is full.
function handlePersistError(scope: string, err: unknown): void {
  if (isQuotaError(err)) {
    pushToastOnce(
      "localstorage-quota",
      "Browser storage is full — workspace state can't be saved. Close some old workspaces or clear chat history.",
      { kind: "warn", timeoutMs: 8000 },
    );
  }
  // eslint-disable-next-line no-console
  console.warn(`[loom] ${scope} persist failed`, err);
}

const KEY = "loom.session.v1";
/// Selection lives in its own key so a pane click only stringifies the
/// small `{activeWorkspaceId, activePaneByWs}` blob instead of every
/// workspace + every pane in every workspace.
const SELECTION_KEY = "loom.session.selection.v1";
/// Tiny `paneId -> {id, agent, ts}` map written synchronously from the
/// `loom-session-captured` Tauri event listener. Covers the race where
/// the user quits between an OSC marker arriving and the debounced
/// shape save committing the new session id to disk. Read at load time
/// and merged on top of the main snapshot; the next shape save folds
/// the value in and the map becomes redundant (we leave it — it's a few
/// hundred bytes per pane and a fresh capture just overwrites in place).
const OVERRIDE_KEY = "loom.session.idOverrides.v1";

/// Stable id for the tab that pre-tabs snapshots migrate into. Constant
/// (not random) so the migration is idempotent — re-running `loadSession`
/// never spawns a second default tab. New tabs created at runtime use a
/// random `tab_<uuid>` id instead.
export const DEFAULT_TAB_ID = "tab_default";

type PersistedSelection = {
  v: 1;
  activeWorkspaceId?: string;
  activePaneByWs?: Record<string, string>;
  /// Id of the sidebar tab the user last had open.
  activeTabId?: string;
  /// Per-tab memory of the last-active workspace, so switching back to a
  /// tab returns you to where you were instead of its last workspace.
  activeWsByTab?: Record<string, string>;
};

export type PersistedTab = {
  id: string;
  name?: string;
};

/// Which agent captured `sessionId`. We can't infer this from the
/// pane's saved command (the user may have edited it after the id was
/// captured), so we record it alongside the id and only splice when the
/// agent kind still matches. Missing on legacy snapshots → assumed
/// "claude" since that was the only agent we shipped before.
export type SessionAgent = "claude" | "codex" | "gemini";

/// Runtime guard — used both by the persistence layer when re-hydrating
/// a snapshot and by callers that take a `SessionAgent | string` from a
/// runtime source (Tauri command return, OSC scanner output, etc.) and
/// need to narrow safely without a cast.
export function isSessionAgent(v: unknown): v is SessionAgent {
  return v === "claude" || v === "codex" || v === "gemini";
}

type PersistedPane = {
  id: string;
  /// "terminal" (default — re-spawns `command`) or "preview" (re-loads
  /// `previewUrl` in an iframe). Optional so old snapshots restore as
  /// terminals without migration.
  kind?: "terminal" | "preview";
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  previewUrl?: string;
  /// Captured by a Loom hook (Claude Stop, Codex Stop/SessionStart, or
  /// Gemini SessionStart) the first time the agent emits its session id.
  /// On restore, if this pane's command still matches `sessionAgent`, we
  /// splice in the agent-specific resume flag so the conversation
  /// continues mid-stream.
  ///
  /// Renamed from the legacy `claudeSessionId` (the field used to be
  /// Claude-only). `parsePersistedPane` still reads the legacy key for
  /// snapshots written before multi-agent resume shipped; new writes
  /// use `sessionId`.
  sessionId?: string;
  /// Agent kind that captured `sessionId`. Absent on snapshots written
  /// before multi-agent resume shipped — treat as "claude".
  sessionAgent?: SessionAgent;
};

type PersistedWorkspace = {
  id: string;
  name?: string;
  path: string;
  /// Sidebar tab this workspace lives under. Absent on pre-tabs
  /// snapshots — `loadSession` assigns the default tab id on load.
  tabId?: string;
  panes: PersistedPane[];
  /// User-pinned pane ids. Pinned panes can't be closed without
  /// unpinning first — used as a soft guard for critical panes.
  pinnedPaneIds?: string[];
  /// Manual grid override. When set, the workspace renders this many
  /// columns x rows instead of auto-fitting from pane count.
  gridCols?: number;
  gridRows?: number;
  /// Workspace-scoped idle quiet window (ms). Falls back to the global
  /// terminal setting when unset.
  idleQuietMs?: number;
};

export type PersistedSession = {
  v: 1;
  workspaces: PersistedWorkspace[];
  activeWorkspaceId?: string;
  activePaneByWs?: Record<string, string>;
  /// Sidebar tabs, in display order. Always at least one after a load
  /// (the loader synthesizes a default tab for pre-tabs snapshots).
  tabs: PersistedTab[];
  activeTabId?: string;
  activeWsByTab?: Record<string, string>;
};

const EMPTY: PersistedSession = {
  v: 1,
  workspaces: [],
  tabs: [{ id: DEFAULT_TAB_ID }],
  activeTabId: DEFAULT_TAB_ID,
};

/// Validate one raw entry from a persisted-pane array. Returns the
/// well-typed pane or `null` when the input doesn't even have an id —
/// callers count nulls into a "dropped panes" tally for the warn toast.
/// Exported for unit-test access; not part of any module's public API.
export function parsePersistedPane(raw: unknown): PersistedPane | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string") return null;
  const env =
    p.env && typeof p.env === "object" && !Array.isArray(p.env)
      ? (p.env as Record<string, string>)
      : undefined;
  // Accept either the new `sessionId` key OR the legacy
  // `claudeSessionId` for snapshots written before the field was
  // renamed (the field originally only held Claude ids; once Codex /
  // Gemini joined the multi-agent resume table the name lied). New
  // writes always use `sessionId`; the next shape save folds the rename
  // in and the legacy key disappears from disk.
  const sessionId =
    typeof p.sessionId === "string"
      ? p.sessionId
      : typeof p.claudeSessionId === "string"
        ? p.claudeSessionId
        : undefined;
  return {
    id: p.id,
    kind: p.kind === "preview" || p.kind === "terminal" ? p.kind : undefined,
    command: typeof p.command === "string" ? p.command : undefined,
    cwd: typeof p.cwd === "string" ? p.cwd : undefined,
    env,
    previewUrl: typeof p.previewUrl === "string" ? p.previewUrl : undefined,
    sessionId,
    sessionAgent: isSessionAgent(p.sessionAgent) ? p.sessionAgent : undefined,
  };
}

function loadSelection(): PersistedSelection | null {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.v !== 1) return null;
    return {
      v: 1,
      activeWorkspaceId:
        typeof parsed.activeWorkspaceId === "string"
          ? parsed.activeWorkspaceId
          : undefined,
      activePaneByWs:
        parsed.activePaneByWs &&
        typeof parsed.activePaneByWs === "object" &&
        !Array.isArray(parsed.activePaneByWs)
          ? (parsed.activePaneByWs as Record<string, string>)
          : undefined,
      activeTabId:
        typeof parsed.activeTabId === "string" ? parsed.activeTabId : undefined,
      activeWsByTab:
        parsed.activeWsByTab &&
        typeof parsed.activeWsByTab === "object" &&
        !Array.isArray(parsed.activeWsByTab)
          ? (parsed.activeWsByTab as Record<string, string>)
          : undefined,
    };
  } catch {
    return null;
  }
}

/// Parse + repair the persisted tab list. Drops malformed entries and
/// guarantees at least one tab so the app always has a place to put
/// workspaces. Pre-tabs snapshots (no `tabs` field) yield the single
/// default tab, which the caller then assigns every workspace to.
function parseTabs(raw: unknown): PersistedTab[] {
  const tabs: PersistedTab[] = [];
  if (Array.isArray(raw)) {
    for (const t of raw) {
      if (
        t &&
        typeof t === "object" &&
        typeof (t as PersistedTab).id === "string"
      ) {
        const tab = t as PersistedTab;
        tabs.push({
          id: tab.id,
          name: typeof tab.name === "string" ? tab.name : undefined,
        });
      }
    }
  }
  if (tabs.length === 0) tabs.push({ id: DEFAULT_TAB_ID });
  return tabs;
}

/// Load saved session from localStorage. Returns EMPTY on missing /
/// malformed / version-mismatch data — never throws.
export function loadSession(): PersistedSession {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      // eslint-disable-next-line no-console
      console.warn(
        "[loom] session: localStorage payload is not an object",
        parsed,
      );
      return EMPTY;
    }
    if (parsed.v !== 1) {
      // Best-effort: don't nuke the snapshot just because the version
      // marker drifted. Defensive shape checks below drop anything that
      // doesn't validate, which is the more honest definition of "this
      // snapshot is unreadable".
      // eslint-disable-next-line no-console
      console.warn(
        `[loom] session: version drift (got ${parsed.v}, expected 1) — attempting best-effort parse`,
      );
    }
    if (!Array.isArray(parsed.workspaces)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[loom] session: workspaces field is not an array — discarding",
      );
      return EMPTY;
    }
    // Defensive shape check on each workspace; skip malformed ones.
    const workspaces: PersistedWorkspace[] = [];
    let droppedWorkspaces = 0;
    let droppedPanes = 0;
    for (const w of parsed.workspaces) {
      if (!w || typeof w.id !== "string" || typeof w.path !== "string") {
        droppedWorkspaces++;
        continue;
      }
      const rawPanes: unknown[] = Array.isArray(w.panes) ? w.panes : [];
      const panes: PersistedPane[] = [];
      for (const raw of rawPanes) {
        const parsed = parsePersistedPane(raw);
        if (parsed) panes.push(parsed);
        else droppedPanes++;
      }
      workspaces.push({
        id: w.id,
        name: typeof w.name === "string" ? w.name : undefined,
        path: w.path,
        tabId: typeof w.tabId === "string" ? w.tabId : undefined,
        panes,
        pinnedPaneIds: Array.isArray(w.pinnedPaneIds)
          ? w.pinnedPaneIds.filter(
              (s: unknown): s is string => typeof s === "string",
            )
          : undefined,
        gridCols:
          typeof w.gridCols === "number" && w.gridCols >= 1 && w.gridCols <= 6
            ? w.gridCols
            : undefined,
        gridRows:
          typeof w.gridRows === "number" && w.gridRows >= 1 && w.gridRows <= 6
            ? w.gridRows
            : undefined,
        idleQuietMs:
          typeof w.idleQuietMs === "number" &&
          w.idleQuietMs >= 200 &&
          w.idleQuietMs <= 30_000
            ? w.idleQuietMs
            : undefined,
      });
    }
    if (droppedWorkspaces > 0 || droppedPanes > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[loom] session: dropped ${droppedWorkspaces} malformed workspace(s) and ${droppedPanes} malformed pane(s) on load`,
      );
    }
    // Layer in any synchronously-captured ids that hadn't made it into
    // the main snapshot yet — and drop ids whose pane's command no
    // longer matches the agent that captured them (e.g. user edited a
    // claude pane to run codex). Without that scrub, a stale claude id
    // would ride along forever as dead bytes.
    const overrides = loadSessionIdOverrides();
    for (const w of workspaces) {
      for (let i = 0; i < w.panes.length; i++) {
        const p = w.panes[i]!;
        const ov = overrides[p.id];
        let sessionId = p.sessionId;
        let sessionAgent = p.sessionAgent;
        if (ov) {
          sessionId = ov.id;
          sessionAgent = ov.agent;
        }
        const sanitized = sanitizePaneAgent(p.command, sessionId, sessionAgent);
        w.panes[i] = {
          ...p,
          sessionId: sanitized.sessionId,
          sessionAgent: sanitized.sessionAgent,
        };
      }
    }
    // ── Tabs: parse, then repair membership ───────────────────────────
    // Migration: a pre-tabs snapshot has no `tabs` field, so parseTabs
    // returns the single default tab and every workspace (whose tabId is
    // undefined) gets pinned to it below. Repair: any workspace pointing
    // at a tab that no longer exists is rehomed to the first tab so it
    // can never become unreachable.
    const tabs = parseTabs(parsed.tabs);
    const tabIds = new Set(tabs.map((t) => t.id));
    for (const w of workspaces) {
      if (!w.tabId || !tabIds.has(w.tabId)) {
        w.tabId = tabs[0]!.id;
      }
    }

    // Selection lives in its own key (faster pane-click writes), but for
    // backwards compat we also accept selection fields embedded in the v1
    // blob — those win only if the dedicated selection key is missing.
    const selection = loadSelection();

    const candidateActiveTab =
      selection?.activeTabId ??
      (typeof parsed.activeTabId === "string" ? parsed.activeTabId : undefined);
    const activeTabId =
      candidateActiveTab && tabIds.has(candidateActiveTab)
        ? candidateActiveTab
        : tabs[0]!.id;

    return {
      v: 1,
      workspaces,
      tabs,
      activeTabId,
      activeWsByTab: selection?.activeWsByTab,
      activeWorkspaceId:
        selection?.activeWorkspaceId ??
        (typeof parsed.activeWorkspaceId === "string"
          ? parsed.activeWorkspaceId
          : undefined),
      activePaneByWs:
        selection?.activePaneByWs ??
        (parsed.activePaneByWs &&
        typeof parsed.activePaneByWs === "object" &&
        !Array.isArray(parsed.activePaneByWs)
          ? (parsed.activePaneByWs as Record<string, string>)
          : undefined),
    };
  } catch {
    return EMPTY;
  }
}

export function saveSession(state: PersistedSession): void {
  saveSessionShape(state.workspaces, {
    activeWorkspaceId: state.activeWorkspaceId,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  });
  saveSessionSelection({
    activeWorkspaceId: state.activeWorkspaceId,
    activePaneByWs: state.activePaneByWs,
    activeTabId: state.activeTabId,
    activeWsByTab: state.activeWsByTab,
  });
}

/// Persist just the workspace shape — what the user has open and how each
/// pane is configured. Heaviest write (10s of KB at 5+ workspaces) so it
/// debounces longer than selection. activeWorkspaceId rides along because
/// it's both small and tied to which workspace's session ids matter.
export function saveSessionShape(
  workspaces: PersistedWorkspace[],
  extra: {
    activeWorkspaceId?: string;
    tabs?: PersistedTab[];
    activeTabId?: string;
  } = {},
): void {
  const payload = {
    v: 1,
    workspaces,
    activeWorkspaceId: extra.activeWorkspaceId,
    tabs: extra.tabs,
    activeTabId: extra.activeTabId,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
    return;
  } catch (err) {
    if (!isQuotaError(err)) {
      handlePersistError("session-shape", err);
      return;
    }
    // Quota: try again with env maps stripped. Per-pane env can be the
    // bulk of the payload (long PATHs, NODE_OPTIONS, etc.) and the
    // workspace shape (paths, commands, session ids) is more valuable
    // for resume — better to keep the shape and drop env than lose
    // the whole snapshot. The next launch will spawn shells with the
    // shell's inherited env, missing only the per-pane overrides.
    const affected = workspaces
      .filter((w) => w.panes.some((p) => p.env && Object.keys(p.env).length))
      .map((w) => w.name ?? w.path.split("/").pop() ?? w.id);
    const slim = {
      ...payload,
      workspaces: workspaces.map((w) => ({
        ...w,
        panes: w.panes.map((p) => ({ ...p, env: undefined })),
      })),
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(slim));
      const list =
        affected.length === 0
          ? ""
          : ` Affected: ${affected.slice(0, 3).join(", ")}${
              affected.length > 3 ? ` (+${affected.length - 3} more)` : ""
            }.`;
      pushToastOnce(
        "localstorage-quota-evicted-env",
        `Storage full — saved workspace shape without per-pane env overrides.${list} Re-set them or clear chat history to free space.`,
        { kind: "warn", timeoutMs: 10000 },
      );
    } catch (err2) {
      handlePersistError("session-shape (slim)", err2);
    }
  }
}

type IdOverride = {
  id: string;
  agent: SessionAgent;
  ts: number;
};

/// Write a single pane's freshly-captured session id to the override
/// key. Called synchronously from the React event listener that handles
/// `loom-session-captured` so the id survives an immediate quit even if
/// the React state update + 1 s shape-save debounce haven't run yet.
export function saveSessionIdOverride(
  paneId: string,
  id: string,
  agent: SessionAgent,
): void {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    const map: Record<string, IdOverride> =
      raw && typeof raw === "string" ? safeParseObject(raw) : {};
    map[paneId] = { id, agent, ts: Date.now() };
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(map));
  } catch (err) {
    handlePersistError("session-id-override", err);
  }
}

function safeParseObject(raw: string): Record<string, IdOverride> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, IdOverride>;
  } catch {
    return {};
  }
}

function loadSessionIdOverrides(): Record<string, IdOverride> {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return {};
    const parsed = safeParseObject(raw);
    const out: Record<string, IdOverride> = {};
    for (const [paneId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const id = (value as IdOverride).id;
      const agent = (value as IdOverride).agent;
      const ts = (value as IdOverride).ts;
      if (typeof id !== "string") continue;
      if (agent !== "claude" && agent !== "codex" && agent !== "gemini") {
        continue;
      }
      if (typeof ts !== "number") continue;
      out[paneId] = { id, agent, ts };
    }
    return out;
  } catch {
    return {};
  }
}

/// Drops a stale `{sessionId, sessionAgent}` pair when the pane's
/// current command no longer leads with the agent that captured the id.
/// Legacy snapshots without `sessionAgent` are treated as "claude"
/// (matches `resumeAwareCommand`'s default) so they don't lose their
/// id at first load after the upgrade.
export function sanitizePaneAgent(
  command: string | undefined,
  sessionId: string | undefined,
  sessionAgent: SessionAgent | undefined,
): {
  sessionId: string | undefined;
  sessionAgent: SessionAgent | undefined;
} {
  if (!sessionId) {
    return { sessionId: undefined, sessionAgent: undefined };
  }
  const effective: SessionAgent = sessionAgent ?? "claude";
  const detected = detectAgent(command ?? "");
  if (detected !== effective) {
    return { sessionId: undefined, sessionAgent: undefined };
  }
  return { sessionId, sessionAgent: effective };
}

/// Persist just the selection — which pane is active in each workspace.
/// Tiny payload, fires on every pane click.
export function saveSessionSelection(selection: {
  activeWorkspaceId?: string;
  activePaneByWs?: Record<string, string>;
  activeTabId?: string;
  activeWsByTab?: Record<string, string>;
}): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ v: 1, ...selection }));
  } catch (err) {
    handlePersistError("session-selection", err);
  }
}

/// Translates a persisted pane's saved command into the command we should
/// actually spawn. For panes whose saved command still matches the agent
/// that captured the session id, splice in the agent-specific resume
/// flag so the conversation picks up mid-stream:
///
///   claude  → claude --resume <id>
///   codex   → codex resume <id>          (subcommand, not flag)
///   gemini  → gemini --resume <id>
///
/// `sessionAgent` defaults to "claude" for legacy snapshots written
/// before multi-agent resume shipped. Skipped when:
///  - no id, or
///  - the saved command's leading binary doesn't match `sessionAgent`
///    (e.g. user edited the pane from claude to codex; we don't try to
///    feed a claude id to codex), or
///  - the user already passed an explicit resume/continue flag.
/// Session-id shape we'll accept for splicing. UUIDs from claude/codex
/// and the alphanumeric/dash form codex sometimes emits both fit this.
/// The hard cap stops a malicious OSC marker from constructing a long
/// shell expression and the character class blocks shell metacharacters
/// (`;`, `$`, backtick, quotes, newline, etc.) since the spliced
/// command is typed straight into the PTY.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function resumeAwareCommand(
  command: string | undefined,
  sessionId: string | undefined,
  sessionAgent: SessionAgent | undefined = "claude",
): string | undefined {
  if (!command || !sessionId) return command;
  if (!SESSION_ID_RE.test(sessionId)) {
    // eslint-disable-next-line no-console
    console.warn(
      "[loom] resumeAwareCommand: rejecting session id with unexpected shape",
    );
    return command;
  }

  const { envPrefix, head, rest } = parseCommandLead(command);
  if (!head) return command;
  const basename = commandBasename(head);
  const agent = sessionAgent ?? "claude";
  if (basename !== agent) return command;

  switch (agent) {
    case "claude": {
      if (/(?:^|\s)(--resume|-r|--continue|-c)(?:\s|=|$)/.test(rest)) {
        return command;
      }
      return `${envPrefix}${head} --resume ${sessionId}${rest}`;
    }
    case "codex": {
      // Codex resume is a subcommand, not a flag. Skip if the user
      // already wrote `codex resume ...` or asked for the last session
      // explicitly.
      if (/^\s+resume(\s|$)/.test(rest)) return command;
      if (/(?:^|\s)(--last|--continue)(?:\s|=|$)/.test(rest)) return command;
      return `${envPrefix}${head} resume ${sessionId}${rest}`;
    }
    case "gemini": {
      if (/(?:^|\s)(--resume|-r)(?:\s|=|$)/.test(rest)) return command;
      return `${envPrefix}${head} --resume ${sessionId}${rest}`;
    }
  }
}
