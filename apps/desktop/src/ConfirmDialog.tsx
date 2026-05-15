import { useEffect, useRef } from "react";
import { Modal } from "./Modal";
import { SecondaryButton } from "./SecondaryButton";

type Tone = "neutral" | "danger";

type Props = {
  title: string;
  /// Body content — render plain string or arbitrary React. Multi-line copy
  /// is fine; the dialog is sized to fit modest paragraphs.
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: Tone;
  onCancel: () => void;
  onConfirm: () => void;
};

/// Generic confirm modal. Replaces ad-hoc browser `confirm()` calls and
/// shares chrome with ConfirmCloseModal in App.tsx — same tone, same
/// shadow, same "press Esc to dismiss". Keep new confirm prompts on this
/// component instead of growing per-feature variants.
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "neutral",
  onCancel,
  onConfirm,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Enter activates Confirm. Modal handles Escape itself; we only need
  // the Enter shortcut here. Captured because some hosts of this dialog
  // (e.g. App.tsx's global shortcut layer) would otherwise see Enter
  // first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onConfirm]);

  const confirmClass =
    tone === "danger"
      ? "border-coral/45 bg-coral/[0.08] text-coral hover:border-coral hover:bg-coral/15"
      : "border-amber/45 bg-amber/[0.08] text-amber hover:border-amber hover:bg-amber/15";

  return (
    <Modal
      ariaLabel={title}
      onDismiss={onCancel}
      initialFocusRef={cancelRef}
      zIndex={55}
      captureKeys
    >
      <div className="w-full max-w-[440px] border border-rule bg-ink-1 px-7 py-7 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        <h2 className="m-0 font-sans text-[20px] font-medium leading-[1.2] tracking-[-0.015em] text-paper">
          {title}
        </h2>
        <div className="mt-3 mb-7 text-[12.5px] leading-[1.6] text-muted">
          {body}
        </div>
        <div className="flex items-center justify-end gap-2">
          <SecondaryButton ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </SecondaryButton>
          <button
            type="button"
            onClick={onConfirm}
            className={`cursor-pointer border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors duration-150 ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
