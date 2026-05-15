import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useModalFocus } from "./useModalFocus";

type Props = {
  /// Either `ariaLabel` (a string) or `ariaLabelledBy` (the id of the
  /// dialog's heading) is required so the dialog announces itself to
  /// assistive tech.
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /// Fired by Escape, backdrop click, or any explicit close button the
  /// caller wires up. The Modal does NOT call `onDismiss` for clicks
  /// inside the inner box.
  onDismiss: () => void;
  /// Element to focus on mount. If omitted, the trap will still pull
  /// focus into the dialog the first time the user hits Tab, but the
  /// initial focus stays wherever the host put it.
  initialFocusRef?: RefObject<HTMLElement | null>;
  /// Z-index layer. Defaults to 50; raise for dialogs that need to
  /// stack on top of another modal (rare).
  zIndex?: number;
  /// Extra classes appended to the backdrop wrapper for layout tweaks
  /// (e.g. additional padding on a panel that fills more of the viewport).
  backdropClassName?: string;
  /// Stop propagation of keyboard events to the underlying app while
  /// the modal is open. Used by the confirm dialogs whose Enter/Escape
  /// shouldn't reach App.tsx's global shortcut handler.
  captureKeys?: boolean;
  children: ReactNode;
};

/// Reusable dialog shell: backdrop + ESC dismiss + focus trap + focus
/// restore. The host provides the inner box (with whatever sizing,
/// padding, and content it needs) as `children`; this wrapper just
/// supplies the framing every dialog in the app had previously
/// hand-rolled.
///
/// Why centralized: before this, six dialogs each maintained their own
/// `useEffect` for ESC handling, their own backdrop-click check, and
/// their own focus restore. The focus trap was missing everywhere,
/// which was a real a11y gap — Tab from inside a "blocking" dialog
/// escaped into the underlying app.
export function Modal({
  ariaLabel,
  ariaLabelledBy,
  onDismiss,
  initialFocusRef,
  zIndex = 50,
  backdropClassName = "",
  captureKeys = false,
  children,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(initialFocusRef, containerRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (captureKeys) e.stopPropagation();
      onDismiss();
    };
    window.addEventListener("keydown", onKey, captureKeys);
    return () => window.removeEventListener("keydown", onKey, captureKeys);
  }, [onDismiss, captureKeys]);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      tabIndex={-1}
      // Backdrop click dismisses; clicks bubbling up from inside the
      // dialog don't. The event.target check is what we had open-coded
      // in every dialog — moving it here keeps the contract identical.
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
      className={`fixed inset-0 flex items-center justify-center bg-ink-0/70 px-6 backdrop-blur-sm ${backdropClassName}`}
      style={{ zIndex }}
    >
      {children}
    </div>
  );
}
