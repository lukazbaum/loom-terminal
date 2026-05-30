import { describe, expect, test } from "bun:test";

import { DEFAULT_TAB_ID } from "./sessionPersist";
import type { Session } from "./types";
import { reorderWorkspaceInTab } from "./useWorkspacesStore";

const ws = (id: string, tabId: string): Session => ({
  id,
  path: `/tmp/${id}`,
  panes: [],
  tabId,
});

describe("reorderWorkspaceInTab", () => {
  test("reorders within a tab, leaving interleaved other-tab slots untouched", () => {
    // Global order interleaves two tabs: a1(A), b1(B), a2(A), b2(B).
    const state = [ws("a1", "A"), ws("b1", "B"), ws("a2", "A"), ws("b2", "B")];
    // Tab A's filtered members are [a1, a2]; move a1 (from 0) to after a2.
    const next = reorderWorkspaceInTab(state, "A", 0, 2);
    // A's members become [a2, a1]; B keeps both its workspaces and slots.
    expect(next.map((w) => w.id)).toEqual(["a2", "b1", "a1", "b2"]);
  });

  test("moves a member up within its tab", () => {
    const state = [ws("a1", "A"), ws("a2", "A"), ws("a3", "A")];
    // Move a3 (from 2) before a2 (to 1).
    const next = reorderWorkspaceInTab(state, "A", 2, 1);
    expect(next.map((w) => w.id)).toEqual(["a1", "a3", "a2"]);
  });

  test("returns the same reference for self / adjacent no-ops", () => {
    const state = [ws("a1", "A"), ws("a2", "A")];
    expect(reorderWorkspaceInTab(state, "A", 0, 0)).toBe(state);
    expect(reorderWorkspaceInTab(state, "A", 0, 1)).toBe(state);
  });

  test("ignores out-of-range indices", () => {
    const state = [ws("a1", "A")];
    expect(reorderWorkspaceInTab(state, "A", 5, 0)).toBe(state);
    expect(reorderWorkspaceInTab(state, "A", 0, 9)).toBe(state);
  });

  test("treats a missing tabId as the default tab", () => {
    const a = { id: "a", path: "/tmp/a", panes: [] } as Session;
    const b = { id: "b", path: "/tmp/b", panes: [] } as Session;
    const next = reorderWorkspaceInTab([a, b], DEFAULT_TAB_ID, 0, 2);
    expect(next.map((w) => w.id)).toEqual(["b", "a"]);
  });
});
