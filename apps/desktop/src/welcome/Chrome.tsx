/// Welcome chrome: top header (brand or "back" pill), the headline / status
/// hero, and the small section-rule label used by both PresetsSection and
/// ComposerSection. Pure presentation — no side effects, no app state.
import type { Mode, Status } from "./internals";

export function Header({
  mode,
  onCancel,
  onExitPresetMode,
}: {
  mode: Mode;
  onCancel?: () => void;
  onExitPresetMode: () => void;
}) {
  const inPresetMode = mode.kind !== "create";
  return (
    <header className="mb-9 flex items-center gap-3">
      {inPresetMode ? (
        <button
          type="button"
          onClick={onExitPresetMode}
          title="Back to workspace setup (Esc)"
          className="group inline-flex cursor-pointer items-center gap-2 border border-rule bg-transparent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted transition-colors duration-200 hover:border-amber-soft hover:text-amber"
        >
          <span className="text-[13px] leading-none transition-transform duration-200 group-hover:-translate-x-0.5">
            ←
          </span>
          <span>back</span>
          <span className="border-l border-rule pl-2 text-[9.5px] tracking-[0.12em] text-fade group-hover:border-amber/30 group-hover:text-amber/70">
            esc
          </span>
        </button>
      ) : (
        <>
          <span className="brand-mark h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="font-sans text-[16px] font-semibold tracking-[-0.01em] text-paper">
            Loom
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-2 text-[10.5px] uppercase tracking-[0.1em] text-faint">
        {inPresetMode && (
          <span className="rounded-sm border border-amber/40 bg-amber/[0.06] px-2 py-0.5 tracking-[0.08em] text-amber">
            {mode.kind === "edit" ? "editing preset" : "new preset"}
          </span>
        )}
        {!inPresetMode && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-sm border border-rule px-2 py-0.5 tracking-[0.08em] text-muted transition-colors duration-200 hover:border-coral/45 hover:text-coral"
          >
            cancel
          </button>
        )}
      </span>
    </header>
  );
}

export function Hero({ status, mode }: { status: Status; mode: Mode }) {
  // Glow uses `color-mix` against the active token so custom themes
  // get a matching halo instead of a hardcoded green / amber rgba.
  const dot =
    status.tone === "mint"
      ? "bg-mint shadow-[0_0_8px_color-mix(in_oklab,var(--color-mint)_55%,transparent)] animate-pulse-mint"
      : "bg-amber animate-pulse-amber";
  const label = status.tone === "mint" ? "text-mint" : "text-amber";

  let headline: React.ReactNode;
  let sub: React.ReactNode;
  if (mode.kind === "edit") {
    headline = (
      <>
        Edit the <em className="not-italic font-semibold text-amber">preset</em>
        .
      </>
    );
    sub = "Tweak the path, count, or per-shell agents — saved on commit.";
  } else if (mode.kind === "createPreset") {
    headline = (
      <>
        Save a <em className="not-italic font-semibold text-amber">preset</em>{" "}
        for one-click launch.
      </>
    );
    sub = "Configure once. Launch the same workspace forever after.";
  } else {
    headline = (
      <>
        Open a{" "}
        <em className="not-italic font-semibold text-amber">workspace</em>.
      </>
    );
    sub = (
      <>
        Compose a new one below — folder, shell count, agents — or jump back
        into a saved preset.
      </>
    );
  }

  return (
    <section
      className="mb-11 opacity-0 animate-fade-up"
      style={{ animationDelay: "60ms" }}
    >
      <div className="mb-5 inline-flex items-center gap-2 text-[10.5px] uppercase tracking-[0.18em] text-faint">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className={label}>{status.label}</span>
        <span className="opacity-40">—</span>
        <span>{status.detail}</span>
      </div>
      <h1 className="m-0 mb-3.5 font-sans text-[40px] font-medium leading-[1.05] tracking-[-0.025em] text-paper">
        {headline}
      </h1>
      <p className="m-0 max-w-[520px] text-[13px] leading-[1.65] tracking-[-0.005em] text-muted">
        {sub}
      </p>
    </section>
  );
}

export function SectionRule({
  label,
  numeral,
  right,
  delay,
}: {
  label: string;
  numeral?: string;
  right?: React.ReactNode;
  delay: number;
}) {
  return (
    <div
      className="mb-4 flex items-end justify-between gap-3 opacity-0 animate-fade-up"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-baseline gap-3">
        {numeral && (
          <span className="font-mono text-[11px] tabular-nums text-faint [font-feature-settings:'tnum']">
            {numeral}
          </span>
        )}
        <span className="text-[10.5px] uppercase tracking-[0.18em] text-faint">
          {label}
        </span>
      </div>
      {right && (
        <span className="text-[10.5px] uppercase tracking-[0.16em] text-muted">
          {right}
        </span>
      )}
    </div>
  );
}
