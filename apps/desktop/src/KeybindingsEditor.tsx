/// Editable view over the keybindings registered in `keybindings.ts`.
///
/// Each customizable action gets a row with its current chord pills.
/// Clicking a pill (or the `+` button) enters recording mode: the next
/// keystroke is captured via `chordFromEvent` and saved as an override
/// in `Settings.keybindings`. While recording, `lockDispatch()` pauses
/// the global shortcut handler so the recorded chord isn't also fired
/// as an action.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  ACTION_IDS,
  ACTIONS,
  type ActionDescriptor,
  type ActionId,
  chordFromEvent,
  chordToString,
  DEFAULT_KEYBINDINGS,
  findConflicts,
  formatChordString,
  formatStaticCombo,
  isOverridden,
  lockDispatch,
  mergeKeymap,
  type ShortcutGroup,
  STATIC_ENTRIES,
} from "./keybindings";
import { isMac } from "./platform";
import { setSetting, useSettings } from "./settings";

export function KeybindingsEditor() {
  const settings = useSettings();
  const keymap = useMemo(
    () => mergeKeymap(settings.keybindings),
    [settings.keybindings],
  );
  const conflicts = useMemo(() => findConflicts(keymap), [keymap]);
  const conflictingChords = useMemo(
    () => new Set(conflicts.map((c) => c.chord)),
    [conflicts],
  );
  const hasOverrides = ACTION_IDS.some((id) =>
    isOverridden(id, settings.keybindings),
  );

  const grouped = useMemo(() => {
    const out: Record<ShortcutGroup, ActionDescriptor[]> = {
      Workspaces: [],
      Panes: [],
      View: [],
    };
    for (const a of ACTIONS) out[a.group].push(a);
    return out;
  }, []);

  /// `editing` identifies which row/slot is in recording mode.
  /// `index === "new"` means "appending a new binding"; a number means
  /// "rebinding the existing chord at that index".
  type EditTarget = { action: ActionId; index: number | "new" };
  const [editing, setEditing] = useState<EditTarget | null>(null);

  function persist(id: ActionId, next: string[]) {
    const overrides = { ...settings.keybindings };
    const def = DEFAULT_KEYBINDINGS[id];
    // Round-trip back to defaults clears the override so adding new
    // actions later doesn't strand a stale "same as default" entry.
    const matchesDefault =
      next.length === def.length && next.every((c, i) => c === def[i]);
    if (matchesDefault) {
      delete overrides[id];
    } else {
      overrides[id] = next;
    }
    setSetting("keybindings", overrides);
  }

  function commitChord(chord: string) {
    if (!editing) return;
    const current = keymap[editing.action];
    let next: string[];
    if (editing.index === "new") {
      // Dedupe so clicking `+` twice doesn't add the same chord twice.
      if (current.includes(chord)) next = current;
      else next = [...current, chord];
    } else {
      next = current.map((c, i) => (i === editing.index ? chord : c));
    }
    persist(editing.action, next);
    setEditing(null);
  }

  function removeChord(id: ActionId, index: number) {
    const current = keymap[id];
    persist(
      id,
      current.filter((_, i) => i !== index),
    );
  }

  function resetAction(id: ActionId) {
    const overrides = { ...settings.keybindings };
    delete overrides[id];
    setSetting("keybindings", overrides);
  }

  function resetAll() {
    setSetting("keybindings", {});
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] leading-[1.5] text-faint">
          Click a chord pill or `+` to rebind. Press the new keys; Esc cancels.
        </span>
        {hasOverrides && (
          <button
            type="button"
            onClick={resetAll}
            className="cursor-pointer border border-rule bg-transparent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted transition-colors duration-150 hover:border-paper hover:text-paper"
          >
            Reset all
          </button>
        )}
      </div>

      {(["Workspaces", "Panes", "View"] as const).map((group) => (
        <div key={group}>
          <h3 className="mb-2 font-sans text-[10px] font-medium uppercase tracking-[0.2em] text-muted">
            {group}
          </h3>
          <div className="border-t border-rule/40">
            {grouped[group].map((action) => (
              <ActionRow
                key={action.id}
                action={action}
                chords={keymap[action.id]}
                overridden={isOverridden(action.id, settings.keybindings)}
                conflictingChords={conflictingChords}
                editingIndex={
                  editing?.action === action.id ? editing.index : undefined
                }
                onEdit={(index) => setEditing({ action: action.id, index })}
                onCancel={() => setEditing(null)}
                onCommit={commitChord}
                onRemove={(index) => removeChord(action.id, index)}
                onReset={() => resetAction(action.id)}
              />
            ))}
            {STATIC_ENTRIES.filter((e) => e.group === group).map((entry) => (
              <div
                key={entry.combo}
                className="flex items-center justify-between gap-6 border-b border-rule/40 py-2.5"
              >
                <span className="text-[13px] text-muted">{entry.label}</span>
                <span className="font-mono text-[12px] tracking-[0.02em] text-faint">
                  {formatStaticCombo(entry.combo, isMac)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {conflicts.length > 0 && (
        <div className="border border-coral/40 bg-coral/[0.06] px-3 py-2 text-[11px] text-coral">
          {conflicts.length === 1
            ? "One chord is bound to multiple actions — only the first one (in list order) will fire."
            : `${conflicts.length} chords are bound to multiple actions — only the first match (in list order) will fire.`}
        </div>
      )}
    </div>
  );
}

type RowProps = {
  action: ActionDescriptor;
  chords: string[];
  overridden: boolean;
  conflictingChords: Set<string>;
  /// `undefined` when this row is not in recording mode; `number` when
  /// rebinding an existing chord at that index; `"new"` when adding.
  editingIndex: number | "new" | undefined;
  onEdit: (index: number | "new") => void;
  onCancel: () => void;
  onCommit: (chord: string) => void;
  onRemove: (index: number) => void;
  onReset: () => void;
};

function ActionRow({
  action,
  chords,
  overridden,
  conflictingChords,
  editingIndex,
  onEdit,
  onCancel,
  onCommit,
  onRemove,
  onReset,
}: RowProps) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-rule/40 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] text-paper">{action.label}</span>
        {action.hint && (
          <span className="text-[11px] leading-[1.5] text-faint">
            {action.hint}
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {chords.map((chord, i) =>
          editingIndex === i ? (
            <ChordRecorder
              key={`rec-${i}`}
              onCommit={onCommit}
              onCancel={onCancel}
            />
          ) : (
            <ChordPill
              key={`${chord}-${i}`}
              chord={chord}
              conflict={conflictingChords.has(chord)}
              onClick={() => onEdit(i)}
              onRemove={() => onRemove(i)}
            />
          ),
        )}
        {editingIndex === "new" && (
          <ChordRecorder onCommit={onCommit} onCancel={onCancel} />
        )}
        {editingIndex === undefined && (
          <button
            type="button"
            onClick={() => onEdit("new")}
            aria-label={`Add binding for ${action.label}`}
            className="cursor-pointer border border-dashed border-rule bg-transparent px-2 py-[3px] font-mono text-[11px] text-faint transition-colors duration-150 hover:border-paper hover:text-paper"
          >
            +
          </button>
        )}
        {overridden && (
          <button
            type="button"
            onClick={onReset}
            aria-label={`Reset ${action.label} to default`}
            title="Reset to default"
            className="cursor-pointer border border-transparent bg-transparent px-1.5 py-[3px] font-mono text-[11px] text-faint transition-colors duration-150 hover:text-paper"
          >
            ↺
          </button>
        )}
      </div>
    </div>
  );
}

function ChordPill({
  chord,
  conflict,
  onClick,
  onRemove,
}: {
  chord: string;
  conflict: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  const display = formatChordString(chord, isMac);
  return (
    <span
      className={`inline-flex items-center border bg-ink-2/60 ${
        conflict ? "border-coral/60" : "border-rule"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        title={conflict ? "Conflicts with another action" : "Rebind"}
        className={`cursor-pointer bg-transparent px-2 py-[3px] font-mono text-[11px] tracking-[0.02em] transition-colors duration-100 ${
          conflict ? "text-coral" : "text-amber/85 hover:text-paper"
        }`}
      >
        {display}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove binding"
        className="cursor-pointer border-l border-rule bg-transparent px-1.5 py-[3px] font-mono text-[10px] text-faint transition-colors duration-100 hover:text-paper"
      >
        ×
      </button>
    </span>
  );
}

/// Listens for the user's next non-modifier keystroke and emits it as a
/// chord string. Pauses global dispatch while mounted so the recorded
/// chord doesn't also trigger an action. Cancels on bare Escape or on a
/// click outside.
function ChordRecorder({
  onCommit,
  onCancel,
}: {
  onCommit: (chord: string) => void;
  onCancel: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: onCommit/onCancel intentionally pinned to mount-time refs via outer state; the recorder lives for the duration of one capture and doesn't need to re-bind
  useEffect(() => {
    const release = lockDispatch();

    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      const chord = chordFromEvent(e, isMac);
      if (!chord) return; // pure modifier — keep waiting
      if (
        chord.code === "Escape" &&
        !chord.mod &&
        !chord.ctrl &&
        !chord.alt &&
        !chord.shift
      ) {
        onCancel();
        return;
      }
      onCommit(chordToString(chord));
    }

    function onPointerDown(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      onCancel();
    }

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      release();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1 border border-amber/55 bg-amber/[0.10] px-2.5 py-[3px] font-mono text-[10.5px] uppercase tracking-[0.14em] text-amber"
    >
      <span
        aria-hidden
        className="inline-block h-[5px] w-[5px] animate-pulse rounded-full bg-amber"
      />
      Press a chord
    </div>
  );
}
