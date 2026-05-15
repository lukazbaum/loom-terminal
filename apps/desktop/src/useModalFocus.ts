import { useEffect, useRef, type RefObject } from "react";

/// Selector covering everything browsers consider tabbable by default,
/// plus elements that opt-in via `tabindex >= 0`. We exclude `tabindex
/// = "-1"` so programmatically-focusable but not tab-stop elements
/// (e.g. scroll containers) don't trap focus on them.
const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/// Modal-focus convenience: stash whatever was focused on mount, move
/// focus into the modal, restore the previous focus on unmount, and
/// optionally cycle Tab / Shift-Tab inside the container so focus can't
/// escape into the underlying app.
///
/// Without the restore step, opening a modal with the keyboard and
/// dismissing it via Escape stranded focus on `<body>`, forcing the
/// user to Tab through the whole document to get back to their place.
///
/// The focus trap is opt-in via the second argument; passing the
/// container ref turns it on. We didn't bake the trap into every modal
/// before, which left a real a11y gap: assistive-tech users could Tab
/// out of a "blocking" dialog into the underlying app and interact with
/// content the dialog was meant to block.
export function useModalFocus(
  initialFocus?: RefObject<HTMLElement | null>,
  containerRef?: RefObject<HTMLElement | null>,
): void {
  // Mount-only: closing the modal is what calls unmount, which is when
  // restoration must happen. The initialFocus ref is read once at open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — initialFocus is captured once and the restore must fire on unmount
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    initialFocus?.current?.focus();
    return () => {
      // `previouslyFocused` may have been unmounted between open and
      // close (e.g. a workspace tab the user just closed). Guard via
      // `isConnected` so we don't crash on a stale node reference.
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  useFocusTrap(containerRef);
}

/// Cycle Tab / Shift-Tab focus inside `containerRef`. No-op when the
/// ref is undefined / unmounted / contains no focusable elements, so
/// it's safe to call unconditionally from any modal.
///
/// Listens on `keydown` capture so we beat the browser's default tab
/// dispatch and any other handler on inner inputs (e.g. xterm.js).
export function useFocusTrap(
  containerRef?: RefObject<HTMLElement | null>,
): void {
  // We don't recompute the focusable list on every keydown above
  // because the DOM may change during the modal's lifetime (a Save
  // button enables, a list expands). Querying live keeps trap behavior
  // honest at the cost of one querySelectorAll per Tab press — cheap
  // for the dialog-sized DOM these traps cover.
  const refForDeps = useRef(containerRef);
  refForDeps.current = containerRef;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const container = refForDeps.current?.current;
      if (!container) return;
      const focusables =
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) {
        // Nothing tabbable inside — pin focus on the container so Tab
        // doesn't escape. The container is the dialog root which is
        // already mounted, so `focus()` is safe.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // If focus has somehow escaped the container (window blur, an
      // off-screen autofocus, etc.), pull it back to the start so the
      // next Tab moves through the dialog in document order.
      if (active && !container.contains(active)) {
        e.preventDefault();
        first?.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
