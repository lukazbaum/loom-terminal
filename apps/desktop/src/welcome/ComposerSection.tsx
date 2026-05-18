/// The big "compose a workspace" form in the left column of Welcome:
/// folder picker + recent chips, shell count chips, per-shell agent picks,
/// optional title, error banner, and the main launch CTA. Receives every
/// piece of state and every mutator as a prop so the parent Welcome
/// keeps owning the form state and this file stays pure layout / chrome.
import { AGENTS, type Agent, detectAgent } from "../agents";
import { pad2, shortenHome } from "../format";

import { SectionRule } from "./Chrome";
import { commitLabelFor, COUNT_OPTIONS, META, type Mode } from "./internals";

export function ComposerSection(props: {
  mode: Mode;
  path: string;
  shortPath: string;
  recents: string[];
  recentCommands: string[];
  home: string;
  count: number;
  commands: string[];
  title: string;
  saveAsPreset: boolean;
  showPerShell: boolean;
  error: string | null;
  onPickFolder: () => void;
  onAdoptRecent: (p: string) => void;
  onClearPath: () => void;
  onChangeCount: (n: number) => void;
  onApplyAgentToAll: (cmd: string) => void;
  onChangeCommand: (i: number, value: string) => void;
  onTogglePerShell: () => void;
  onChangeTitle: (v: string) => void;
  onToggleSave: (v: boolean) => void;
  onCommit: () => void;
  onDelete: () => void;
  numeral?: string;
}) {
  const {
    mode,
    path,
    shortPath,
    recents,
    recentCommands,
    home,
    count,
    commands,
    title,
    saveAsPreset,
    showPerShell,
    error,
    onPickFolder,
    onAdoptRecent,
    onClearPath,
    onChangeCount,
    onApplyAgentToAll,
    onChangeCommand,
    onTogglePerShell,
    onChangeTitle,
    onToggleSave,
    onCommit,
    onDelete,
    numeral,
  } = props;

  const isEdit = mode.kind === "edit";
  const isPresetMode = mode.kind !== "create";
  const requiresTitle = isPresetMode;
  const allEqual = commands.every((c) => c === commands[0]);
  const sharedDetected = allEqual ? detectAgent(commands[0] ?? "") : null;
  const commitLabel = commitLabelFor(mode);

  const sectionLabel =
    mode.kind === "edit"
      ? "Editing preset"
      : mode.kind === "createPreset"
        ? "New preset"
        : "Compose";
  const composerNumeral = mode.kind === "create" ? numeral : undefined;

  return (
    <section className="mb-11">
      <SectionRule
        label={sectionLabel}
        numeral={composerNumeral}
        right={<>{META}↵ launch</>}
        delay={260}
      />

      <div
        className="border border-rule bg-ink-1/40 opacity-0 animate-fade-up"
        style={{ animationDelay: "320ms" }}
      >
        <ComposerRow label="Folder">
          <FolderPicker
            path={path}
            shortPath={shortPath}
            home={home}
            onPick={onPickFolder}
            onClear={onClearPath}
          />
          {recents.length > 0 && (
            <RecentChips recents={recents} onPick={onAdoptRecent} />
          )}
        </ComposerRow>

        <ComposerRow
          label="Shells"
          right={
            <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted [font-feature-settings:'tnum']">
              {pad2(count)} · {count === 1 ? "shell" : "shells"}
            </span>
          }
        >
          <CountChips count={count} onChange={onChangeCount} />
        </ComposerRow>

        <ComposerRow
          label="Agents"
          right={
            count > 1 ? (
              <button
                type="button"
                onClick={onTogglePerShell}
                className="cursor-pointer font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors duration-150 hover:text-amber"
              >
                {showPerShell ? "collapse ▴" : "customize per shell ▾"}
              </button>
            ) : null
          }
        >
          {showPerShell && count > 1 ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-rule pb-3">
                <span className="text-[9.5px] uppercase tracking-[0.18em] text-fade">
                  apply to all
                </span>
                <div
                  role="radiogroup"
                  aria-label="Apply agent to every shell"
                  className="flex flex-wrap gap-1"
                >
                  {AGENTS.map((agent) => (
                    <AgentChip
                      key={agent.id}
                      agent={agent}
                      isActive={!allEqual ? false : sharedDetected === agent.id}
                      onClick={() => onApplyAgentToAll(agent.command)}
                    />
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {Array.from({ length: count }).map((_, i) => (
                  <ShellRow
                    key={i}
                    index={i}
                    command={commands[i] ?? ""}
                    onChange={(v) => onChangeCommand(i, v)}
                    recents={recentCommands}
                  />
                ))}
              </div>
            </>
          ) : (
            <ApplyAgentsRow
              sharedDetected={sharedDetected}
              divergent={!allEqual}
              onApply={onApplyAgentToAll}
            />
          )}
        </ComposerRow>

        <ComposerRow label={isPresetMode ? "Title" : "Title"}>
          <input
            value={title}
            onChange={(e) => onChangeTitle(e.target.value)}
            placeholder={
              requiresTitle
                ? "e.g. Frontend dev"
                : "optional · shows in sidebar"
            }
            className="w-full border border-rule bg-ink-1/60 px-3.5 py-2.5 font-mono text-[13px] tracking-[-0.005em] text-paper outline-none transition-colors duration-150 placeholder:text-faint focus:border-amber-soft focus:bg-amber/[0.03]"
          />
          {!isPresetMode && (
            <SaveAsPresetToggle
              checked={saveAsPreset}
              onToggle={onToggleSave}
            />
          )}
        </ComposerRow>

        {error && <ErrorBanner message={error} />}

        <div className="border-t border-rule px-5 py-5">
          <LaunchCTA
            label={commitLabel}
            count={count}
            onClick={onCommit}
            extraButton={
              isEdit ? (
                <button
                  type="button"
                  onClick={onDelete}
                  className="cursor-pointer border border-rule bg-transparent px-3.5 py-3.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-faint transition-colors duration-150 hover:border-coral/45 hover:bg-coral/5 hover:text-coral"
                >
                  delete preset
                </button>
              ) : null
            }
          />
        </div>
      </div>
    </section>
  );
}

function ComposerRow({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-6 border-b border-rule px-5 py-5">
      <div className="pt-1.5 text-[10.5px] uppercase tracking-[0.18em] text-faint">
        {label}
      </div>
      <div className="min-w-0">
        {right && (
          <div className="mb-2 flex items-baseline justify-end">{right}</div>
        )}
        {children}
      </div>
    </div>
  );
}

function FolderPicker({
  path,
  shortPath,
  home,
  onPick,
  onClear,
}: {
  path: string;
  shortPath: string;
  home: string;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-stretch gap-2">
      <button
        type="button"
        onClick={onPick}
        className="group grid min-w-0 flex-1 cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 border border-rule bg-white/[0.012] px-3.5 py-2.5 text-left font-mono text-[13px] tracking-[-0.01em] text-paper transition-colors duration-200 hover:border-amber-soft hover:bg-amber/[0.04]"
      >
        <span className="font-mono text-[14px] leading-none text-amber opacity-80">
          /
        </span>
        <span
          className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${
            path ? "" : "text-[12.5px] tracking-[-0.005em] text-faint"
          }`}
        >
          {path ? shortPath : "select a folder…"}
        </span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-faint transition-colors duration-200 group-hover:text-amber">
          {META}O · browse ↗
        </span>
      </button>
      {path && home && path !== home && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Reset to home directory"
          title="Reset to home directory"
          className="cursor-pointer border border-rule px-3 font-mono text-[12px] text-faint transition-colors duration-150 hover:border-amber-soft hover:text-amber"
        >
          ×
        </button>
      )}
    </div>
  );
}

function RecentChips({
  recents,
  onPick,
}: {
  recents: string[];
  onPick: (p: string) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[9.5px] uppercase tracking-[0.18em] text-fade">
        recent
      </span>
      {recents.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onPick(r)}
          title={r}
          className="cursor-pointer border border-rule bg-transparent px-2 py-0.5 font-mono text-[10.5px] tracking-[-0.005em] text-muted transition-colors duration-150 hover:border-amber-soft hover:text-paper"
        >
          {shortenHome(r)}
        </button>
      ))}
    </div>
  );
}

const CUSTOM_COUNT_MIN = 1;
const CUSTOM_COUNT_MAX = 32;

function CountChips({
  count,
  onChange,
}: {
  count: number;
  onChange: (n: number) => void;
}) {
  // The custom chip is active whenever the count isn't one of the
  // presets. Shows the live count inside its input so the user can
  // see what they're sitting on; clicking a preset clears focus from
  // the custom input and snaps count to the preset value.
  const customActive = !COUNT_OPTIONS.includes(
    count as (typeof COUNT_OPTIONS)[number],
  );
  return (
    <div
      role="radiogroup"
      aria-label="Terminal count"
      className="grid grid-cols-7 gap-1.5"
    >
      {COUNT_OPTIONS.map((n) => {
        const isActive = n === count;
        return (
          // Styled custom radio: a real <input type="radio"> wouldn't
          // render the chip shape we want, but `role="radio"` +
          // `aria-checked` on a button is the documented ARIA pattern
          // for the same widget. Container is `role="radiogroup"` above.
          // biome-ignore lint/a11y/useSemanticElements: visually custom radio widget — keeping <button role="radio"> rather than restyling a native input
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(n)}
            className={`relative cursor-pointer border px-0 py-3 font-mono text-[16px] font-medium leading-none tracking-[-0.01em] transition-colors duration-200 [font-feature-settings:'tnum'] active:scale-95 ${
              isActive
                ? "border-amber bg-amber/[0.08] text-amber shadow-[0_0_24px_color-mix(in_srgb,_var(--color-amber)_18%,_transparent)_inset]"
                : "border-rule bg-transparent text-muted hover:border-amber-soft hover:bg-amber/[0.04] hover:text-paper"
            }`}
          >
            {pad2(n)}
          </button>
        );
      })}
      <CustomCountChip
        count={count}
        active={customActive}
        onChange={onChange}
      />
    </div>
  );
}

function CustomCountChip({
  count,
  active,
  onChange,
}: {
  count: number;
  active: boolean;
  onChange: (n: number) => void;
}) {
  // Tied directly to `count` when active, but keeps "" while empty so
  // the user can clear and retype without snapping back to 1 mid-edit.
  // On blur with no value we restore the last committed count via the
  // parent prop (no local state to drift out of sync).
  return (
    <label
      aria-label="Custom terminal count"
      className={`relative flex cursor-text items-center justify-center border px-0 py-3 font-mono text-[16px] font-medium leading-none tracking-[-0.01em] transition-colors duration-200 [font-feature-settings:'tnum'] ${
        active
          ? "border-amber bg-amber/[0.08] text-amber shadow-[0_0_24px_color-mix(in_srgb,_var(--color-amber)_18%,_transparent)_inset]"
          : "border-rule bg-transparent text-muted hover:border-amber-soft hover:bg-amber/[0.04] hover:text-paper"
      }`}
    >
      <input
        type="number"
        inputMode="numeric"
        min={CUSTOM_COUNT_MIN}
        max={CUSTOM_COUNT_MAX}
        value={active ? String(count) : ""}
        placeholder="N"
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return;
          const n = Math.floor(Number(raw));
          if (!Number.isFinite(n)) return;
          const clamped = Math.min(
            CUSTOM_COUNT_MAX,
            Math.max(CUSTOM_COUNT_MIN, n),
          );
          onChange(clamped);
        }}
        className="w-full border-0 bg-transparent text-center text-current outline-none [appearance:textfield] placeholder:text-faint focus:outline-none focus:ring-0 [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
      />
    </label>
  );
}

function ApplyAgentsRow({
  sharedDetected,
  divergent,
  onApply,
}: {
  sharedDetected: ReturnType<typeof detectAgent> | null;
  divergent: boolean;
  onApply: (cmd: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div
        role="radiogroup"
        aria-label="Agent for all shells"
        className="flex flex-wrap gap-1.5"
      >
        {AGENTS.map((agent) => (
          <AgentChip
            key={agent.id}
            agent={agent}
            isActive={!divergent && sharedDetected === agent.id}
            onClick={() => onApply(agent.command)}
          />
        ))}
      </div>
      {!divergent && sharedDetected === "custom" && (
        <span className="inline-flex items-center border border-amber/30 bg-amber/[0.05] px-2 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-amber">
          custom
        </span>
      )}
      {divergent && (
        <span className="ml-1 text-[10.5px] uppercase tracking-[0.16em] text-faint">
          shells differ — click to overwrite
        </span>
      )}
    </div>
  );
}

function AgentChip({
  agent,
  isActive,
  onClick,
}: {
  agent: Agent;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    // Custom radio chip — same rationale as the count chips above.
    // biome-ignore lint/a11y/useSemanticElements: styled radio widget
    <button
      type="button"
      role="radio"
      aria-checked={isActive}
      onClick={onClick}
      title={agent.hint ?? (agent.command || agent.label)}
      className={`cursor-pointer border px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] transition-colors duration-150 ${
        isActive
          ? "border-amber bg-amber/[0.08] text-amber"
          : "border-rule bg-transparent text-muted hover:border-amber-soft hover:text-paper"
      }`}
    >
      {agent.label}
    </button>
  );
}

function ShellRow({
  index,
  command,
  onChange,
  recents,
}: {
  index: number;
  command: string;
  onChange: (v: string) => void;
  recents: string[];
}) {
  const detected = detectAgent(command);
  const visibleRecents = recents.filter((r) => r !== command).slice(0, 4);
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-3 border border-rule bg-white/[0.012] px-2.5 py-2">
      <span className="pt-2 text-center font-mono text-[11.5px] font-medium leading-none text-faint [font-feature-settings:'tnum']">
        {pad2(index + 1)}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div
          className="flex flex-wrap gap-1"
          role="radiogroup"
          aria-label={`Agent for shell ${index + 1}`}
        >
          {AGENTS.map((agent) => (
            <AgentChip
              key={agent.id}
              agent={agent}
              isActive={detected === agent.id}
              onClick={() => onChange(agent.command)}
            />
          ))}
        </div>
        <input
          value={command}
          onChange={(e) => onChange(e.target.value)}
          placeholder="no startup command — or type a custom one"
          className="w-full min-w-0 border border-rule bg-ink-1/60 px-3 py-1.5 font-mono text-[12px] tracking-[-0.005em] text-paper outline-none transition-colors duration-150 placeholder:text-faint focus:border-amber-soft focus:bg-amber/[0.03]"
        />
        {visibleRecents.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[9.5px] uppercase tracking-[0.18em] text-fade">
              recent
            </span>
            {visibleRecents.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => onChange(r)}
                title={r}
                className="cursor-pointer truncate border border-rule bg-transparent px-1.5 py-0.5 font-mono text-[10px] tracking-[-0.005em] text-muted transition-colors duration-150 hover:border-amber-soft hover:text-paper"
                style={{ maxWidth: 200 }}
              >
                {r.length > 28 ? r.slice(0, 28) + "…" : r}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SaveAsPresetToggle({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <label className="mt-3 flex cursor-pointer items-center gap-3 border border-rule bg-white/[0.012] px-3.5 py-2.5 transition-colors duration-150 hover:border-amber-soft hover:bg-amber/[0.025]">
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] transition-colors ${
          checked
            ? "border-amber bg-amber/20 text-amber"
            : "border-rule text-transparent"
        }`}
        aria-hidden
      >
        ✓
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        className="sr-only"
      />
      <span className="flex flex-col text-left">
        <span className="text-[12px] font-medium tracking-[-0.005em] text-paper">
          Save as preset
        </span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-faint">
          one-click launch later — uses the title above
        </span>
      </span>
    </label>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mx-5 my-4 flex items-start gap-3 border border-coral/25 bg-coral/[0.06] px-3.5 py-2.5 font-mono text-xs tracking-[-0.005em] text-coral animate-fade-up"
    >
      <span className="font-mono text-base font-bold leading-none">!</span>
      <span>{message}</span>
    </div>
  );
}

function LaunchCTA({
  label,
  count,
  onClick,
  extraButton,
}: {
  label: string;
  count: number;
  onClick: () => void;
  extraButton?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        onClick={onClick}
        className="launch-sweep group grid flex-1 cursor-pointer grid-cols-[1fr_auto_auto_auto] items-center gap-[18px] border border-paper bg-paper px-[22px] py-[18px] font-mono tracking-[-0.005em] text-ink-0 transition-colors duration-200 hover:border-amber hover:bg-amber active:translate-y-px"
      >
        <span className="text-left text-sm font-medium">{label}</span>
        <span className="border-l border-black/[0.18] pl-4 text-[10.5px] uppercase tracking-[0.18em] text-black/55 group-hover:border-black/30 group-hover:text-black/70 [font-feature-settings:'tnum']">
          {pad2(count)} · {count === 1 ? "shell" : "shells"}
        </span>
        <span className="border-l border-black/[0.18] pl-4 text-[10px] uppercase tracking-[0.18em] text-black/45 group-hover:border-black/30 group-hover:text-black/70">
          {META}↵
        </span>
        <span className="text-base transition-transform duration-200 group-hover:translate-x-1">
          →
        </span>
      </button>
      {extraButton}
    </div>
  );
}
