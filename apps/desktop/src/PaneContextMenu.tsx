import { useEffect, useRef, useState } from "react";

export type PaneMenuItem = {
  id: string;
  label: string;
  shortcut?: string;
  /// Optional tone for destructive actions ("close", "discard").
  tone?: "neutral" | "danger";
  disabled?: boolean;
  onClick: () => void;
};

type Props = {
  items: PaneMenuItem[];
  /// Anchor coordinates in viewport CSS pixels (e.g. event.clientX/Y).
  x: number;
  y: number;
  onClose: () => void;
};

/// Floating menu used by the right-click handler on pane cards. Renders
/// at viewport coords; closes on Esc, outside click, or after picking
/// an item. Sized to fit content; clamped within the window.
///
/// Keyboard model: focus enters the menu on mount (first enabled item),
/// `↓` / `↑` cycle through enabled items, `Home` / `End` jump to the
/// first / last, and `Enter` / `Space` activate. This matches the WAI-
/// ARIA "menu" authoring practice — without it, the `role="menu"` +
/// `role="menuitem"` markup misleads assistive tech into expecting
/// navigation that didn't exist.
export function PaneContextMenu({ items, x, y, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState({ left: x, top: y });

  // Index of the first / last enabled item — cached for Home/End handling.
  const firstEnabled = items.findIndex((i) => !i.disabled);
  const lastEnabled = (() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (!items[i]?.disabled) return i;
    }
    return -1;
  })();

  // Move focus to the first enabled item on mount so the menu is
  // operable by keyboard the moment it opens.
  useEffect(() => {
    if (firstEnabled < 0) return;
    itemRefs.current[firstEnabled]?.focus();
  }, [firstEnabled]);

  // Step from `from` by `delta` (±1), wrapping at the ends, skipping
  // disabled items. Returns -1 if no enabled item exists (all disabled).
  const nextEnabled = (from: number, delta: 1 | -1): number => {
    if (firstEnabled < 0) return -1;
    const n = items.length;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (!items[i]?.disabled) return i;
    }
    return -1;
  };

  const handleMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    // Locate the currently focused item; default to before-first so
    // `ArrowDown` from anywhere lands on the first enabled item.
    const active = itemRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const target = nextEnabled(active < 0 ? -1 : active, 1);
      if (target >= 0) itemRefs.current[target]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const target = nextEnabled(active < 0 ? items.length : active, -1);
      if (target >= 0) itemRefs.current[target]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      if (firstEnabled >= 0) itemRefs.current[firstEnabled]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      if (lastEnabled >= 0) itemRefs.current[lastEnabled]?.focus();
    }
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return onClose();
      if (!el.contains(e.target as Node)) onClose();
    };
    // Defer the click listener by a tick so the same right-click that
    // opened us doesn't immediately close us via its synthesized
    // mousedown bubble.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onClick);
    }, 0);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.clearTimeout(t);
    };
  }, [onClose]);

  // Clamp to viewport after layout so the menu doesn't spill off-screen.
  // Only retrigger on x / y changes; reading pos from closure is correct
  // because the only thing we do with it is suppress a redundant setPos
  // when the clamp produces the same value we already have. Adding pos
  // to deps would re-run the effect right after each setPos for no win.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pos is read only to guard against a no-op setPos; adding it to deps would re-fire the effect after every state update
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width + 8 > w) left = Math.max(8, w - rect.width - 8);
    if (top + rect.height + 8 > h) top = Math.max(8, h - rect.height - 8);
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  }, [x, y]);

  return (
    <div
      ref={ref}
      role="menu"
      onKeyDown={handleMenuKey}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 70 }}
      className="min-w-[200px] border border-rule bg-ink-1/95 py-1 shadow-[0_18px_44px_rgba(0,0,0,0.55)] backdrop-blur-sm"
    >
      {items.map((item, idx) => (
        <button
          key={item.id}
          ref={(el) => {
            itemRefs.current[idx] = el;
          }}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
          className={`flex w-full cursor-pointer items-center gap-3 px-3 py-1.5 text-left font-sans text-[12px] transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40 ${
            item.tone === "danger"
              ? "text-coral hover:bg-coral/[0.10]"
              : "text-paper hover:bg-ink-2"
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.shortcut && (
            <span className="shrink-0 font-mono text-[10px] text-faint">
              {item.shortcut}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
