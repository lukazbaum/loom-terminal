/// Toolbar atoms — the iconography and button shell used by the top bar
/// (settings, ports, theme editor toggles). Kept separate from
/// SettingsPage so the toolbar shell can render even when no settings
/// panel is mounted.

export type ToolbarTone = "amber" | "mint";

export function PortsIcon({ className }: { className?: string }) {
  return (
    // Decorative icon — the wrapping `ToolbarButton` provides the
    // accessible name via `aria-label`. We mark the SVG explicitly
    // `role="img"` with a hidden title so assistive tech that ignores
    // `aria-hidden` (some screen readers in some modes) still gets a
    // meaningful name if it lands on the glyph directly.
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="Ports"
    >
      <title>Ports</title>
      {/* globe-ish glyph: circle + meridians */}
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 0 1 0 18a13 13 0 0 1 0-18" />
    </svg>
  );
}

export function ToolbarButton({
  icon,
  label,
  shortcut,
  description,
  tone,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  description?: string;
  tone: ToolbarTone;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const activeClass =
    tone === "amber"
      ? "border-amber/45 bg-amber/[0.08] text-amber"
      : "border-mint/45 bg-mint/[0.06] text-mint";
  const idleClass =
    "border-transparent text-muted hover:border-rule hover:bg-ink-2 hover:text-paper";
  const tooltip = [description ?? label, shortcut].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-tauri-drag-region="false"
      aria-label={label}
      aria-pressed={active}
      title={tooltip}
      className={`group/tb relative flex h-[24px] cursor-pointer items-center gap-1.5 border px-2 text-[10.5px] font-medium tracking-[-0.005em] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-muted ${
        active ? activeClass : idleClass
      }`}
    >
      <span className="flex h-[13px] w-[13px] items-center justify-center">
        {icon}
      </span>
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

export function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 inline-block h-3 w-px bg-rule" />;
}

export function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="Settings"
    >
      <title>Settings</title>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
