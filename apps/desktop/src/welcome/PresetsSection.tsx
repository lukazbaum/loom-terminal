/// Saved-preset rail: the "one click to relaunch" sidebar in the right
/// column of the Welcome view. Empty state is its own component because
/// the populated grid has a different layout and animation hook.
import { useMemo } from "react";

import { pad2, shortenHome } from "../format";
import type { Preset } from "../presets";

import { SectionRule } from "./Chrome";
import { META, summarizeCommands } from "./internals";

export function PresetsSection({
  presets,
  onLaunch,
  onEdit,
  onCreate,
}: {
  presets: Preset[];
  onLaunch: (preset: Preset) => void;
  onEdit: (preset: Preset) => void;
  onCreate: () => void;
}) {
  const right =
    presets.length === 0 ? (
      "save one for instant launch"
    ) : (
      <>
        {pad2(presets.length)} saved · {META}1–{META}9 quick launch
      </>
    );
  return (
    <section className="mb-10">
      <SectionRule label="Presets" numeral="02" right={right} delay={400} />
      {presets.length === 0 ? (
        <PresetsEmptyHint onCreate={onCreate} />
      ) : (
        <div
          className="grid grid-cols-2 gap-2 opacity-0 animate-fade-up sm:grid-cols-3 lg:grid-cols-1"
          style={{ animationDelay: "460ms" }}
        >
          {presets.map((p, i) => (
            <PresetCard
              key={p.id}
              preset={p}
              hotkey={i < 9 ? `${META}${i + 1}` : undefined}
              onLaunch={onLaunch}
              onEdit={onEdit}
            />
          ))}
          <CreatePresetTile onClick={onCreate} />
        </div>
      )}
    </section>
  );
}

function PresetsEmptyHint({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      className="grid grid-cols-[1fr_auto] items-center gap-4 border border-dashed border-rule bg-white/[0.012] px-5 py-4 opacity-0 animate-fade-up"
      style={{ animationDelay: "460ms" }}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium tracking-[-0.005em] text-paper">
          No presets yet.
        </span>
        <span className="text-[11.5px] leading-[1.55] text-muted">
          Save any workspace as a preset and it lands here for one-click
          relaunch — folder, shell count, and agent picks all preserved.
        </span>
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="cursor-pointer border border-rule bg-transparent px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted transition-colors duration-150 hover:border-amber-soft hover:text-amber"
      >
        + new preset
      </button>
    </div>
  );
}

function PresetCard({
  preset,
  hotkey,
  onLaunch,
  onEdit,
}: {
  preset: Preset;
  hotkey?: string;
  onLaunch: (preset: Preset) => void;
  onEdit: (preset: Preset) => void;
}) {
  const summary = useMemo(
    () => summarizeCommands(preset.commands),
    [preset.commands],
  );
  const shortPath = useMemo(() => shortenHome(preset.path), [preset.path]);
  return (
    <div className="group relative flex border border-rule bg-white/[0.012] transition-colors duration-150 hover:border-amber-soft hover:bg-amber/[0.025]">
      <button
        type="button"
        onClick={() => onLaunch(preset)}
        title={`${preset.name}\n${shortPath}\n${summary}`}
        className="grid min-w-0 flex-1 cursor-pointer grid-cols-[auto_1fr] items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-amber/40 bg-amber/[0.05] font-mono text-[13px] font-medium tabular-nums leading-none text-amber [font-feature-settings:'tnum']">
          {pad2(preset.count)}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex w-full items-baseline gap-2">
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium tracking-[-0.005em] text-paper">
              {preset.name}
            </span>
            {hotkey && (
              <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-fade transition-colors duration-150 group-hover:text-faint">
                {hotkey}
              </span>
            )}
          </span>
          <span className="block w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10.5px] tracking-[-0.005em] text-faint">
            {shortPath}
          </span>
          <span className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-[9.5px] uppercase tracking-[0.16em] text-muted">
            {summary}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(preset);
        }}
        aria-label={`Edit ${preset.name}`}
        title={`Edit ${preset.name}`}
        className="flex w-7 shrink-0 cursor-pointer items-center justify-center text-[11px] text-faint opacity-0 transition-all duration-150 hover:text-amber focus:opacity-100 group-hover:opacity-100"
      >
        ✎
      </button>
    </div>
  );
}

function CreatePresetTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Create preset"
      className="group grid min-h-[60px] cursor-pointer grid-cols-[auto_1fr] items-center gap-3 border border-dashed border-rule bg-transparent px-3 py-2.5 transition-colors duration-150 hover:border-amber-soft hover:bg-amber/[0.025]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-dashed border-rule bg-transparent font-mono text-[18px] font-light leading-none text-faint transition-colors duration-150 group-hover:border-amber-soft group-hover:text-amber">
        +
      </span>
      <span className="text-[11px] uppercase tracking-[0.16em] text-muted transition-colors duration-150 group-hover:text-amber">
        new preset
      </span>
    </button>
  );
}
