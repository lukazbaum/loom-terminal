/// Theme registry and runtime application.
///
/// Tokens here mirror the `@theme` declarations in `App.css`: each entry
/// becomes a CSS custom property on `:root` (e.g. `ink0` -> `--color-ink-0`)
/// which Tailwind 4's JIT picks up to generate utility classes like
/// `bg-ink-0` / `text-paper` at build time. Switching themes at runtime
/// is therefore just rewriting those custom properties — no class names
/// move, no components need to re-render.
///
/// Built-in themes are defined in code so they always exist and can't be
/// edited or deleted. Custom themes are persisted to `loom.themes.v1`
/// localStorage and live alongside the built-ins in the active registry.
import { useEffect, useState } from "react";
import { pushToastOnce } from "./toast";

export type ThemeTokens = {
  // Surface — backgrounds stacked from app shell (ink0) to elevated
  // panel (ink4). `rule` is the default border color.
  ink0: string;
  ink1: string;
  ink2: string;
  ink3: string;
  ink4: string;
  rule: string;
  // Text — most-prominent to least. `fade` is for very low-emphasis
  // marks (placeholder hints, secondary outlines).
  paper: string;
  muted: string;
  faint: string;
  fade: string;
  // Primary accent — three steps for hover / depth. Named "amber" for
  // historical reasons (the original Loom palette); custom themes can
  // recolor freely. The editor labels them "Accent / Accent Soft /
  // Accent Deep" so end users never see the legacy name.
  amber: string;
  amberSoft: string;
  amberDeep: string;
  // States.
  coral: string;
  mint: string;
};

export type ThemeAppearance = "dark" | "light";

export type Theme = {
  id: string;
  name: string;
  /// Drives `color-scheme` and the xterm terminal palette derivation.
  /// Independent of the actual hex values so a custom palette can declare
  /// itself as "dark" or "light" regardless of how the user picks colors.
  appearance: ThemeAppearance;
  isBuiltin: boolean;
  tokens: ThemeTokens;
  createdAt: number;
};

/// Stable IDs so an active-theme pointer survives across app launches.
export const BUILTIN_DARK_ID = "builtin-dark";
export const BUILTIN_LIGHT_ID = "builtin-light";

const BUILTIN_DARK: Theme = {
  id: BUILTIN_DARK_ID,
  name: "Loom Dark",
  appearance: "dark",
  isBuiltin: true,
  createdAt: 0,
  tokens: {
    ink0: "#0b0b0d",
    ink1: "#111114",
    ink2: "#161619",
    ink3: "#1c1c21",
    ink4: "#25252c",
    rule: "#26262d",
    paper: "#ece9e1",
    muted: "#a8a59a",
    faint: "#6c6a61",
    fade: "#45433d",
    amber: "#f5a35a",
    amberSoft: "#d28a48",
    amberDeep: "#b06f33",
    coral: "#f56e5b",
    mint: "#91d5ad",
  },
};

const BUILTIN_LIGHT: Theme = {
  id: BUILTIN_LIGHT_ID,
  name: "Loom Light",
  appearance: "light",
  isBuiltin: true,
  createdAt: 0,
  tokens: {
    ink0: "#f7f5ee",
    ink1: "#efece2",
    ink2: "#e6e2d4",
    ink3: "#d8d3c2",
    ink4: "#cac4b1",
    rule: "#d3cdb9",
    paper: "#1c1c21",
    muted: "#45433d",
    faint: "#6c6a61",
    fade: "#a8a59a",
    amber: "#b06f33",
    amberSoft: "#8d5824",
    amberDeep: "#6e441b",
    coral: "#b8443b",
    mint: "#4f8867",
  },
};

const BUILTIN_THEMES: readonly Theme[] = [BUILTIN_DARK, BUILTIN_LIGHT];

/// The order tokens are presented in the editor, grouped by purpose.
/// Helper text is shown next to each row.
export type TokenGroup = {
  title: string;
  rows: { key: keyof ThemeTokens; label: string; hint?: string }[];
};

export const TOKEN_GROUPS: TokenGroup[] = [
  {
    title: "Surface",
    rows: [
      {
        key: "ink0",
        label: "Background",
        hint: "App shell — the deepest layer.",
      },
      {
        key: "ink1",
        label: "Surface 1",
        hint: "Tabs, sidebar, sticky chrome.",
      },
      {
        key: "ink2",
        label: "Surface 2",
        hint: "Buttons, hover fills, secondary panels.",
      },
      { key: "ink3", label: "Surface 3", hint: "Inputs, raised modals." },
      {
        key: "ink4",
        label: "Surface 4",
        hint: "Scrollbar thumb, deepest elevation.",
      },
      {
        key: "rule",
        label: "Border",
        hint: "Default divider and outline color.",
      },
    ],
  },
  {
    title: "Text",
    rows: [
      {
        key: "paper",
        label: "Body",
        hint: "Primary text — headings, paragraph copy.",
      },
      {
        key: "muted",
        label: "Muted",
        hint: "Secondary text — captions, helper hints.",
      },
      {
        key: "faint",
        label: "Faint",
        hint: "Tertiary — disabled labels, timestamps.",
      },
      {
        key: "fade",
        label: "Fade",
        hint: "Lowest emphasis — placeholders, corners.",
      },
    ],
  },
  {
    title: "Accent",
    rows: [
      {
        key: "amber",
        label: "Accent",
        hint: "Primary action color — buttons, highlights, focus rings.",
      },
      {
        key: "amberSoft",
        label: "Accent Soft",
        hint: "Hover tint, secondary accent edges.",
      },
      {
        key: "amberDeep",
        label: "Accent Deep",
        hint: "Pressed states, scrollbar hover.",
      },
    ],
  },
  {
    title: "Status",
    rows: [
      {
        key: "coral",
        label: "Danger",
        hint: "Errors, destructive actions, rate-limit warnings.",
      },
      {
        key: "mint",
        label: "Success",
        hint: "Completions, ready states, healthy signals.",
      },
    ],
  },
];

/// Map from token key to the CSS custom-property name Tailwind expects.
/// Keep in sync with the `@theme` block in App.css.
const TOKEN_CSS_VAR: Record<keyof ThemeTokens, string> = {
  ink0: "--color-ink-0",
  ink1: "--color-ink-1",
  ink2: "--color-ink-2",
  ink3: "--color-ink-3",
  ink4: "--color-ink-4",
  rule: "--color-rule",
  paper: "--color-paper",
  muted: "--color-muted",
  faint: "--color-faint",
  fade: "--color-fade",
  amber: "--color-amber",
  amberSoft: "--color-amber-soft",
  amberDeep: "--color-amber-deep",
  coral: "--color-coral",
  mint: "--color-mint",
};

/// Write the theme's tokens onto the document root and update
/// `color-scheme` so native scrollbars / form widgets follow the
/// theme's appearance. Also tags `data-theme` with the id for any
/// future per-theme overrides (no CSS currently selects on it).
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(TOKEN_CSS_VAR) as [
    keyof ThemeTokens,
    string,
  ][]) {
    root.style.setProperty(cssVar, theme.tokens[key]);
  }
  root.setAttribute("data-theme", theme.id);
  root.style.colorScheme = theme.appearance;
}

// ─── xterm bridge ────────────────────────────────────────────────────────

type XtermPalette = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

const ANSI_COOL_DARK = {
  blue: "#9fb8d4",
  magenta: "#d8a8c0",
  cyan: "#8fc7c7",
  brightBlue: "#bccee0",
  brightMagenta: "#e6c2d4",
  brightCyan: "#aedada",
};

const ANSI_COOL_LIGHT = {
  blue: "#3b5e8c",
  magenta: "#8a3f6a",
  cyan: "#3e7c7c",
  brightBlue: "#5a7faf",
  brightMagenta: "#a85a85",
  brightCyan: "#5a9696",
};

/// rgba helper for xterm's `selectionBackground` — xterm accepts hex
/// or rgba strings, and we want a translucent accent for the selection.
function rgbaFromHex(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m?.[1]) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/// Lighten or darken a hex color toward white or black by `amount`
/// (0..1). Used to derive bright-variants of the colored ANSI slots
/// so coral/mint/amber stay tonally consistent across normal+bright.
function shiftHex(hex: string, amount: number, towardWhite: boolean): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m?.[1]) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const target = towardWhite ? 255 : 0;
  const mix = (c: number) => Math.round(c + (target - c) * amount);
  const out = (mix(r) << 16) | (mix(g) << 8) | mix(b);
  return `#${out.toString(16).padStart(6, "0")}`;
}

/// Derive a complete 20-color xterm.js theme from a Loom theme. xterm
/// accepts strings only at construction (or via `term.options.theme = ...`
/// for live swap), so this is the single bridge from our token system to
/// the terminal palette.
///
/// Mapping rules:
/// - `background` / `foreground` / `cursor` come straight from tokens.
/// - ANSI red/green/yellow are coral/mint/amber so a `git status` in a
///   custom theme uses the same accents as the surrounding UI.
/// - ANSI black/white pivot on appearance: in dark themes "black" means
///   "darker than background" (ink3); in light themes "black" means
///   "main text color" (paper).
/// - Blue/magenta/cyan have no theme token; we ship two static palettes
///   keyed on appearance — chosen to read well on the corresponding
///   background. Custom themes inherit the matching palette.
export function xtermThemeFromTheme(theme: Theme): XtermPalette {
  const t = theme.tokens;
  const dark = theme.appearance === "dark";
  const ansiCool = dark ? ANSI_COOL_DARK : ANSI_COOL_LIGHT;
  const shiftAmt = 0.18;
  const towardWhite = dark;
  return {
    background: t.ink0,
    foreground: t.paper,
    cursor: t.amber,
    cursorAccent: t.ink0,
    selectionBackground: rgbaFromHex(t.amber, 0.22),
    black: dark ? t.ink3 : t.paper,
    white: dark ? t.paper : t.ink1,
    brightBlack: dark ? t.fade : t.muted,
    brightWhite: dark ? "#ffffff" : t.ink0,
    red: t.coral,
    green: t.mint,
    yellow: t.amber,
    brightRed: shiftHex(t.coral, shiftAmt, towardWhite),
    brightGreen: shiftHex(t.mint, shiftAmt, towardWhite),
    brightYellow: shiftHex(t.amber, shiftAmt, towardWhite),
    blue: ansiCool.blue,
    magenta: ansiCool.magenta,
    cyan: ansiCool.cyan,
    brightBlue: ansiCool.brightBlue,
    brightMagenta: ansiCool.brightMagenta,
    brightCyan: ansiCool.brightCyan,
  };
}

// ─── Custom theme persistence ────────────────────────────────────────────

const CUSTOM_STORAGE_KEY = "loom.themes.v1";

function isValidHex(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

function isValidTokens(value: unknown): value is ThemeTokens {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (Object.keys(TOKEN_CSS_VAR) as (keyof ThemeTokens)[]).every((k) =>
    isValidHex(v[k]),
  );
}

function sanitizeCustom(raw: unknown): Theme | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id.startsWith("custom-")) return null;
  if (typeof v.name !== "string" || v.name.trim() === "") return null;
  if (v.appearance !== "dark" && v.appearance !== "light") return null;
  if (!isValidTokens(v.tokens)) return null;
  return {
    id: v.id,
    name: v.name.trim().slice(0, 60),
    appearance: v.appearance,
    isBuiltin: false,
    tokens: v.tokens,
    createdAt: typeof v.createdAt === "number" ? v.createdAt : Date.now(),
  };
}

function loadCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeCustom).filter((t): t is Theme => t !== null);
  } catch {
    return [];
  }
}

function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

function saveCustomThemes(themes: Theme[]): void {
  try {
    const customs = themes.filter((t) => !t.isBuiltin);
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(customs));
  } catch (err) {
    if (isQuotaError(err)) {
      pushToastOnce(
        "themes-quota",
        "Browser storage is full — themes can't be saved.",
        { kind: "warn", timeoutMs: 8000 },
      );
    }
    // eslint-disable-next-line no-console
    console.warn("[loom] themes persist failed", err);
  }
}

// ─── Subscription model ──────────────────────────────────────────────────

let registry: Theme[] = [...BUILTIN_THEMES, ...loadCustomThemes()];
const subscribers = new Set<(themes: Theme[]) => void>();

/// Trailing-edge debounced persist. The color-picker drag fires
/// `onChange` once per pixel of slider motion — without this the
/// localStorage write would serialize the whole registry hundreds of
/// times per second. 200 ms after the user stops dragging, one write
/// lands. Subscriber updates still fire immediately so live preview
/// remains instant.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 200;

function schedulePersist(): void {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveCustomThemes(registry);
  }, PERSIST_DEBOUNCE_MS);
}

function emit(): void {
  schedulePersist();
  for (const fn of subscribers) fn(registry);
}

export function getThemeOrDefault(id: string | undefined): Theme {
  if (!id) return BUILTIN_DARK;
  return registry.find((t) => t.id === id) ?? BUILTIN_DARK;
}

export function createCustomTheme(opts: {
  name: string;
  source: Theme;
}): Theme {
  const created: Theme = {
    id: mintCustomId(),
    name: opts.name.trim().slice(0, 60) || "Untitled",
    appearance: opts.source.appearance,
    isBuiltin: false,
    tokens: { ...opts.source.tokens },
    createdAt: Date.now(),
  };
  registry = [...registry, created];
  emit();
  return created;
}

export function updateCustomTheme(
  id: string,
  patch: {
    name?: string;
    appearance?: ThemeAppearance;
    /// Partial so the editor can update one token at a time without
    /// having to splat the whole palette through every keystroke.
    tokens?: Partial<ThemeTokens>;
  },
): Theme | null {
  let updated: Theme | null = null;
  registry = registry.map((t) => {
    if (t.id !== id || t.isBuiltin) return t;
    const next: Theme = {
      ...t,
      name:
        patch.name !== undefined
          ? patch.name.trim().slice(0, 60) || t.name
          : t.name,
      appearance: patch.appearance ?? t.appearance,
      tokens: patch.tokens ? { ...t.tokens, ...patch.tokens } : t.tokens,
    };
    updated = next;
    return next;
  });
  if (updated) emit();
  return updated;
}

export function deleteCustomTheme(id: string): boolean {
  const before = registry.length;
  registry = registry.filter((t) => t.isBuiltin || t.id !== id);
  if (registry.length === before) return false;
  emit();
  return true;
}

function mintCustomId(): string {
  return `custom-${crypto.randomUUID()}`;
}

/// Parse a JSON string that the user pasted into the import dialog.
/// Accepts either a single theme or an array. Returns the imported
/// themes (after sanitization + re-id'ing to avoid clashes).
export function importThemesFromJson(json: string): Theme[] {
  const parsed = JSON.parse(json);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const imported: Theme[] = [];
  for (const raw of list) {
    // Force `isBuiltin: false` and remint the id so a hand-edited JSON can't
    // overwrite a built-in or shadow an existing custom theme.
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const candidate = sanitizeCustom({
      ...v,
      id: `${mintCustomId()}-${imported.length}`,
      createdAt: Date.now(),
    });
    if (candidate) imported.push(candidate);
  }
  if (imported.length === 0) {
    throw new Error("No valid themes found in JSON.");
  }
  registry = [...registry, ...imported];
  emit();
  return imported;
}

export function exportThemeAsJson(theme: Theme): string {
  // Strip transient/internal fields so the JSON is portable.
  return JSON.stringify(
    {
      name: theme.name,
      appearance: theme.appearance,
      tokens: theme.tokens,
    },
    null,
    2,
  );
}

export function useThemes(): Theme[] {
  const [snapshot, setSnapshot] = useState<Theme[]>(registry);
  useEffect(() => {
    subscribers.add(setSnapshot);
    // Sync in case the registry mutated between render and mount
    // (rare, but possible with React 19's deferred effects).
    setSnapshot(registry);
    return () => {
      subscribers.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}

// ─── Randomizer ──────────────────────────────────────────────────────────

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(color * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/// Generate a coherent palette by sampling a chrome hue (slightly
/// saturated near-neutral), a distant accent hue, and two status hues
/// near the canonical red/green poles, then deriving every token from
/// lightness ramps. Beats sampling 15 independent random hex values —
/// which is what naive randomizers do and which always looks bad.
export function randomThemeTokens(appearance: ThemeAppearance): ThemeTokens {
  const dark = appearance === "dark";

  // Chrome — the ink/rule family. Saturated just enough to feel
  // intentional but neutral enough to not fight the accent. The hue is
  // free so the user gets variety (cool slate, warm sepia, deep
  // eggplant, etc.).
  const chromeHue = rand(0, 360);
  const chromeSat = rand(0.04, 0.16);

  // Accent — placed 100°..260° away from chrome hue so the two color
  // families don't collide on the wheel. Saturation is high enough to
  // read as a real accent.
  const accentHue = (chromeHue + rand(100, 260)) % 360;
  const accentSat = rand(0.55, 0.82);

  // Status hues stay near their canonical poles so green still reads
  // as "success" and red still reads as "danger" — just shifted a bit
  // per generation to avoid the same coral/mint every time.
  const dangerHue = (rand(-12, 18) + 360) % 360; // ~348..18
  const successHue = (130 + rand(-15, 25)) % 360; // ~115..155

  // Lightness ramps. Dark themes: ink starts dark and steps up; paper
  // is near-white. Light themes mirror: ink near-white stepping down,
  // paper near-black.
  const inkBaseL = dark ? rand(0.04, 0.07) : rand(0.92, 0.97);
  const inkStep = dark ? 0.018 : -0.018;
  const paperL = dark ? rand(0.86, 0.94) : rand(0.08, 0.16);

  const inkAt = (i: number) =>
    hslToHex(chromeHue, chromeSat, inkBaseL + inkStep * i);

  // `paper` carries a tiny chroma so neutrals tinted by hue (warm
  // cream / cool fog) feel cohesive instead of pure gray.
  const paper = hslToHex(chromeHue, chromeSat * 0.4, paperL);
  const muted = hslToHex(chromeHue, chromeSat * 0.5, dark ? 0.62 : 0.32);
  const faint = hslToHex(chromeHue, chromeSat * 0.6, dark ? 0.42 : 0.5);
  const fade = hslToHex(chromeHue, chromeSat * 0.6, dark ? 0.26 : 0.66);
  const rule = hslToHex(chromeHue, chromeSat, dark ? 0.16 : 0.78);

  // Accent ramp: amber (regular), amber-soft (slightly darker/less
  // saturated for hover), amber-deep (deeper for pressed).
  const accentL = dark ? rand(0.6, 0.7) : rand(0.42, 0.5);
  const amber = hslToHex(accentHue, accentSat, accentL);
  const amberSoft = hslToHex(accentHue, accentSat * 0.85, accentL - 0.1);
  const amberDeep = hslToHex(accentHue, accentSat * 0.78, accentL - 0.2);

  const coral = hslToHex(
    dangerHue,
    rand(0.55, 0.7),
    dark ? rand(0.6, 0.7) : rand(0.42, 0.5),
  );
  const mint = hslToHex(
    successHue,
    rand(0.35, 0.55),
    dark ? rand(0.65, 0.75) : rand(0.4, 0.48),
  );

  return {
    ink0: inkAt(0),
    ink1: inkAt(1),
    ink2: inkAt(2),
    ink3: inkAt(3),
    ink4: inkAt(4),
    rule,
    paper,
    muted,
    faint,
    fade,
    amber,
    amberSoft,
    amberDeep,
    coral,
    mint,
  };
}

/// Produce a colorful adjective + noun name for a random theme so the
/// theme list reads better than a wall of "Random Theme 1/2/3".
function randomThemeName(): string {
  const adjectives = [
    "Dusty",
    "Velvet",
    "Foggy",
    "Neon",
    "Glacial",
    "Smoky",
    "Pastel",
    "Inkwell",
    "Twilight",
    "Sunlit",
    "Marbled",
    "Static",
    "Ember",
    "Brushed",
    "Polar",
    "Citrine",
    "Sable",
    "Heather",
  ];
  const nouns = [
    "Drift",
    "Tundra",
    "Garden",
    "Atrium",
    "Beacon",
    "Loft",
    "Halftone",
    "Margin",
    "Plaza",
    "Sigil",
    "Cinder",
    "Vellum",
    "Cipher",
    "Echo",
    "Lattice",
    "Atlas",
  ];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)]!;
  const n = nouns[Math.floor(Math.random() * nouns.length)]!;
  return `${a} ${n}`;
}

/// Create + select a random custom theme. `appearance` is randomized
/// too — caller can ignore the result or use it to switch the active
/// theme.
export function createRandomTheme(opts?: {
  appearance?: ThemeAppearance;
}): Theme {
  const appearance: ThemeAppearance =
    opts?.appearance ?? (Math.random() < 0.7 ? "dark" : "light");
  const tokens = randomThemeTokens(appearance);
  const created: Theme = {
    id: mintCustomId(),
    name: randomThemeName(),
    appearance,
    isBuiltin: false,
    tokens,
    createdAt: Date.now(),
  };
  registry = [...registry, created];
  emit();
  return created;
}

/// Replace an existing custom theme's tokens with a fresh random
/// palette. Used by the "Randomize" button when the active theme is
/// already custom — the user sees an in-place reroll instead of having
/// to create a new theme every time.
export function rerollCustomTheme(id: string): Theme | null {
  const target = registry.find((t) => t.id === id && !t.isBuiltin);
  if (!target) return null;
  return updateCustomTheme(id, {
    tokens: randomThemeTokens(target.appearance),
  });
}
