import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_TAB_ID,
  isSessionAgent,
  loadSession,
  parsePersistedPane,
  resumeAwareCommand,
  saveSessionShape,
} from "./sessionPersist";

// ─── localStorage stub ───────────────────────────────────────────────
//
// bun:test runs in Node, where `localStorage` doesn't exist. The
// persistence layer is the most-touched localStorage consumer in the
// app, so we stub it with an in-memory Map. Wiped in beforeEach so each
// test gets a clean slate.

const memoryStore = new Map<string, string>();
const fakeLocalStorage: Storage = {
  getItem: (k) => memoryStore.get(k) ?? null,
  setItem: (k, v) => {
    memoryStore.set(k, v);
  },
  removeItem: (k) => {
    memoryStore.delete(k);
  },
  clear: () => {
    memoryStore.clear();
  },
  key: (i) => Array.from(memoryStore.keys())[i] ?? null,
  get length() {
    return memoryStore.size;
  },
};
(globalThis as { localStorage: Storage }).localStorage = fakeLocalStorage;

beforeEach(() => {
  memoryStore.clear();
});

// pushToastOnce reaches into a global toast container we don't set up
// here. The persistence layer only calls it on quota errors (which our
// in-memory Map never raises), so we don't need to stub it — but if
// any test accidentally triggers a toast we'd see a noisy throw. The
// afterEach lets test failures bubble up clean.
afterEach(() => {
  // no-op for now
});

// ─── parsePersistedPane (pure function) ─────────────────────────────

describe("parsePersistedPane", () => {
  test("returns null for non-object input", () => {
    expect(parsePersistedPane(null)).toBeNull();
    expect(parsePersistedPane(undefined)).toBeNull();
    expect(parsePersistedPane("")).toBeNull();
    expect(parsePersistedPane(42)).toBeNull();
    // Arrays ARE objects in JS (typeof === "object"), but they don't
    // have an `.id` field, so the typeof p.id !== "string" guard
    // catches them just the same.
    expect(parsePersistedPane([])).toBeNull();
  });

  test("returns null when id is missing or non-string", () => {
    expect(parsePersistedPane({})).toBeNull();
    expect(parsePersistedPane({ id: 42 })).toBeNull();
    expect(parsePersistedPane({ id: null })).toBeNull();
  });

  test("preserves all well-formed fields", () => {
    const out = parsePersistedPane({
      id: "pane_1",
      kind: "terminal",
      command: "claude",
      cwd: "/home/user/repo",
      env: { NODE_ENV: "test" },
      previewUrl: "http://localhost:3000",
      sessionId: "abc-123",
      sessionAgent: "claude",
    });
    expect(out).toEqual({
      id: "pane_1",
      kind: "terminal",
      command: "claude",
      cwd: "/home/user/repo",
      env: { NODE_ENV: "test" },
      previewUrl: "http://localhost:3000",
      sessionId: "abc-123",
      sessionAgent: "claude",
    });
  });

  test("drops invalid kind to undefined (not a runtime error)", () => {
    // Old snapshots that recorded `kind: "tab"` (a removed variant)
    // should restore as a terminal, not crash. Same for any string we
    // don't know.
    expect(parsePersistedPane({ id: "p", kind: "tab" })?.kind).toBeUndefined();
    expect(parsePersistedPane({ id: "p", kind: 1 })?.kind).toBeUndefined();
  });

  test("drops non-string fields to undefined rather than passing them through", () => {
    const out = parsePersistedPane({
      id: "p",
      command: 42,
      cwd: { not: "a string" },
      previewUrl: null,
      sessionId: ["wrong"],
    });
    expect(out).toEqual({
      id: "p",
      kind: undefined,
      command: undefined,
      cwd: undefined,
      env: undefined,
      previewUrl: undefined,
      sessionId: undefined,
      sessionAgent: undefined,
    });
  });

  test("env must be an object, not an array", () => {
    // env's runtime shape is `Record<string, string>`; an array passes
    // typeof === "object" but is semantically wrong. The guard catches
    // it via the Array.isArray check.
    expect(
      parsePersistedPane({ id: "p", env: ["NODE_ENV=test"] })?.env,
    ).toBeUndefined();
    expect(parsePersistedPane({ id: "p", env: { K: "V" } })?.env).toEqual({
      K: "V",
    });
  });

  test("sessionAgent is narrowed by the isSessionAgent guard", () => {
    expect(
      parsePersistedPane({ id: "p", sessionAgent: "claude" })?.sessionAgent,
    ).toBe("claude");
    expect(
      parsePersistedPane({ id: "p", sessionAgent: "codex" })?.sessionAgent,
    ).toBe("codex");
    expect(
      parsePersistedPane({ id: "p", sessionAgent: "gemini" })?.sessionAgent,
    ).toBe("gemini");
    // Legacy snapshots wrote "aider" before that agent was removed;
    // unknown values must round-trip to undefined so resumeAwareCommand
    // can fall back to its "claude" default.
    expect(
      parsePersistedPane({ id: "p", sessionAgent: "aider" })?.sessionAgent,
    ).toBeUndefined();
    expect(
      parsePersistedPane({ id: "p", sessionAgent: 42 })?.sessionAgent,
    ).toBeUndefined();
  });
});

// ─── isSessionAgent ─────────────────────────────────────────────────

describe("isSessionAgent", () => {
  test("accepts only the three documented variants", () => {
    expect(isSessionAgent("claude")).toBe(true);
    expect(isSessionAgent("codex")).toBe(true);
    expect(isSessionAgent("gemini")).toBe(true);
  });

  test("rejects unknown strings, non-strings, null, undefined", () => {
    expect(isSessionAgent("aider")).toBe(false);
    expect(isSessionAgent("grok")).toBe(false);
    expect(isSessionAgent("")).toBe(false);
    expect(isSessionAgent(null)).toBe(false);
    expect(isSessionAgent(undefined)).toBe(false);
    expect(isSessionAgent(42)).toBe(false);
    expect(isSessionAgent({})).toBe(false);
  });
});

// ─── loadSession (integration) ──────────────────────────────────────

describe("loadSession", () => {
  test("returns EMPTY when localStorage is empty", () => {
    const s = loadSession();
    expect(s.v).toBe(1);
    expect(s.workspaces).toEqual([]);
    expect(s.activeWorkspaceId).toBeUndefined();
  });

  test("returns EMPTY when payload is malformed JSON", () => {
    localStorage.setItem("loom.session.v1", "{not json");
    const s = loadSession();
    // EMPTY still carries a usable default tab so the app always has a
    // place to put workspaces, even after a corrupt snapshot.
    expect(s).toEqual({
      v: 1,
      workspaces: [],
      tabs: [{ id: DEFAULT_TAB_ID }],
      activeTabId: DEFAULT_TAB_ID,
    });
  });

  test("returns EMPTY when payload is JSON-valid but not an object", () => {
    localStorage.setItem("loom.session.v1", "42");
    expect(loadSession().workspaces).toEqual([]);
  });

  test("discards workspaces missing id or path; keeps the well-formed ones", () => {
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 1,
        workspaces: [
          { id: "ws_1", path: "/tmp/a", panes: [{ id: "p1" }] },
          { id: "ws_2" }, // missing path → dropped
          { path: "/tmp/c" }, // missing id → dropped
          { id: "ws_3", path: "/tmp/c", panes: [] },
        ],
      }),
    );
    const s = loadSession();
    expect(s.workspaces.map((w) => w.id)).toEqual(["ws_1", "ws_3"]);
  });

  test("drops malformed panes within an otherwise-valid workspace", () => {
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 1,
        workspaces: [
          {
            id: "ws_1",
            path: "/tmp/a",
            panes: [
              { id: "good_1" },
              { /* no id */ command: "claude" },
              42,
              null,
              { id: "good_2", command: "codex" },
            ],
          },
        ],
      }),
    );
    const s = loadSession();
    expect(s.workspaces[0]?.panes.map((p) => p.id)).toEqual([
      "good_1",
      "good_2",
    ]);
  });

  test("clamps gridCols / gridRows / idleQuietMs to safe bounds", () => {
    // Out-of-range numbers (or wrong types) restore as undefined so
    // the workspace falls back to auto-fit + the global idle window.
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 1,
        workspaces: [
          {
            id: "ws_1",
            path: "/tmp/a",
            panes: [],
            gridCols: 99,
            gridRows: 0,
            idleQuietMs: 50,
          },
          {
            id: "ws_2",
            path: "/tmp/b",
            panes: [],
            gridCols: 3,
            gridRows: 2,
            idleQuietMs: 5000,
          },
        ],
      }),
    );
    const s = loadSession();
    expect(s.workspaces[0]?.gridCols).toBeUndefined();
    expect(s.workspaces[0]?.gridRows).toBeUndefined();
    expect(s.workspaces[0]?.idleQuietMs).toBeUndefined();
    expect(s.workspaces[1]?.gridCols).toBe(3);
    expect(s.workspaces[1]?.gridRows).toBe(2);
    expect(s.workspaces[1]?.idleQuietMs).toBe(5000);
  });

  test("best-effort parses a version-drift snapshot rather than nuking it", () => {
    // Future-version snapshot: we warn but still try to extract what
    // we can. Previous behavior wiped the whole snapshot on any v
    // mismatch, which lost user state needlessly after a downgrade.
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 2,
        workspaces: [{ id: "ws_1", path: "/tmp/a", panes: [{ id: "p1" }] }],
      }),
    );
    const s = loadSession();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0]?.id).toBe("ws_1");
  });

  test("reads legacy claudeSessionId key for pre-rename snapshots", () => {
    // The field was renamed from claudeSessionId → sessionId after the
    // first multi-agent resume release (the old name lied — it held
    // any agent's id, not just Claude's). Back-compat: parsePersistedPane
    // accepts either key on read; new writes always use sessionId.
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 1,
        workspaces: [
          {
            id: "ws_1",
            path: "/tmp/a",
            panes: [
              {
                id: "p1",
                command: "claude",
                claudeSessionId: "legacy-uuid",
                sessionAgent: "claude",
              },
            ],
          },
        ],
      }),
    );
    const s = loadSession();
    expect(s.workspaces[0]?.panes[0]?.sessionId).toBe("legacy-uuid");
    expect(s.workspaces[0]?.panes[0]?.sessionAgent).toBe("claude");
  });

  test("prefers new sessionId over legacy claudeSessionId when both present", () => {
    // If a snapshot ends up with both keys (e.g. a downgrade + upgrade
    // cycle), the new key wins — it's the source the most recent
    // writer used.
    // biome-ignore lint/suspicious/noExplicitAny: writing the literal disk shape
    const fixture: any = {
      v: 1,
      workspaces: [
        {
          id: "ws_1",
          path: "/tmp/a",
          panes: [
            {
              id: "p1",
              command: "claude",
              claudeSessionId: "old-uuid",
              sessionId: "new-uuid",
              sessionAgent: "claude",
            },
          ],
        },
      ],
    };
    localStorage.setItem("loom.session.v1", JSON.stringify(fixture));
    const s = loadSession();
    expect(s.workspaces[0]?.panes[0]?.sessionId).toBe("new-uuid");
  });

  test("drops sessionId when the saved command no longer matches the agent", () => {
    // sanitizePaneAgent runs at load time so a pane that USED to be
    // a claude session but now spawns `codex` doesn't carry the stale
    // claude id and try to feed it to codex on the next launch.
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 1,
        workspaces: [
          {
            id: "ws_1",
            path: "/tmp/a",
            panes: [
              {
                id: "p1",
                command: "codex",
                sessionId: "abc-claude",
                sessionAgent: "claude",
              },
            ],
          },
        ],
      }),
    );
    const s = loadSession();
    expect(s.workspaces[0]?.panes[0]?.sessionId).toBeUndefined();
    expect(s.workspaces[0]?.panes[0]?.sessionAgent).toBeUndefined();
  });

  test("round-trips a workspace through saveSessionShape + loadSession", () => {
    saveSessionShape(
      [
        {
          id: "ws_a",
          name: "Loom",
          path: "/home/user/Dev/loom",
          panes: [
            {
              id: "p1",
              command: "claude",
              sessionId: "uuid-1",
              sessionAgent: "claude",
            },
            { id: "p2", kind: "preview", previewUrl: "http://localhost:5173" },
          ],
        },
      ],
      { activeWorkspaceId: "ws_a" },
    );
    const s = loadSession();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0]?.name).toBe("Loom");
    expect(s.workspaces[0]?.panes).toHaveLength(2);
    expect(s.workspaces[0]?.panes[0]?.sessionId).toBe("uuid-1");
    expect(s.workspaces[0]?.panes[0]?.sessionAgent).toBe("claude");
    expect(s.workspaces[0]?.panes[1]?.kind).toBe("preview");
    expect(s.workspaces[0]?.panes[1]?.previewUrl).toBe("http://localhost:5173");
  });
});

// ─── tab migration ──────────────────────────────────────────────────
//
// Tabs were added after the first releases, so loadSession must migrate
// pre-tabs snapshots into a single default tab without losing workspaces,
// and repair dangling tab references.

describe("tab migration", () => {
  test("EMPTY localStorage yields exactly one default tab", () => {
    const s = loadSession();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(s.tabs[0]?.id);
  });

  test("pre-tabs snapshot gets a default tab and all workspaces join it", () => {
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 1,
        workspaces: [
          { id: "ws_1", path: "/tmp/a", panes: [] },
          { id: "ws_2", path: "/tmp/b", panes: [] },
        ],
      }),
    );
    const s = loadSession();
    expect(s.tabs).toHaveLength(1);
    const tabId = s.tabs[0]!.id;
    expect(s.workspaces.map((w) => w.tabId)).toEqual([tabId, tabId]);
    expect(s.activeTabId).toBe(tabId);
  });

  test("round-trips multiple tabs + per-workspace membership", () => {
    saveSessionShape(
      [
        { id: "ws_1", path: "/tmp/a", tabId: "t1", panes: [] },
        { id: "ws_2", path: "/tmp/b", tabId: "t2", panes: [] },
      ],
      {
        activeWorkspaceId: "ws_1",
        tabs: [{ id: "t1", name: "Work" }, { id: "t2" }],
        activeTabId: "t2",
      },
    );
    const s = loadSession();
    expect(s.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.tabs[0]?.name).toBe("Work");
    expect(s.workspaces.find((w) => w.id === "ws_1")?.tabId).toBe("t1");
    expect(s.workspaces.find((w) => w.id === "ws_2")?.tabId).toBe("t2");
    expect(s.activeTabId).toBe("t2");
  });

  test("rehomes a workspace whose tab no longer exists to the first tab", () => {
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 1,
        tabs: [{ id: "t1" }],
        activeTabId: "t1",
        workspaces: [{ id: "ws_1", path: "/tmp/a", tabId: "ghost", panes: [] }],
      }),
    );
    const s = loadSession();
    expect(s.workspaces[0]?.tabId).toBe("t1");
  });

  test("falls back activeTabId to the first tab when the saved one is gone", () => {
    localStorage.setItem(
      "loom.session.v1",
      JSON.stringify({
        v: 1,
        tabs: [{ id: "t1" }, { id: "t2" }],
        activeTabId: "deleted",
        workspaces: [],
      }),
    );
    expect(loadSession().activeTabId).toBe("t1");
  });
});

// ─── resumeAwareCommand ─────────────────────────────────────────────
//
// The persistence layer's most security-adjacent feature: it splices a
// captured session id into the next-launch command line. A bad id
// (shell metacharacters, oversized) must NOT make it through.

describe("resumeAwareCommand", () => {
  test("splices claude --resume <id> for a claude pane with a captured id", () => {
    expect(resumeAwareCommand("claude", "abc-123", "claude")).toBe(
      "claude --resume abc-123",
    );
  });

  test("splices codex resume <id> (subcommand, not flag)", () => {
    expect(resumeAwareCommand("codex", "abc-123", "codex")).toBe(
      "codex resume abc-123",
    );
  });

  test("splices gemini --resume <id>", () => {
    expect(resumeAwareCommand("gemini", "abc-123", "gemini")).toBe(
      "gemini --resume abc-123",
    );
  });

  test("returns the original command when there's no session id", () => {
    expect(resumeAwareCommand("claude --foo", undefined, "claude")).toBe(
      "claude --foo",
    );
  });

  test("returns the original command when the agent doesn't match the binary", () => {
    // User-edited pane: was claude, now codex. The stale claude id
    // must NOT be spliced into the codex command.
    expect(resumeAwareCommand("codex", "abc-123", "claude")).toBe("codex");
  });

  test("preserves an existing --resume flag rather than double-splicing", () => {
    expect(resumeAwareCommand("claude --resume xyz", "abc-123", "claude")).toBe(
      "claude --resume xyz",
    );
  });

  test("rejects a session id with shell metacharacters", () => {
    // The OSC scanner has the primary defense (charset filter on
    // capture); this is defense-in-depth at the splice site.
    expect(resumeAwareCommand("claude", "abc; rm -rf ~", "claude")).toBe(
      "claude",
    );
    expect(resumeAwareCommand("claude", "abc`whoami`", "claude")).toBe(
      "claude",
    );
    expect(resumeAwareCommand("claude", "abc def", "claude")).toBe("claude");
  });

  test("rejects an oversized session id (>128 chars)", () => {
    const long = "a".repeat(129);
    expect(resumeAwareCommand("claude", long, "claude")).toBe("claude");
  });

  test("preserves env-var prefix when splicing", () => {
    // `FOO=bar claude` should become `FOO=bar claude --resume <id>`,
    // not `claude --resume <id>` (which would drop the env override).
    expect(
      resumeAwareCommand("FOO=bar claude --no-color", "abc", "claude"),
    ).toBe("FOO=bar claude --resume abc --no-color");
  });

  test("defaults sessionAgent to claude for legacy snapshots without it", () => {
    // Snapshots written before multi-agent resume shipped didn't
    // record sessionAgent. Defaulting to "claude" matches what those
    // snapshots represented.
    expect(resumeAwareCommand("claude", "abc", undefined)).toBe(
      "claude --resume abc",
    );
  });
});
