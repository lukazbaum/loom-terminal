import { describe, expect, test } from "bun:test";

import {
  ACTION_IDS,
  type ActionId,
  type Chord,
  chordFromEvent,
  chordToString,
  DEFAULT_KEYBINDINGS,
  findConflicts,
  formatChord,
  formatChordString,
  formatStaticCombo,
  isOverridden,
  isValidCode,
  isDispatchLocked,
  lockDispatch,
  matchesChord,
  mergeKeymap,
  parseChord,
} from "./keybindings";

// ─── KeyboardEvent stub ──────────────────────────────────────────────────
//
// bun:test runs in Node, where `KeyboardEvent` isn't defined. Tests
// against the matcher / recorder just need the modifier flags + `code`,
// so we synthesize a minimal object and cast through `unknown`.

type FakeEventInit = {
  code: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
};

function fakeEvent(init: FakeEventInit): KeyboardEvent {
  return {
    code: init.code,
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
  } as unknown as KeyboardEvent;
}

// ─── parseChord / chordToString ──────────────────────────────────────────

describe("parseChord", () => {
  test("parses bare key", () => {
    expect(parseChord("KeyA")).toEqual({
      mod: false,
      ctrl: false,
      alt: false,
      shift: false,
      code: "KeyA",
    });
  });

  test("parses single modifier", () => {
    expect(parseChord("Mod+KeyN")).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: "KeyN",
    });
  });

  test("parses multiple modifiers in any order", () => {
    expect(parseChord("Mod+Shift+KeyW")).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      code: "KeyW",
    });
    expect(parseChord("Shift+Mod+KeyW")).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      code: "KeyW",
    });
  });

  test("parses Alt and Ctrl literals", () => {
    expect(parseChord("Alt+ArrowUp")).toEqual({
      mod: false,
      ctrl: false,
      alt: true,
      shift: false,
      code: "ArrowUp",
    });
    expect(parseChord("Ctrl+KeyC")).toEqual({
      mod: false,
      ctrl: true,
      alt: false,
      shift: false,
      code: "KeyC",
    });
  });

  test("rejects unknown modifiers", () => {
    expect(parseChord("Super+KeyA")).toBeNull();
  });

  test("rejects unknown codes", () => {
    expect(parseChord("Mod+KeyNotReal")).toBeNull();
    expect(parseChord("Mod+")).toBeNull();
  });

  test("rejects empty input", () => {
    expect(parseChord("")).toBeNull();
  });

  test("round-trips through chordToString", () => {
    const samples = [
      "KeyA",
      "Mod+KeyN",
      "Mod+Shift+KeyW",
      "Mod+Ctrl+Alt+Shift+KeyX",
      "Alt+ArrowUp",
      "Shift+Slash",
      "Escape",
    ];
    for (const s of samples) {
      const parsed = parseChord(s);
      expect(parsed).not.toBeNull();
      expect(chordToString(parsed!)).toBe(s);
    }
  });
});

describe("isValidCode", () => {
  test("accepts letters, digits, and named keys", () => {
    expect(isValidCode("KeyA")).toBe(true);
    expect(isValidCode("Digit1")).toBe(true);
    expect(isValidCode("ArrowUp")).toBe(true);
    expect(isValidCode("Escape")).toBe(true);
    expect(isValidCode("F12")).toBe(true);
  });

  test("rejects unknown codes", () => {
    expect(isValidCode("PrintScreen")).toBe(false);
    expect(isValidCode("")).toBe(false);
    expect(isValidCode("keyA")).toBe(false);
  });
});

// ─── matchesChord ────────────────────────────────────────────────────────

describe("matchesChord on macOS", () => {
  const mac = true;

  test("Mod+KeyN matches ⌘N, not Ctrl+N", () => {
    const chord = parseChord("Mod+KeyN") as Chord;
    expect(
      matchesChord(fakeEvent({ code: "KeyN", meta: true }), chord, mac),
    ).toBe(true);
    expect(
      matchesChord(fakeEvent({ code: "KeyN", ctrl: true }), chord, mac),
    ).toBe(false);
  });

  test("Ctrl+KeyC matches literal ⌃C, distinct from ⌘C", () => {
    const chord = parseChord("Ctrl+KeyC") as Chord;
    expect(
      matchesChord(fakeEvent({ code: "KeyC", ctrl: true }), chord, mac),
    ).toBe(true);
    expect(
      matchesChord(fakeEvent({ code: "KeyC", meta: true }), chord, mac),
    ).toBe(false);
  });

  test("modifier set must match exactly", () => {
    const chord = parseChord("Mod+KeyN") as Chord;
    expect(
      matchesChord(
        fakeEvent({ code: "KeyN", meta: true, shift: true }),
        chord,
        mac,
      ),
    ).toBe(false);
    expect(
      matchesChord(
        fakeEvent({ code: "KeyN", meta: true, alt: true }),
        chord,
        mac,
      ),
    ).toBe(false);
  });

  test("code must match", () => {
    const chord = parseChord("Mod+KeyN") as Chord;
    expect(
      matchesChord(fakeEvent({ code: "KeyM", meta: true }), chord, mac),
    ).toBe(false);
  });
});

describe("matchesChord on Windows/Linux", () => {
  const mac = false;

  test("Mod+KeyN matches Ctrl+N", () => {
    const chord = parseChord("Mod+KeyN") as Chord;
    expect(
      matchesChord(fakeEvent({ code: "KeyN", ctrl: true }), chord, mac),
    ).toBe(true);
  });

  test("Ctrl+KeyN also matches Ctrl+N — collapse on non-Mac", () => {
    const chord = parseChord("Ctrl+KeyN") as Chord;
    expect(
      matchesChord(fakeEvent({ code: "KeyN", ctrl: true }), chord, mac),
    ).toBe(true);
  });

  test("ignores stray Windows/Super key press", () => {
    const chord = parseChord("Mod+KeyN") as Chord;
    expect(
      matchesChord(
        fakeEvent({ code: "KeyN", ctrl: true, meta: true }),
        chord,
        mac,
      ),
    ).toBe(false);
  });

  test("Alt+ArrowUp matches across OSes", () => {
    const chord = parseChord("Alt+ArrowUp") as Chord;
    expect(
      matchesChord(fakeEvent({ code: "ArrowUp", alt: true }), chord, mac),
    ).toBe(true);
  });
});

// ─── chordFromEvent ──────────────────────────────────────────────────────

describe("chordFromEvent", () => {
  test("Mac: ⌘N produces Mod+KeyN", () => {
    const chord = chordFromEvent(fakeEvent({ code: "KeyN", meta: true }), true);
    expect(chord).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      code: "KeyN",
    });
    expect(chord && chordToString(chord)).toBe("Mod+KeyN");
  });

  test("Win/Linux: Ctrl+N produces Mod+KeyN", () => {
    const chord = chordFromEvent(
      fakeEvent({ code: "KeyN", ctrl: true }),
      false,
    );
    expect(chord && chordToString(chord)).toBe("Mod+KeyN");
  });

  test("Mac: ⌃C distinct from ⌘C", () => {
    const chord = chordFromEvent(fakeEvent({ code: "KeyC", ctrl: true }), true);
    expect(chord && chordToString(chord)).toBe("Ctrl+KeyC");
  });

  test("modifier-only press returns null", () => {
    expect(
      chordFromEvent(fakeEvent({ code: "MetaLeft", meta: true }), true),
    ).toBeNull();
    expect(
      chordFromEvent(fakeEvent({ code: "ShiftLeft", shift: true }), false),
    ).toBeNull();
  });

  test("unsupported code returns null", () => {
    expect(chordFromEvent(fakeEvent({ code: "PrintScreen" }), true)).toBeNull();
  });
});

// ─── formatChord ─────────────────────────────────────────────────────────

describe("formatChord on macOS", () => {
  const mac = true;
  const fmt = (s: string) => formatChord(parseChord(s) as Chord, mac);

  test("uses Mac glyphs in Apple HIG order (⌃⌥⇧⌘)", () => {
    expect(fmt("Mod+KeyT")).toBe("⌘T");
    expect(fmt("Mod+Shift+KeyW")).toBe("⇧⌘W");
    expect(fmt("Alt+ArrowUp")).toBe("⌥↑");
    expect(fmt("Mod+Comma")).toBe("⌘,");
    expect(fmt("Mod+Ctrl+Alt+Shift+KeyX")).toBe("⌃⌥⇧⌘X");
  });

  test("folds shift into shifted-glyph keys", () => {
    expect(fmt("Shift+Slash")).toBe("?");
    expect(fmt("Mod+Shift+BracketRight")).toBe("⌘}");
  });

  test("⌃ rendered distinct from ⌘", () => {
    expect(fmt("Ctrl+KeyC")).toBe("⌃C");
  });
});

describe("formatChord on Windows/Linux", () => {
  const mac = false;
  const fmt = (s: string) => formatChord(parseChord(s) as Chord, mac);

  test("uses Ctrl word + plus separators", () => {
    expect(fmt("Mod+KeyT")).toBe("Ctrl+T");
    expect(fmt("Mod+Shift+KeyW")).toBe("Ctrl+Shift+W");
    expect(fmt("Alt+ArrowUp")).toBe("Alt+↑");
  });

  test("Mod and Ctrl collapse to the same Ctrl word", () => {
    expect(fmt("Mod+KeyN")).toBe("Ctrl+N");
    expect(fmt("Ctrl+KeyN")).toBe("Ctrl+N");
  });

  test("shifted-glyph folding still applies", () => {
    expect(fmt("Shift+Slash")).toBe("?");
    expect(fmt("Mod+Shift+BracketRight")).toBe("Ctrl+}");
  });
});

describe("formatChordString", () => {
  test("returns input unchanged when unparseable", () => {
    expect(formatChordString("garbage", true)).toBe("garbage");
  });
});

describe("formatStaticCombo", () => {
  test("substitutes Mod and Alt; strips Digit prefix", () => {
    expect(formatStaticCombo("Mod+Digit1..9", true)).toBe("⌘1..9");
    expect(formatStaticCombo("Mod+Digit1..9", false)).toBe("Ctrl+1..9");
    expect(formatStaticCombo("Alt+Digit1..9", true)).toBe("⌥1..9");
    expect(formatStaticCombo("Escape", true)).toBe("Escape");
  });
});

// ─── mergeKeymap / isOverridden ──────────────────────────────────────────

describe("mergeKeymap", () => {
  test("returns defaults when no overrides", () => {
    const map = mergeKeymap(undefined);
    expect(map["workspace.new"]).toEqual(["Mod+KeyT"]);
  });

  test("override replaces default", () => {
    const map = mergeKeymap({ "workspace.new": ["Mod+Shift+KeyT"] });
    expect(map["workspace.new"]).toEqual(["Mod+Shift+KeyT"]);
    // Other defaults preserved.
    expect(map["pane.new"]).toEqual(["Mod+KeyN"]);
  });

  test("empty array means unbound", () => {
    const map = mergeKeymap({ "view.help": [] });
    expect(map["view.help"]).toEqual([]);
  });

  test("invalid chord strings are dropped", () => {
    const map = mergeKeymap({
      "workspace.new": ["Mod+KeyT", "garbage", "Bogus+KeyZ"],
    });
    expect(map["workspace.new"]).toEqual(["Mod+KeyT"]);
  });

  test("unknown action ids in overrides are dropped silently", () => {
    const map = mergeKeymap({
      // biome-ignore lint/suspicious/noExplicitAny: testing tolerance of bad data
      "bogus.action": ["Mod+KeyT"] as any,
    } as Partial<Record<ActionId, string[]>>);
    expect("bogus.action" in map).toBe(false);
  });
});

describe("isOverridden", () => {
  test("false when override matches default", () => {
    expect(
      isOverridden("workspace.new", {
        "workspace.new": [...DEFAULT_KEYBINDINGS["workspace.new"]],
      }),
    ).toBe(false);
  });

  test("true when override differs", () => {
    expect(
      isOverridden("workspace.new", { "workspace.new": ["Mod+Shift+KeyT"] }),
    ).toBe(true);
  });

  test("true when override is empty (user explicitly unbound)", () => {
    expect(isOverridden("workspace.new", { "workspace.new": [] })).toBe(true);
  });

  test("false when no override entry", () => {
    expect(isOverridden("workspace.new", undefined)).toBe(false);
    expect(isOverridden("workspace.new", {})).toBe(false);
  });
});

// ─── findConflicts ───────────────────────────────────────────────────────

describe("findConflicts", () => {
  test("none in default keymap", () => {
    const map = mergeKeymap(undefined);
    expect(findConflicts(map)).toEqual([]);
  });

  test("detects duplicate chord across two actions", () => {
    const map = mergeKeymap({
      "workspace.new": ["Mod+KeyX"],
      "pane.new": ["Mod+KeyX"],
    });
    const conflicts = findConflicts(map);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.chord).toBe("Mod+KeyX");
    expect(conflicts[0]?.actions).toContain("workspace.new");
    expect(conflicts[0]?.actions).toContain("pane.new");
  });
});

// ─── lockDispatch ────────────────────────────────────────────────────────

// ─── End-to-end: every default binding fires its action ──────────────────
//
// Replays exactly what `useAppShortcuts.ts` does on each keystroke: parse
// the keymap, then iterate `ACTION_IDS` and `matchesChord` until a chord
// matches. Asserts the matched action equals the source — so every
// default chord (on both OSes) reaches the right handler and no two
// defaults collide.

/// Invert `chordFromEvent`: synthesize the KeyboardEvent that would
/// have produced this chord on a given OS.
function synthesizeEvent(chord: Chord, mac: boolean): KeyboardEvent {
  if (mac) {
    return fakeEvent({
      code: chord.code,
      meta: chord.mod,
      ctrl: chord.ctrl,
      alt: chord.alt,
      shift: chord.shift,
    });
  }
  return fakeEvent({
    code: chord.code,
    ctrl: chord.mod || chord.ctrl,
    alt: chord.alt,
    shift: chord.shift,
  });
}

function dispatch(
  event: KeyboardEvent,
  keymap: Record<ActionId, string[]>,
  mac: boolean,
): ActionId | null {
  for (const id of ACTION_IDS) {
    for (const chordStr of keymap[id]) {
      const chord = parseChord(chordStr);
      if (!chord) continue;
      if (matchesChord(event, chord, mac)) return id;
    }
  }
  return null;
}

describe("default keymap dispatch end-to-end", () => {
  const defaultMap = mergeKeymap(undefined);

  for (const mac of [true, false] as const) {
    describe(mac ? "macOS" : "Windows/Linux", () => {
      for (const id of Object.keys(DEFAULT_KEYBINDINGS) as ActionId[]) {
        const chords = DEFAULT_KEYBINDINGS[id];
        for (const chordStr of chords) {
          test(`${id} ⇐ ${chordStr}`, () => {
            const chord = parseChord(chordStr);
            expect(chord).not.toBeNull();
            if (!chord) return;
            const event = synthesizeEvent(chord, mac);
            expect(dispatch(event, defaultMap, mac)).toBe(id);
          });
        }
      }
    });
  }
});

describe("default keymap has no chord collisions", () => {
  test("no two default actions share a chord", () => {
    const conflicts = findConflicts(mergeKeymap(undefined));
    expect(conflicts).toEqual([]);
  });
});

// ─── Static digit-range patterns ─────────────────────────────────────────
//
// Mod+Digit1..9 and Alt+Digit1..9 aren't dispatched through the action
// loop (they're patterns, not single bindings) — but they go through the
// same OS-aware modifier check inside `useAppShortcuts`. Replay that
// check here for every digit on both OSes.

describe("digit-range patterns", () => {
  for (const mac of [true, false] as const) {
    describe(mac ? "macOS" : "Windows/Linux", () => {
      for (let n = 1; n <= 9; n++) {
        test(`Mod+Digit${n} resolves with no other modifiers`, () => {
          const e = mac
            ? fakeEvent({ code: `Digit${n}`, meta: true })
            : fakeEvent({ code: `Digit${n}`, ctrl: true });
          const modOnly = mac
            ? e.metaKey && !e.altKey && !e.ctrlKey
            : e.ctrlKey && !e.altKey && !e.metaKey;
          expect(modOnly && !e.shiftKey).toBe(true);
          expect(/^Digit([1-9])$/.exec(e.code)?.[1]).toBe(String(n));
        });

        test(`Alt+Digit${n} resolves with no other modifiers`, () => {
          const e = fakeEvent({ code: `Digit${n}`, alt: true });
          expect(e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey).toBe(
            true,
          );
          expect(/^Digit([1-9])$/.exec(e.code)?.[1]).toBe(String(n));
        });
      }
    });
  }
});

describe("lockDispatch", () => {
  test("ref-counts up and down", () => {
    expect(isDispatchLocked()).toBe(false);
    const r1 = lockDispatch();
    expect(isDispatchLocked()).toBe(true);
    const r2 = lockDispatch();
    expect(isDispatchLocked()).toBe(true);
    r1();
    expect(isDispatchLocked()).toBe(true);
    r2();
    expect(isDispatchLocked()).toBe(false);
  });

  test("release is idempotent", () => {
    const release = lockDispatch();
    expect(isDispatchLocked()).toBe(true);
    release();
    release(); // second call must not under-count
    expect(isDispatchLocked()).toBe(false);
    // A new lock still works.
    const r2 = lockDispatch();
    expect(isDispatchLocked()).toBe(true);
    r2();
  });
});
