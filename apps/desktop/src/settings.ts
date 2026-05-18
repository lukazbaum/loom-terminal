/// User-facing preferences persisted to localStorage. Reads happen via
/// `useSetting<K>(key)` which subscribes to changes so multiple components
/// stay in sync after a Settings-page edit.
///
/// Keep this thin. Values are typed by key and validated on load; bad
/// data falls back to the default rather than crashing the app.

import { useEffect, useState } from "react";
import { ACTION_IDS, type ActionId, parseChord } from "./keybindings";
import { SOUND_PRESET_IDS, type SoundPreset } from "./notificationSound";
import { pushToastOnce } from "./toast";
import { BUILTIN_DARK_ID, BUILTIN_LIGHT_ID } from "./themes";

const STORAGE_KEY = "loom.settings.v1";

export type Settings = {
  /// xterm.js font size in CSS px. 13.5 = pre-setting hardcoded value.
  terminalFontSize: number;
  /// Idle quiet window for TerminalView's auto-completion signal (ms).
  idleQuietMs: number;
  /// Whether ⌘R restarts the active pane. Off by default — Cmd+R is a
  /// reflex for many users (browser reload), and inside a terminal we'd
  /// rather not surprise them. Opt-in via Settings.
  restartShortcutEnabled: boolean;
  /// ID of the active theme. Resolved against `themes.ts` — built-ins
  /// (`builtin-dark`, `builtin-light`) always exist; custom themes
  /// resolve through the user's registry. Falls back to dark on miss.
  activeThemeId: string;
  /// Whether the Claude 5h/7d rate-limit pills render in the header.
  /// On by default for subscription users; API-key users never see the
  /// pills anyway because the backend has no data to feed them.
  showClaudeUsage: boolean;
  /// Per-action keyboard binding overrides. Stored sparsely — only
  /// entries the user has changed appear here. Defaults live in
  /// `keybindings.ts` and get filled in at read time via `mergeKeymap`.
  /// An empty array for an action means "unbound".
  keybindings: Partial<Record<ActionId, string[]>>;
  /// Whether to play a sound when a pane finishes a turn (same gate as
  /// the sidebar mint pulse — suppressed when the user is already
  /// looking at the pane and scrolled to the bottom). Off by default.
  notificationSoundEnabled: boolean;
  /// Which preset to play. Built-ins are synthesized via Web Audio;
  /// "custom" reads `notificationSoundCustomPath`.
  notificationSoundPreset: SoundPreset | "custom";
  /// Absolute path to a user-supplied audio file. Only consulted when
  /// `notificationSoundPreset === "custom"`. null = no file picked.
  notificationSoundCustomPath: string | null;
  /// Master playback gain, 0–1. Applied to both synth and custom file.
  notificationSoundVolume: number;
};

export const DEFAULTS: Settings = {
  terminalFontSize: 13.5,
  idleQuietMs: 1200,
  restartShortcutEnabled: false,
  activeThemeId: BUILTIN_DARK_ID,
  showClaudeUsage: true,
  keybindings: {},
  notificationSoundEnabled: false,
  notificationSoundPreset: "ding",
  notificationSoundCustomPath: null,
  notificationSoundVolume: 0.6,
};

const MIN: Partial<Record<keyof Settings, number>> = {
  terminalFontSize: 9,
  idleQuietMs: 200,
  notificationSoundVolume: 0,
};
const MAX: Partial<Record<keyof Settings, number>> = {
  terminalFontSize: 28,
  idleQuietMs: 30_000,
  notificationSoundVolume: 1,
};

let current: Settings = loadFromStorage();
const subscribers = new Set<(s: Settings) => void>();

function loadFromStorage(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    return mergeWithDefaults(parsed as Partial<Settings>);
  } catch {
    return { ...DEFAULTS };
  }
}

function sanitizeKeybindings(
  raw: unknown,
): Partial<Record<ActionId, string[]>> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const known = new Set<string>(ACTION_IDS);
  const out: Partial<Record<ActionId, string[]>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k)) continue;
    if (!Array.isArray(v)) continue;
    const cleaned = v.filter(
      (s): s is string => typeof s === "string" && parseChord(s) !== null,
    );
    out[k as ActionId] = cleaned;
  }
  return out;
}

// Preset ids accepted on disk. "custom" is valid alongside the synth
// presets; anything else falls back to the default.
const VALID_PRESETS = new Set<string>([...SOUND_PRESET_IDS, "custom"]);

function mergeWithDefaults(partial: Partial<Settings>): Settings {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = partial[k];
    if (v === undefined) continue;
    if (k === "keybindings") {
      const cleaned = sanitizeKeybindings(v);
      if (cleaned) out.keybindings = cleaned;
      continue;
    }
    // `notificationSoundCustomPath` is the only nullable field; accept
    // a string path or an explicit null, reject anything else.
    if (k === "notificationSoundCustomPath") {
      if (v === null || (typeof v === "string" && v.length > 0)) {
        out.notificationSoundCustomPath = v as string | null;
      }
      continue;
    }
    if (k === "notificationSoundPreset") {
      if (typeof v === "string" && VALID_PRESETS.has(v)) {
        out.notificationSoundPreset = v as Settings["notificationSoundPreset"];
      }
      continue;
    }
    if (typeof v !== typeof DEFAULTS[k]) continue;
    if (typeof v === "number") {
      const min = MIN[k];
      const max = MAX[k];
      if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
        continue;
      }
    }
    if (k === "activeThemeId" && typeof v === "string" && v.length === 0)
      continue;
    (out as Record<string, unknown>)[k] = v;
  }
  // Back-compat: older builds wrote `theme: "dark" | "light"` instead of
  // `activeThemeId`. If the new field is missing but the old one is set,
  // map it through. Future writes use only the new field.
  const legacy = (partial as Record<string, unknown>).theme;
  if (
    out.activeThemeId === DEFAULTS.activeThemeId &&
    typeof legacy === "string"
  ) {
    if (legacy === "light") out.activeThemeId = BUILTIN_LIGHT_ID;
    else if (legacy === "dark") out.activeThemeId = BUILTIN_DARK_ID;
  }
  return out;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch (err) {
    pushToastOnce(
      "settings-quota",
      "Couldn't save settings — browser storage is full.",
      { kind: "warn" },
    );
    // eslint-disable-next-line no-console
    console.warn("[loom] settings persist failed", err);
  }
}

function emit(): void {
  for (const s of subscribers) s(current);
}

export function getSettings(): Settings {
  return current;
}

export function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  persist();
  emit();
}

export function resetSettings(): void {
  current = { ...DEFAULTS };
  persist();
  emit();
}

export function useSettings(): Settings {
  const [snapshot, setSnapshot] = useState<Settings>(current);
  useEffect(() => {
    subscribers.add(setSnapshot);
    setSnapshot(current);
    return () => {
      subscribers.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}

export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  const settings = useSettings();
  return settings[key];
}
