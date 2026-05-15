/// Keyboard-shortcut catalog rendered by both SettingsPage and the
/// KeyboardHelpOverlay. Kept in one place so the two surfaces can't drift.
export type Shortcut = { combo: string; label: string };
export type ShortcutGroup = { title: string; items: Shortcut[] };

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Workspaces",
    items: [
      { combo: "⌘T", label: "New workspace tab" },
      { combo: "⌘⇧W", label: "Close workspace" },
      { combo: "⌘1 – ⌘9", label: "Switch to workspace 1–9" },
      { combo: "⌘⇧]", label: "Next workspace" },
      { combo: "⌘⇧[", label: "Previous workspace" },
      { combo: "⌥↑ / ⌥↓", label: "Move workspace up / down" },
    ],
  },
  {
    title: "Panes",
    items: [
      { combo: "⌘N", label: "New session" },
      { combo: "⌘D", label: "Split horizontal" },
      { combo: "⌘⇧D", label: "Split vertical" },
      { combo: "⌘W", label: "Close active pane" },
      { combo: "⌘]", label: "Next pane" },
      { combo: "⌘[", label: "Previous pane" },
      { combo: "⌥1 – ⌥9", label: "Focus pane 1–9 in active workspace" },
      { combo: "⌘R", label: "Restart active pane (opt-in)" },
    ],
  },
  {
    title: "View",
    items: [
      { combo: "⌘B", label: "Toggle sidebar" },
      { combo: "⌘,", label: "Open settings" },
      { combo: "?", label: "Show keyboard shortcuts" },
      { combo: "Esc", label: "Dismiss dialog" },
    ],
  },
];
