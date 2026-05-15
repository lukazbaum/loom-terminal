import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/// Shared secondary-button atom: the bordered, transparent, uppercase
/// font-mono tracking-wide button used by dialog actions, settings
/// rows, theme editor headers, etc. Six+ near-identical class strings
/// across ConfirmDialog / ConfirmCloseModal / SettingsPage /
/// ThemeEditor (×4) collapse here so a hover/border palette tweak
/// lands in one place.
///
/// Three size variants cover every call site we have today:
///   - `md`  — px-4 py-2  text-[11px]   (dialog action buttons)
///   - `sm`  — px-3.5 py-1.5 text-[10.5px] (ThemeEditor confirms)
///   - `row` — px-3 py-1.5 text-[10.5px] (list-row toggles)
///
/// Callers needing a one-off can still hand-roll, but prefer this
/// over copying a 130-char tailwind string for the seventh time.

type Size = "md" | "sm" | "row";

const BASE =
  "cursor-pointer border border-rule bg-transparent font-mono uppercase tracking-[0.16em] text-muted transition-colors duration-150 hover:border-paper hover:text-paper disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-rule disabled:hover:text-muted";

const SIZE_CLASS: Record<Size, string> = {
  md: "px-4 py-2 text-[11px]",
  sm: "px-3.5 py-1.5 text-[10.5px]",
  row: "px-3 py-1.5 text-[10.5px]",
};

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  size?: Size;
  /// Extra classes appended after the base — useful for layout
  /// adjustments (`ml-auto`, `flex w-full items-center`, etc.) without
  /// having to re-specify the appearance.
  className?: string;
  children: ReactNode;
};

export const SecondaryButton = forwardRef<HTMLButtonElement, Props>(
  function SecondaryButton(
    { size = "md", className = "", type = "button", children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={`${BASE} ${SIZE_CLASS[size]} ${className}`}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
