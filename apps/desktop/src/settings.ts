/// User-facing preferences persisted to localStorage. Reads happen via
/// `useSetting<K>(key)` which subscribes to changes so multiple components
/// stay in sync after a Settings-page edit.
///
/// Keep this thin. Values are typed by key and validated on load; bad
/// data falls back to the default rather than crashing the app.

import { useEffect, useState } from "react";
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
};

export const DEFAULTS: Settings = {
  terminalFontSize: 13.5,
  idleQuietMs: 1200,
  restartShortcutEnabled: false,
  activeThemeId: BUILTIN_DARK_ID,
  showClaudeUsage: true,
};

const MIN: Partial<Record<keyof Settings, number>> = {
  terminalFontSize: 9,
  idleQuietMs: 200,
};
const MAX: Partial<Record<keyof Settings, number>> = {
  terminalFontSize: 28,
  idleQuietMs: 30_000,
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

function mergeWithDefaults(partial: Partial<Settings>): Settings {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = partial[k];
    if (v === undefined) continue;
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
