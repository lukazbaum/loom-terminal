/// Keyboard-binding registry.
///
/// Every dispatchable shortcut is identified by an `ActionId`. Defaults
/// live in code; users can override per-action via `Settings.keybindings`
/// (a partial map keyed by action id).
///
/// Chords are stored as strings like `Mod+Shift+KeyW`. The `Mod` token
/// is the platform's primary modifier — ⌘ on macOS, Ctrl on Windows /
/// Linux — so the same default keymap works on both OSes. Keys use the
/// `KeyboardEvent.code` value (`KeyN`, `Digit1`, `ArrowUp`, ...) so the
/// binding stays layout-independent across QWERTY/AZERTY/Dvorak.
///
/// Digit-range shortcuts (Mod+1..9, Alt+1..9) and Escape are intentionally
/// non-customizable; they're patterns or app-level conventions and editing
/// them individually would be more confusing than useful.

import { isMac } from "./platform";

export type ActionId =
  | "workspace.new"
  | "workspace.close"
  | "workspace.next"
  | "workspace.prev"
  | "workspace.moveUp"
  | "workspace.moveDown"
  | "pane.new"
  | "pane.splitHorizontal"
  | "pane.splitVertical"
  | "pane.close"
  | "pane.next"
  | "pane.prev"
  | "pane.restart"
  | "layout.undo"
  | "layout.redo"
  | "view.toggleSidebar"
  | "view.settings"
  | "view.help";

export const ACTION_IDS: readonly ActionId[] = [
  "workspace.new",
  "workspace.close",
  "workspace.next",
  "workspace.prev",
  "workspace.moveUp",
  "workspace.moveDown",
  "pane.new",
  "pane.splitHorizontal",
  "pane.splitVertical",
  "pane.close",
  "pane.next",
  "pane.prev",
  "pane.restart",
  "layout.undo",
  "layout.redo",
  "view.toggleSidebar",
  "view.settings",
  "view.help",
];

export type ShortcutGroup = "Workspaces" | "Panes" | "View";

export type ActionDescriptor = {
  id: ActionId;
  group: ShortcutGroup;
  label: string;
  /// Optional hint shown next to the row in Settings.
  hint?: string;
};

export const ACTIONS: readonly ActionDescriptor[] = [
  { id: "workspace.new", group: "Workspaces", label: "New workspace tab" },
  { id: "workspace.close", group: "Workspaces", label: "Close workspace" },
  { id: "workspace.next", group: "Workspaces", label: "Next workspace" },
  { id: "workspace.prev", group: "Workspaces", label: "Previous workspace" },
  { id: "workspace.moveUp", group: "Workspaces", label: "Move workspace up" },
  {
    id: "workspace.moveDown",
    group: "Workspaces",
    label: "Move workspace down",
  },
  { id: "pane.new", group: "Panes", label: "New session" },
  { id: "pane.splitHorizontal", group: "Panes", label: "Split horizontal" },
  { id: "pane.splitVertical", group: "Panes", label: "Split vertical" },
  { id: "pane.close", group: "Panes", label: "Close active pane" },
  { id: "pane.next", group: "Panes", label: "Next pane" },
  { id: "pane.prev", group: "Panes", label: "Previous pane" },
  {
    id: "pane.restart",
    group: "Panes",
    label: "Restart active pane",
    hint: "Off by default — enable under Terminal.",
  },
  { id: "layout.undo", group: "Panes", label: "Undo layout change" },
  { id: "layout.redo", group: "Panes", label: "Redo layout change" },
  { id: "view.toggleSidebar", group: "View", label: "Toggle sidebar" },
  { id: "view.settings", group: "View", label: "Open settings" },
  { id: "view.help", group: "View", label: "Show keyboard shortcuts" },
];

export const DEFAULT_KEYBINDINGS: Readonly<
  Record<ActionId, readonly string[]>
> = {
  "workspace.new": ["Mod+KeyT"],
  "workspace.close": ["Mod+Shift+KeyW"],
  "workspace.next": ["Mod+Shift+BracketRight"],
  "workspace.prev": ["Mod+Shift+BracketLeft"],
  "workspace.moveUp": ["Alt+ArrowUp"],
  "workspace.moveDown": ["Alt+ArrowDown"],
  "pane.new": ["Mod+KeyN"],
  "pane.splitHorizontal": ["Mod+KeyD"],
  "pane.splitVertical": ["Mod+Shift+KeyD"],
  "pane.close": ["Mod+KeyW"],
  "pane.next": ["Mod+BracketRight"],
  "pane.prev": ["Mod+BracketLeft"],
  "pane.restart": ["Mod+KeyR"],
  "layout.undo": ["Mod+KeyZ"],
  "layout.redo": ["Mod+Shift+KeyZ"],
  "view.toggleSidebar": ["Mod+KeyB"],
  "view.settings": ["Mod+Comma"],
  "view.help": ["Shift+Slash"],
};

/// Display-only entries surfaced in the help overlay alongside the
/// customizable bindings. Not editable because they describe ranges
/// (digit shortcuts) or app-level invariants (Escape dismisses dialogs).
export type StaticEntry = {
  combo: string;
  label: string;
  group: ShortcutGroup;
};

export const STATIC_ENTRIES: readonly StaticEntry[] = [
  {
    combo: "Mod+Digit1..9",
    label: "Switch to workspace 1–9",
    group: "Workspaces",
  },
  { combo: "Alt+Digit1..9", label: "Focus pane 1–9", group: "Panes" },
  { combo: "Escape", label: "Dismiss dialog", group: "View" },
];

// ─── Chord type & validation ─────────────────────────────────────────────

export type Chord = {
  /// Primary modifier. ⌘ on macOS, Ctrl on Windows/Linux.
  mod: boolean;
  /// Literal Ctrl. On macOS this is the ⌃ key (distinct from ⌘). On
  /// Windows/Linux there's no distinct ctrl, so the matcher collapses
  /// `mod` and `ctrl` to the same physical key.
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /// KeyboardEvent.code value.
  code: string;
};

const LETTER_CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  .split("")
  .map((c) => `Key${c}`);
const DIGIT_CODES = "0123456789".split("").map((d) => `Digit${d}`);
const FN_CODES = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const NAMED_CODES = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Comma",
  "Period",
  "Slash",
  "Semicolon",
  "Quote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Backquote",
  "Minus",
  "Equal",
  "Space",
  "Tab",
  "Enter",
  "Escape",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

const VALID_CODES = new Set<string>([
  ...LETTER_CODES,
  ...DIGIT_CODES,
  ...FN_CODES,
  ...NAMED_CODES,
]);

export function isValidCode(code: string): boolean {
  return VALID_CODES.has(code);
}

// ─── Parse / serialize ───────────────────────────────────────────────────

export function parseChord(s: string): Chord | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const parts = s.split("+");
  if (parts.length === 0) return null;
  const code = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!code || !isValidCode(code)) return null;
  const chord: Chord = {
    mod: false,
    ctrl: false,
    alt: false,
    shift: false,
    code,
  };
  for (const m of mods) {
    if (m === "Mod") chord.mod = true;
    else if (m === "Ctrl") chord.ctrl = true;
    else if (m === "Alt") chord.alt = true;
    else if (m === "Shift") chord.shift = true;
    else return null;
  }
  return chord;
}

export function chordToString(c: Chord): string {
  const parts: string[] = [];
  if (c.mod) parts.push("Mod");
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(c.code);
  return parts.join("+");
}

// ─── Matcher ─────────────────────────────────────────────────────────────

/// True if `event` is the exact chord. On Windows/Linux `mod` and `ctrl`
/// collapse onto the Ctrl key (there is no distinct "primary" modifier),
/// so a chord stored as `Mod+KeyN` or `Ctrl+KeyN` both match Ctrl+N. On
/// macOS the two are distinct: `Mod` is ⌘ and `Ctrl` is the literal ⌃.
export function matchesChord(
  event: KeyboardEvent,
  chord: Chord,
  mac: boolean = isMac,
): boolean {
  if (event.code !== chord.code) return false;
  if (mac) {
    if (event.metaKey !== chord.mod) return false;
    if (event.ctrlKey !== chord.ctrl) return false;
  } else {
    const wantsCtrl = chord.mod || chord.ctrl;
    if (event.ctrlKey !== wantsCtrl) return false;
    // Reject stray Windows/Super-key presses so `Win+N` doesn't sneak
    // through and trigger a `Mod+KeyN` binding.
    if (event.metaKey) return false;
  }
  if (event.altKey !== chord.alt) return false;
  if (event.shiftKey !== chord.shift) return false;
  return true;
}

// ─── Recorder helper ─────────────────────────────────────────────────────

const MODIFIER_CODES = new Set<string>([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
]);

/// Convert a fresh keystroke into a chord, or null when the user pressed
/// only a modifier (so the recorder UI can keep waiting). Honors the
/// platform convention: ⌘ becomes `mod` on macOS, Ctrl becomes `mod` on
/// Windows/Linux.
export function chordFromEvent(
  event: KeyboardEvent,
  mac: boolean = isMac,
): Chord | null {
  if (MODIFIER_CODES.has(event.code)) return null;
  if (!isValidCode(event.code)) return null;
  if (mac) {
    return {
      mod: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      code: event.code,
    };
  }
  return {
    mod: event.ctrlKey,
    ctrl: false,
    alt: event.altKey,
    shift: event.shiftKey,
    code: event.code,
  };
}

// ─── Display ─────────────────────────────────────────────────────────────

const SHIFTED_PUNCT: Record<string, string> = {
  Digit1: "!",
  Digit2: "@",
  Digit3: "#",
  Digit4: "$",
  Digit5: "%",
  Digit6: "^",
  Digit7: "&",
  Digit8: "*",
  Digit9: "(",
  Digit0: ")",
  Slash: "?",
  Period: ">",
  Comma: "<",
  Semicolon: ":",
  Quote: '"',
  Backslash: "|",
  BracketLeft: "{",
  BracketRight: "}",
  Backquote: "~",
  Minus: "_",
  Equal: "+",
};

const PLAIN_PUNCT: Record<string, string> = {
  Slash: "/",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: "Space",
  Tab: "Tab",
  Enter: "↵",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/// Render the key portion of a chord, folding shift into the glyph
/// when the result is more readable (e.g. `Shift+Slash` → `?`).
function displayKey(
  code: string,
  shift: boolean,
): { text: string; shiftFolded: boolean } {
  if (shift && code in SHIFTED_PUNCT) {
    return { text: SHIFTED_PUNCT[code] ?? code, shiftFolded: true };
  }
  if (code in PLAIN_PUNCT) {
    return { text: PLAIN_PUNCT[code] ?? code, shiftFolded: false };
  }
  if (code.startsWith("Key"))
    return { text: code.slice(3), shiftFolded: false };
  if (code.startsWith("Digit"))
    return { text: code.slice(5), shiftFolded: false };
  if (/^F\d+$/.test(code)) return { text: code, shiftFolded: false };
  return { text: code, shiftFolded: false };
}

/// Render a chord with platform-appropriate glyphs. macOS uses the
/// compact ⌘⌥⌃⇧ symbols; Windows/Linux use descriptive words joined
/// with `+`. When a shifted glyph subsumes the shift (e.g. `?` already
/// implies shift), the shift indicator is omitted.
export function formatChord(chord: Chord, mac: boolean = isMac): string {
  const key = displayKey(chord.code, chord.shift);
  if (mac) {
    const parts: string[] = [];
    if (chord.ctrl) parts.push("⌃");
    if (chord.alt) parts.push("⌥");
    if (chord.shift && !key.shiftFolded) parts.push("⇧");
    if (chord.mod) parts.push("⌘");
    parts.push(key.text);
    return parts.join("");
  }
  const parts: string[] = [];
  if (chord.mod || chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift && !key.shiftFolded) parts.push("Shift");
  parts.push(key.text);
  return parts.join("+");
}

/// Convenience: format from a stored string. Returns the raw string
/// unchanged on parse failure so the UI never silently swallows bad data.
export function formatChordString(s: string, mac: boolean = isMac): string {
  const c = parseChord(s);
  return c ? formatChord(c, mac) : s;
}

/// Format one of the static `STATIC_ENTRIES.combo` values that aren't
/// real chord strings (they describe ranges like `Mod+Digit1..9`). Each
/// `+`-separated token is rewritten to its glyph (or Ctrl/Alt word on
/// non-Mac) and the `Digit` prefix is stripped. Tokens are concatenated
/// on Mac and joined with `+` elsewhere, matching `formatChord`.
export function formatStaticCombo(combo: string, mac: boolean = isMac): string {
  const parts = combo.split("+").map((part) => {
    if (part === "Mod") return mac ? "⌘" : "Ctrl";
    if (part === "Ctrl") return mac ? "⌃" : "Ctrl";
    if (part === "Alt") return mac ? "⌥" : "Alt";
    if (part === "Shift") return mac ? "⇧" : "Shift";
    return part.replace(/^Digit/, "");
  });
  return mac ? parts.join("") : parts.join("+");
}

// ─── Keymap (defaults merged with overrides) ─────────────────────────────

export type Keymap = Record<ActionId, string[]>;

/// Materialize the effective keymap from `Settings.keybindings`.
/// Overrides replace the default for that action (an empty array is
/// honored as "unbound"). Invalid chord strings are filtered out so a
/// bad legacy entry can't crash dispatch. Unknown action ids in
/// overrides are dropped.
export function mergeKeymap(
  overrides: Partial<Record<ActionId, string[]>> | undefined,
): Keymap {
  const out: Keymap = {} as Keymap;
  for (const id of ACTION_IDS) {
    const override = overrides?.[id];
    if (Array.isArray(override)) {
      out[id] = override.filter(
        (s) => typeof s === "string" && parseChord(s) !== null,
      );
    } else {
      out[id] = [...DEFAULT_KEYBINDINGS[id]];
    }
  }
  return out;
}

/// True iff the user has overridden the default chords for this action.
/// Drives the "Reset" affordance per row.
export function isOverridden(
  id: ActionId,
  overrides: Partial<Record<ActionId, string[]>> | undefined,
): boolean {
  const override = overrides?.[id];
  if (!Array.isArray(override)) return false;
  const cleaned = override.filter(
    (s) => typeof s === "string" && parseChord(s) !== null,
  );
  const def = DEFAULT_KEYBINDINGS[id];
  if (cleaned.length !== def.length) return true;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== def[i]) return true;
  }
  return false;
}

// ─── Dispatch lock (recorder coordination) ──────────────────────────────

/// Tiny ref-count gate the Settings page's chord recorder uses to pause
/// global shortcut dispatch while it's capturing the user's next chord.
/// Without this, recording `Mod+T` would also fire the `workspace.new`
/// action and the user could never assign that chord to anything else.
let dispatchLocks = 0;

export function lockDispatch(): () => void {
  dispatchLocks++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    dispatchLocks = Math.max(0, dispatchLocks - 1);
  };
}

export function isDispatchLocked(): boolean {
  return dispatchLocks > 0;
}

// ─── Conflict detection ──────────────────────────────────────────────────

export type Conflict = { chord: string; actions: ActionId[] };

/// Identify chords bound to more than one action. The dispatcher fires
/// the first match in `ACTION_IDS` order, so a conflict isn't fatal —
/// but the Settings UI surfaces it as a warning so the user notices.
export function findConflicts(keymap: Keymap): Conflict[] {
  const byChord = new Map<string, ActionId[]>();
  for (const id of ACTION_IDS) {
    for (const chord of keymap[id]) {
      const list = byChord.get(chord) ?? [];
      list.push(id);
      byChord.set(chord, list);
    }
  }
  const out: Conflict[] = [];
  for (const [chord, actions] of byChord) {
    if (actions.length > 1) out.push({ chord, actions });
  }
  return out;
}
