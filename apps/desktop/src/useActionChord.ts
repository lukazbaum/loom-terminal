/// React hook that returns the platform-formatted chord(s) for a given
/// `ActionId`. Subscribes to `Settings.keybindings` so any UI hint
/// (button title, menu shortcut column, contextual prompt) automatically
/// updates when the user rebinds the action.

import { useMemo } from "react";

import { type ActionId, formatChordString, mergeKeymap } from "./keybindings";
import { isMac } from "./platform";
import { useSettings } from "./settings";

/// First binding for the action, formatted for the current platform, or
/// `undefined` when the action is unbound. Use for hints where one
/// chord is enough — most button titles and menu rows. Callers should
/// gracefully omit the hint when this returns `undefined`.
export function useActionChord(id: ActionId): string | undefined {
  const settings = useSettings();
  return useMemo(() => {
    const chords = mergeKeymap(settings.keybindings)[id];
    const first = chords[0];
    if (!first) return undefined;
    return formatChordString(first, isMac);
  }, [settings.keybindings, id]);
}

/// All bindings for the action, formatted for the current platform.
/// Empty array when unbound. Use when every binding matters (e.g. the
/// help overlay lists them all).
export function useActionChords(id: ActionId): string[] {
  const settings = useSettings();
  return useMemo(() => {
    const chords = mergeKeymap(settings.keybindings)[id];
    return chords.map((c) => formatChordString(c, isMac));
  }, [settings.keybindings, id]);
}
