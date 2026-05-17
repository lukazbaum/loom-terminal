/// Types, constants, and pure helpers shared by every Welcome sub-module.
/// Kept in one file so the per-section files (Chrome, PresetsSection,
/// ComposerSection, HookFooter) don't have to import from each other.
import { AGENTS, detectAgent } from "../agents";
import { isMac } from "../platform";
import type { Preset } from "../presets";

export type HookAgent = "claude" | "codex" | "gemini";
export type ConsentValue = "unset" | "enabled" | "declined";

export type AgentHookStatus = {
  agent: HookAgent;
  consent: ConsentValue;
  installed: boolean;
  hasExistingHook: boolean;
};

export type HookStatuses = Record<HookAgent, AgentHookStatus>;
export type HookUiState = "idle" | "configuring" | "error";
export type HookUiStates = Record<HookAgent, HookUiState>;

export const HOOK_AGENTS: HookAgent[] = ["claude", "codex", "gemini"];

export const HOOK_AGENT_COPY: Record<
  HookAgent,
  { label: string; path: string; configureCmd: string }
> = {
  claude: {
    label: "Claude",
    path: "~/.claude/settings.json",
    configureCmd: "configure_claude_notification_hook",
  },
  codex: {
    label: "Codex",
    path: "~/.codex/hooks.json",
    configureCmd: "configure_codex_notification_hook",
  },
  gemini: {
    label: "Gemini",
    path: "~/.gemini/settings.json",
    configureCmd: "configure_gemini_notification_hook",
  },
};

const RECENT_FOLDERS_KEY = "loom.welcome.recentFolders.v1";
const RECENT_FOLDERS_MAX = 5;

export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === "string")
      .slice(0, RECENT_FOLDERS_MAX);
  } catch {
    return [];
  }
}

export function saveRecents(folders: string[]) {
  try {
    localStorage.setItem(
      RECENT_FOLDERS_KEY,
      JSON.stringify(folders.slice(0, RECENT_FOLDERS_MAX)),
    );
  } catch {
    // ignore
  }
}

export function pushRecent(prev: string[], folder: string): string[] {
  return [folder, ...prev.filter((f) => f !== folder)].slice(
    0,
    RECENT_FOLDERS_MAX,
  );
}

export const COUNT_OPTIONS = [1, 2, 4, 6, 8, 10] as const;

export { isMac };
export const META = isMac ? "⌘" : "Ctrl";

export type Mode =
  | { kind: "create" }
  | { kind: "edit"; preset: Preset }
  | { kind: "createPreset" };

export type Status = {
  tone: "amber" | "mint";
  label: string;
  detail: string;
};

export function statusFor(mode: Mode, hasPath: boolean): Status {
  switch (mode.kind) {
    case "edit":
      return {
        tone: "amber",
        label: "editing",
        detail: `“${mode.preset.name}”`,
      };
    case "createPreset":
      return {
        tone: "amber",
        label: "new preset",
        detail: "saving for one-click launch",
      };
    case "create":
      return hasPath
        ? { tone: "mint", label: "ready", detail: "press launch when set" }
        : { tone: "amber", label: "standby", detail: "awaiting folder" };
  }
}

export function commitLabelFor(mode: Mode): string {
  switch (mode.kind) {
    case "edit":
      return "Save changes";
    case "createPreset":
      return "Save preset";
    case "create":
      return "Launch workspace";
  }
}

export function summarizeCommands(commands: string[]): string {
  const filled = commands.filter((c) => c.trim().length > 0);
  if (filled.length === 0) return "default shells";
  const labels: string[] = [];
  for (const c of filled) {
    const id = detectAgent(c);
    let label: string;
    if (id !== "custom") {
      const a = AGENTS.find((x) => x.id === id);
      label = a ? a.label.toLowerCase() : id;
    } else {
      const head = c.trim().split(/\s+/)[0] ?? "";
      label = head.length > 12 ? head.slice(0, 12) + "…" : head;
    }
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.slice(0, 3).join(" · ") + (labels.length > 3 ? " · …" : "");
}
