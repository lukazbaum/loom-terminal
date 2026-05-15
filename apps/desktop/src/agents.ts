type AgentId = "shell" | "claude" | "codex" | "opencode" | "gemini" | "grok";
type DetectedAgent = AgentId | "custom";

export type Agent = {
  id: AgentId;
  label: string;
  command: string;
  hint?: string;
};

export const AGENTS: Agent[] = [
  { id: "shell", label: "Shell", command: "", hint: "no startup command" },
  { id: "claude", label: "Claude", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
  { id: "opencode", label: "OpenCode", command: "opencode" },
  { id: "gemini", label: "Gemini", command: "gemini" },
  { id: "grok", label: "Grok", command: "grok" },
];

/// Splits a command into its leading `KEY=VAL` env-assignment prefix, the
/// first non-env token, and everything after it. Lets the agent detector
/// and the resume-splicer treat `FOO=bar /usr/local/bin/claude --foo` the
/// same as a bare `claude --foo`. Returns empty strings for a fully-blank
/// command so callers don't have to null-check.
export function parseCommandLead(command: string): {
  envPrefix: string;
  head: string;
  rest: string;
} {
  const m = command.match(/^(\s*(?:[A-Za-z_]\w*=\S*\s+)*)(\S+)([\s\S]*)$/);
  if (!m) return { envPrefix: command, head: "", rest: "" };
  return { envPrefix: m[1] ?? "", head: m[2] ?? "", rest: m[3] ?? "" };
}

/// `/usr/local/bin/claude` → `claude`; `./codex` → `codex`. Used to match
/// the agent binary even when the user invoked it via an absolute path or
/// a relative wrapper.
export function commandBasename(head: string): string {
  const idx = head.lastIndexOf("/");
  return idx >= 0 ? head.slice(idx + 1) : head;
}

/**
 * Best-fit agent for a command string. Handles `FOO=bar claude`,
 * `./claude`, `/usr/local/bin/claude` as plain "claude". Returns "custom"
 * when nothing matches and "shell" for an empty command.
 */
export function detectAgent(command: string): DetectedAgent {
  const trimmed = command.trim();
  if (trimmed === "") return "shell";
  const { head } = parseCommandLead(command);
  if (!head) return "custom";
  const basename = commandBasename(head);
  for (const agent of AGENTS) {
    if (agent.id === "shell") continue;
    if (basename === agent.command) return agent.id;
  }
  return "custom";
}
