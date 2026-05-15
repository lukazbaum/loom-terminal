import { useEffect } from "react";

import { Modal } from "./Modal";

type Shortcut = { combo: string; label: string };
type ShortcutGroup = { title: string; items: Shortcut[] };

type Props = {
  groups: ShortcutGroup[];
  onClose: () => void;
};

/// Modal overlay listing every keyboard shortcut. Triggered by `?` from
/// anywhere outside an input. Same data the Settings page renders, just
/// surfaced inline so users discover shortcuts without leaving their work.
export function KeyboardHelpOverlay({ groups, onClose }: Props) {
  // `?` toggles the overlay closed (in addition to Escape, which the
  // Modal component already handles). Keep this here since it's a
  // shortcut-specific binding, not generic modal chrome.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Modal ariaLabel="Keyboard shortcuts" onDismiss={onClose} zIndex={55}>
      <div className="flex max-h-[80vh] w-[min(720px,90vw)] flex-col overflow-hidden border border-rule bg-ink-1 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        <div className="flex shrink-0 items-center gap-3 border-b border-rule px-5 py-3.5">
          <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.22em] text-amber">
            Keyboard Shortcuts
          </span>
          <span className="font-mono text-[10.5px] text-faint">?</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto cursor-pointer rounded-sm px-1.5 py-1 font-mono text-[14px] leading-none text-faint transition-colors duration-100 hover:bg-ink-2 hover:text-paper"
          >
            ×
          </button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-x-10 gap-y-6 overflow-y-auto px-6 py-5 sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group.title}>
              <h3 className="mb-2 font-sans text-[10px] font-medium uppercase tracking-[0.2em] text-muted">
                {group.title}
              </h3>
              <div className="border-t border-rule/40">
                {group.items.map((s) => (
                  <div
                    key={s.combo + s.label}
                    className="flex items-center justify-between gap-3 border-b border-rule/40 py-2"
                  >
                    <span className="text-[12.5px] text-paper">{s.label}</span>
                    <span className="shrink-0 font-mono text-[11.5px] tracking-[0.02em] text-amber/85">
                      {s.combo}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t border-rule/40 px-5 py-2.5 text-[10.5px] text-faint">
          Press <span className="font-mono text-muted">?</span> anywhere to open
          · <span className="font-mono text-muted">Esc</span> to close
        </div>
      </div>
    </Modal>
  );
}
