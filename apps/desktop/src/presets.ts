import { useCallback, useEffect, useRef, useState } from "react";
import { pushToastOnce } from "./toast";

export type Preset = {
  id: string;
  name: string;
  path: string;
  count: number;
  /** Per-shell startup commands; commands.length === count. "" = plain shell. */
  commands: string[];
  createdAt: number;
};

const STORAGE_KEY = "loom.presets.v1";
const LEGACY_STORAGE_KEYS = ["vibeTerm.presets.v2"];

function genId(): string {
  return `preset_${crypto.randomUUID()}`;
}

/** Coerces commands array length to match count (pads with "" or truncates). */
export function normalizeCommands(commands: string[], count: number): string[] {
  if (commands.length === count) return commands;
  if (commands.length > count) return commands.slice(0, count);
  return [...commands, ...Array(count - commands.length).fill("")];
}

/// Validate one raw entry from localStorage. Returns the well-typed
/// preset or `null` when shape is missing/wrong — callers drop nulls.
/// The previous cast (`JSON.parse(raw) as Preset[]`) would have happily
/// blessed any array of garbage as Preset[].
function parsePreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.id !== "string" ||
    typeof p.name !== "string" ||
    typeof p.path !== "string" ||
    typeof p.count !== "number" ||
    !Array.isArray(p.commands) ||
    typeof p.createdAt !== "number"
  ) {
    return null;
  }
  // commands is unknown[]; coerce each to string (drop non-strings).
  const commands = p.commands.filter(
    (c: unknown): c is string => typeof c === "string",
  );
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    count: p.count,
    commands,
    createdAt: p.createdAt,
  };
}

function loadFromStorage(): Preset[] {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      LEGACY_STORAGE_KEYS.map((k) => localStorage.getItem(k)).find(
        (v) => v !== null,
      ) ??
      null;
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const presets: Preset[] = [];
    for (const entry of parsed) {
      const valid = parsePreset(entry);
      if (valid) presets.push(valid);
    }
    return presets;
  } catch {
    return [];
  }
}

export function usePresets() {
  const [presets, setPresets] = useState<Preset[]>(() => loadFromStorage());
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    } catch (err) {
      const isQuota =
        err instanceof DOMException &&
        (err.name === "QuotaExceededError" ||
          err.name === "NS_ERROR_DOM_QUOTA_REACHED");
      if (isQuota) {
        pushToastOnce(
          "localstorage-quota",
          "Browser storage is full — presets can't be saved.",
          { kind: "warn", timeoutMs: 8000 },
        );
      }
      // eslint-disable-next-line no-console
      console.warn("[loom] presets persist failed", err);
    }
  }, [presets]);

  const createPreset = useCallback(
    (input: Omit<Preset, "id" | "createdAt">): Preset => {
      const preset: Preset = {
        id: genId(),
        createdAt: Date.now(),
        name: input.name,
        path: input.path,
        count: input.count,
        commands: normalizeCommands(input.commands, input.count),
      };
      setPresets((prev) => [...prev, preset]);
      return preset;
    },
    [],
  );

  const updatePreset = useCallback(
    (id: string, patch: Partial<Omit<Preset, "id" | "createdAt">>) => {
      setPresets((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          const next: Preset = { ...p, ...patch };
          if (patch.count !== undefined || patch.commands !== undefined) {
            next.commands = normalizeCommands(
              patch.commands ?? p.commands,
              patch.count ?? p.count,
            );
          }
          return next;
        }),
      );
    },
    [],
  );

  const deletePreset = useCallback((id: string) => {
    setPresets((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { presets, createPreset, updatePreset, deletePreset };
}
