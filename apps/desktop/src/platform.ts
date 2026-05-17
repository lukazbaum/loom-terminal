/// One-line platform detection shared across the app. Computed once at
/// module init so the cost of `navigator.platform` (and its quirks across
/// engines) doesn't get paid on every keystroke.
export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);
