import { useEffect, useRef, useState } from "react";

import { useFocusTrap } from "./useModalFocus";

const MIN_COUNT = 1;
const MAX_COUNT = 32;

type Props = {
  /// Anchor coords (viewport CSS px) — same shape as PaneContextMenu.
  x: number;
  y: number;
  onSubmit: (count: number) => void;
  onClose: () => void;
};

/// Tiny floating prompt opened from the workspace-tab menu. The user
/// types a count (1–32), Enter commits, Esc / outside-click cancels.
/// Mirrors PaneContextMenu's clamp-to-viewport behaviour so the prompt
/// can't open off-screen when right-clicking a tab near the edge.
export function AddShellsPrompt({ x, y, onSubmit, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("4");
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep Tab / Shift-Tab cycling inside this prompt so keyboard users
  // can't slip past the Add button into the underlying workspace tabs
  // while the dialog is open.
  useFocusTrap(ref);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return onClose();
      if (!el.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer outside-click listener by a tick so the click that opened
    // us doesn't immediately close us.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onMouseDown);
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
      window.clearTimeout(t);
    };
  }, [onClose]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pos read only to guard a no-op setPos; adding it would re-fire after every state update
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

  const commit = () => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));
    onSubmit(clamped);
    onClose();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Add shells"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 70 }}
      className="flex min-w-[220px] items-center gap-2 border border-rule bg-ink-1/95 px-3 py-2 shadow-[0_18px_44px_rgba(0,0,0,0.55)] backdrop-blur-sm"
    >
      <span className="shrink-0 font-sans text-[12px] text-faint">Add</span>
      <input
        ref={inputRef}
        type="number"
        min={MIN_COUNT}
        max={MAX_COUNT}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="w-14 border border-rule bg-ink-0 px-1.5 py-0.5 text-center font-mono text-[12px] text-paper focus:border-amber focus:outline-none"
      />
      <span className="shrink-0 font-sans text-[12px] text-faint">shells</span>
      <button
        type="button"
        onClick={commit}
        className="ml-auto cursor-pointer border border-rule bg-ink-2 px-2 py-0.5 font-sans text-[11px] text-paper hover:bg-ink-3"
      >
        Add
      </button>
    </div>
  );
}
