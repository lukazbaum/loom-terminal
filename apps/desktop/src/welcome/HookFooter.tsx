/// Per-agent consent card shown under the presets rail. Asks the user
/// to enable Loom's OSC-marker hook for one agent (Claude, Codex, or
/// Gemini). Three UI states: idle (offer), configuring (in-flight),
/// error (writeable check failed — show retry).
import { HOOK_AGENT_COPY, type HookAgent, type HookUiState } from "./internals";

export function HookFooter({
  agent,
  ui,
  onEnable,
  onDismiss,
}: {
  agent: HookAgent;
  ui: HookUiState;
  onEnable: () => void;
  onDismiss: () => void;
}) {
  const isConfiguring = ui === "configuring";
  const isError = ui === "error";
  const copy = HOOK_AGENT_COPY[agent];
  return (
    <div
      className="mt-4 flex items-center gap-3 border-t border-rule pt-5 opacity-0 animate-fade-up"
      style={{ animationDelay: "520ms" }}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-mint shadow-[0_0_6px_rgba(145,213,173,0.55)]"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[11.5px] font-medium tracking-[-0.005em] text-paper">
          Get a green pulse when {copy.label} finishes
        </span>
        <span className="text-[10.5px] leading-[1.5] text-muted">
          {isError
            ? `Couldn’t write to ${copy.path}. Check it’s editable.`
            : `Adds a small Loom hook to ${copy.path} so completions ping you.`}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onEnable}
          disabled={isConfiguring}
          className="cursor-pointer border border-mint/45 bg-mint/[0.06] px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-mint transition-colors duration-150 hover:border-mint hover:bg-mint/15 disabled:cursor-wait disabled:opacity-60"
        >
          {isConfiguring ? "Setting up…" : isError ? "Retry" : "Enable"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="cursor-pointer border border-rule bg-transparent px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors duration-150 hover:border-paper hover:text-paper"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
