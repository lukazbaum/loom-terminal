import { useEffect, useMemo, useRef, useState } from "react";

import { SHORTCUT_GROUPS } from "./shortcuts";
import { setSetting, useSettings } from "./settings";
import {
  BUILTIN_DARK_ID,
  getThemeOrDefault,
  useThemes,
  type Theme,
} from "./themes";
import { ThemeChip } from "./ThemeChip";

export function SettingsPage({
  onClose,
  onOpenThemeEditor,
}: {
  onClose: () => void;
  onOpenThemeEditor: () => void;
}) {
  const settings = useSettings();
  const themes = useThemes();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeTheme = getThemeOrDefault(settings.activeThemeId);

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-ink-0">
      <div className="mx-auto max-w-[760px] px-10 py-12">
        <div className="mb-10 flex items-baseline justify-between">
          <h1 className="m-0 font-sans text-[28px] font-medium tracking-[-0.02em] text-paper">
            Settings
          </h1>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer border border-rule bg-transparent px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted transition-colors duration-150 hover:border-paper hover:text-paper"
          >
            Done
          </button>
        </div>

        <section className="mb-10">
          <h2 className="mb-5 font-sans text-[11px] font-semibold uppercase tracking-[0.22em] text-faint">
            Appearance
          </h2>
          <div className="border-t border-rule/40">
            <SettingRow
              label="Theme"
              hint="Pick a built-in theme or create your own. Terminal panes follow the active theme too."
              control={
                <div className="flex items-center gap-2">
                  <ThemePicker
                    themes={themes}
                    activeId={settings.activeThemeId}
                    onChange={(id) => setSetting("activeThemeId", id)}
                  />
                  <button
                    type="button"
                    onClick={onOpenThemeEditor}
                    className="cursor-pointer border border-rule bg-transparent px-3 py-[5px] font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors duration-150 hover:border-paper hover:text-paper"
                  >
                    Customize
                  </button>
                </div>
              }
            />
            <SettingRow
              label="Active palette"
              hint={
                activeTheme.isBuiltin
                  ? "Built-in theme. Duplicate it from Customize to tweak the colors."
                  : "Custom theme. Open Customize to edit the colors."
              }
              control={<ThemeSwatchRow tokens={activeTheme.tokens} />}
            />
            <SettingRow
              label="Show Claude usage in header"
              hint="Two pills in the top-left show your Claude.ai 5h and 7d rate-limit windows. Only appears for subscription users — turn off to hide them."
              control={
                <Toggle
                  checked={settings.showClaudeUsage}
                  onChange={(v) => setSetting("showClaudeUsage", v)}
                />
              }
            />
          </div>
        </section>

        <section className="mb-10">
          <h2 className="mb-5 font-sans text-[11px] font-semibold uppercase tracking-[0.22em] text-faint">
            Terminal
          </h2>
          <div className="border-t border-rule/40">
            <SettingRow
              label="Font size"
              hint="Applies to every terminal pane."
              control={
                <NumberStepper
                  value={settings.terminalFontSize}
                  min={9}
                  max={28}
                  step={0.5}
                  onChange={(v) => setSetting("terminalFontSize", v)}
                  format={(v) => `${v}px`}
                />
              }
            />
            <SettingRow
              label="Idle quiet window"
              hint="How long a pane has to stay silent before it counts as idle for completion signals."
              control={
                <NumberStepper
                  value={settings.idleQuietMs}
                  min={200}
                  max={30_000}
                  step={100}
                  onChange={(v) => setSetting("idleQuietMs", v)}
                  format={(v) => `${(v / 1000).toFixed(v < 1000 ? 2 : 1)} s`}
                />
              }
            />
            <SettingRow
              label="⌘R restarts active pane"
              hint="Off by default — Cmd+R is muscle memory for browser reload, so we only act on it when you opt in."
              control={
                <Toggle
                  checked={settings.restartShortcutEnabled}
                  onChange={(v) => setSetting("restartShortcutEnabled", v)}
                />
              }
            />
          </div>
        </section>

        <section className="mb-10">
          <h2 className="mb-5 font-sans text-[11px] font-semibold uppercase tracking-[0.22em] text-faint">
            Keyboard Shortcuts
          </h2>
          <div className="flex flex-col gap-8">
            {SHORTCUT_GROUPS.map((group) => (
              <div key={group.title}>
                <h3 className="mb-2 font-sans text-[10px] font-medium uppercase tracking-[0.2em] text-muted">
                  {group.title}
                </h3>
                <div className="border-t border-rule/40">
                  {group.items.map((s) => (
                    <div
                      key={s.combo + s.label}
                      className="flex items-center justify-between border-b border-rule/40 py-2.5"
                    >
                      <span className="text-[13px] text-paper">{s.label}</span>
                      <span className="font-mono text-[12px] tracking-[0.02em] text-amber/85">
                        {s.combo}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-rule/40 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] text-paper">{label}</span>
        {hint && (
          <span className="text-[11px] leading-[1.5] text-faint">{hint}</span>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function NumberStepper({
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const clampStep = (delta: number) => {
    const next = Math.round((value + delta) / step) * step;
    if (next < min || next > max) return;
    // Avoid 13.4999999 — snap to a sensible precision.
    onChange(parseFloat(next.toFixed(2)));
  };
  return (
    <div className="inline-flex items-center gap-1.5 border border-rule bg-ink-1/60">
      <button
        type="button"
        onClick={() => clampStep(-step)}
        disabled={value <= min}
        className="cursor-pointer px-2 py-1 font-mono text-[12px] text-muted transition-colors duration-100 hover:bg-ink-2 hover:text-paper disabled:cursor-not-allowed disabled:opacity-30"
        aria-label="Decrease"
      >
        −
      </button>
      <span className="min-w-[44px] text-center font-mono text-[12px] tabular-nums text-paper [font-feature-settings:'tnum']">
        {format ? format(value) : value}
      </span>
      <button
        type="button"
        onClick={() => clampStep(step)}
        disabled={value >= max}
        className="cursor-pointer px-2 py-1 font-mono text-[12px] text-muted transition-colors duration-100 hover:bg-ink-2 hover:text-paper disabled:cursor-not-allowed disabled:opacity-30"
        aria-label="Increase"
      >
        +
      </button>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 cursor-pointer items-center border transition-colors duration-150 ${
        checked ? "border-amber/55 bg-amber/[0.10]" : "border-rule bg-ink-2"
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-3 w-3 transition-transform duration-150 ${
          checked ? "translate-x-[18px] bg-amber" : "translate-x-[3px] bg-faint"
        }`}
      />
    </button>
  );
}

/// Custom dropdown picker for the active theme. Renders a Loom-styled
/// trigger (palette chip + name + appearance + caret) and a popover
/// panel grouped by built-in / custom. Replaces the native <select>
/// so the theme picker stays consistent with the rest of the chrome —
/// the native control inherited macOS system styling that clashed with
/// the app's flat, mono-spaced UI.
function ThemePicker({
  themes,
  activeId,
  onChange,
}: {
  themes: Theme[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Flatten to one ordered list for keyboard nav. Memoized so a
  // re-render of an unrelated parent (e.g. font-size setting) doesn't
  // re-split the registry every time.
  const { builtins, customs, ordered, active } = useMemo(() => {
    const b = themes.filter((t) => t.isBuiltin);
    const c = themes.filter((t) => !t.isBuiltin);
    const ord = [...b, ...c];
    const a =
      themes.find((t) => t.id === activeId) ??
      getThemeOrDefault(BUILTIN_DARK_ID);
    return { builtins: b, customs: c, ordered: ord, active: a };
  }, [themes, activeId]);

  // Keyboard focus tracking. Index into `ordered`. Initialized to the
  // active theme each time the menu opens.
  const [focused, setFocused] = useState(0);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    const initial = Math.max(
      0,
      ordered.findIndex((t) => t.id === activeId),
    );
    setFocused(initial);
  }, [open, ordered, activeId]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[focused]?.focus();
  }, [open, focused]);

  // Click-outside + Escape both dismiss.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
  }

  function onListKey(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((i) => (i + 1) % ordered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((i) => (i - 1 + ordered.length) % ordered.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setFocused(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setFocused(ordered.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const target = ordered[focused];
      if (target) pick(target.id);
    }
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-[26px] cursor-pointer items-center gap-2 border bg-ink-1 pl-1.5 pr-2.5 transition-colors duration-150 ${
          open ? "border-amber/55" : "border-rule hover:border-paper/60"
        }`}
      >
        <ThemeChip tokens={active.tokens} />
        <span className="font-mono text-[11px] tracking-[-0.005em] text-paper">
          {active.name}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-faint">
          {active.appearance}
        </span>
        <span
          aria-hidden
          className={`font-mono text-[9px] text-muted transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          onKeyDown={onListKey}
          className="absolute right-0 top-[calc(100%+4px)] z-30 min-w-[220px] max-w-[320px] border border-rule bg-ink-1 py-1 shadow-[0_18px_40px_rgba(0,0,0,0.5)]"
        >
          <ThemePickerGroup
            title="Built-in"
            themes={builtins}
            indexOffset={0}
            activeId={activeId}
            focusedIndex={focused}
            optionRefs={optionRefs}
            onPick={pick}
            onHover={setFocused}
          />
          {customs.length > 0 && (
            <ThemePickerGroup
              title="Custom"
              themes={customs}
              indexOffset={builtins.length}
              activeId={activeId}
              focusedIndex={focused}
              optionRefs={optionRefs}
              onPick={pick}
              onHover={setFocused}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ThemePickerGroup({
  title,
  themes,
  indexOffset,
  activeId,
  focusedIndex,
  optionRefs,
  onPick,
  onHover,
}: {
  title: string;
  themes: Theme[];
  /// Position of this group's first row in the flat keyboard-nav list.
  indexOffset: number;
  activeId: string;
  focusedIndex: number;
  optionRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  onPick: (id: string) => void;
  onHover: (flatIndex: number) => void;
}) {
  return (
    <div className="py-0.5">
      <div className="px-3 py-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-faint">
        {title}
      </div>
      {themes.map((t, i) => {
        const flatIndex = indexOffset + i;
        const active = t.id === activeId;
        const focused = flatIndex === focusedIndex;
        return (
          <button
            key={t.id}
            ref={(el) => {
              optionRefs.current[flatIndex] = el;
            }}
            type="button"
            role="option"
            aria-selected={active}
            tabIndex={focused ? 0 : -1}
            onClick={() => onPick(t.id)}
            onMouseEnter={() => onHover(flatIndex)}
            className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 focus:outline-none ${
              focused
                ? "bg-amber/[0.10] text-paper"
                : active
                  ? "bg-amber/[0.05] text-paper"
                  : "text-muted hover:bg-ink-2 hover:text-paper"
            }`}
          >
            <ThemeChip tokens={t.tokens} />
            <span className="flex-1 truncate font-mono text-[11px] tracking-[-0.005em]">
              {t.name}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-faint">
              {t.appearance}
            </span>
            <span
              aria-hidden
              className={`font-mono text-[10px] text-amber ${
                active ? "" : "invisible"
              }`}
            >
              ●
            </span>
          </button>
        );
      })}
    </div>
  );
}

/// Five-swatch palette preview. Shows the most representative tokens
/// (background, surface, accent, danger, success) so the user can see
/// at a glance what the active theme looks like without opening the
/// editor.
function ThemeSwatchRow({
  tokens,
}: {
  tokens: import("./themes").ThemeTokens;
}) {
  const swatches: { label: string; color: string }[] = [
    { label: "Background", color: tokens.ink0 },
    { label: "Surface", color: tokens.ink2 },
    { label: "Body text", color: tokens.paper },
    { label: "Accent", color: tokens.amber },
    { label: "Danger", color: tokens.coral },
    { label: "Success", color: tokens.mint },
  ];
  return (
    <div className="flex items-center gap-1">
      {swatches.map((s) => (
        <span
          key={s.label}
          role="img"
          title={`${s.label} — ${s.color}`}
          aria-label={`${s.label} — ${s.color}`}
          className="block h-5 w-5 border border-rule/70"
          style={{ backgroundColor: s.color }}
        />
      ))}
    </div>
  );
}
