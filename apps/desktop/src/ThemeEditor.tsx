/// Full-screen theme editor. Mounted as its own top-level page at the
/// App layer — at the same scope as SettingsPage, not nested inside
/// it. The user can pick any theme (built-in or custom), and for
/// custom themes edit every color token, rename, duplicate, export,
/// delete, or import a JSON-encoded theme from another machine.
///
/// Selecting a theme makes it the active theme immediately — there is
/// no Save button. Edits stream into the registry through the existing
/// useSetting subscription system, so the rest of the app repaints in
/// real time as the user works.
import { useEffect, useMemo, useState } from "react";
import {
  BUILTIN_DARK_ID,
  TOKEN_GROUPS,
  createCustomTheme,
  createRandomTheme,
  deleteCustomTheme,
  exportThemeAsJson,
  getThemeOrDefault,
  importThemesFromJson,
  rerollCustomTheme,
  updateCustomTheme,
  useThemes,
  type Theme,
  type ThemeAppearance,
  type ThemeTokens,
} from "./themes";
import { ThemeChip } from "./ThemeChip";
import { setSetting, useSetting } from "./settings";
import { Modal } from "./Modal";
import { SecondaryButton } from "./SecondaryButton";
import { pushToast } from "./toast";
import { useModalFocus } from "./useModalFocus";

type Props = {
  onClose: () => void;
};

export function ThemeEditor({ onClose }: Props) {
  useModalFocus();
  const themes = useThemes();
  const activeThemeId = useSetting("activeThemeId");
  const onSelectTheme = (id: string) => setSetting("activeThemeId", id);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Look the theme up through the reactive registry rather than
  // `getThemeOrDefault` so a token edit on the active theme flows
  // through to the editor preview. Pointer-equal output across
  // unrelated theme edits keeps the useMemo cheap.
  const activeTheme = useMemo(
    () =>
      themes.find((t) => t.id === activeThemeId) ??
      getThemeOrDefault(activeThemeId),
    [themes, activeThemeId],
  );

  // Escape on the editor closes it — but only when no modal child is
  // open. Both ImportDialog and DeleteConfirm register their own
  // window-level Escape handlers, so without this guard pressing
  // Escape with one of them open would dismiss the modal *and* exit
  // the editor in the same keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (importOpen || confirmDelete) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, importOpen, confirmDelete]);

  function handleDuplicate() {
    const created = createCustomTheme({
      name: `${activeTheme.name} Copy`,
      source: activeTheme,
    });
    onSelectTheme(created.id);
  }

  /// Reroll palette in place when the active theme is already custom;
  /// spawn a new themed-named custom when it's a built-in. This makes
  /// the button feel different depending on context without exposing
  /// two separate controls.
  function handleRandomize() {
    if (activeTheme.isBuiltin) {
      const created = createRandomTheme();
      onSelectTheme(created.id);
    } else {
      rerollCustomTheme(activeTheme.id);
    }
  }

  function handleDelete() {
    if (activeTheme.isBuiltin) return;
    const ok = deleteCustomTheme(activeTheme.id);
    if (ok) {
      onSelectTheme(BUILTIN_DARK_ID);
      pushToast(`Deleted "${activeTheme.name}".`, { kind: "info" });
    }
  }

  async function handleExport() {
    const json = exportThemeAsJson(activeTheme);
    try {
      await navigator.clipboard.writeText(json);
      pushToast(`Copied "${activeTheme.name}" to clipboard.`, { kind: "info" });
    } catch {
      pushToast("Couldn't access clipboard.", { kind: "warn" });
    }
  }

  const builtins = themes.filter((t) => t.isBuiltin);
  const customs = themes.filter((t) => !t.isBuiltin);

  // `absolute inset-0` (not `fixed`) so the editor stays inside <main>
  // — same scope as SettingsPage — and doesn't paint over the macOS
  // traffic-light region (top) or the workspace sidebar (left).
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-ink-0">
      {importOpen && (
        <ImportDialog
          onCancel={() => setImportOpen(false)}
          onImported={(imported) => {
            setImportOpen(false);
            if (imported[0]) onSelectTheme(imported[0].id);
            pushToast(
              imported.length === 1
                ? `Imported "${imported[0]!.name}".`
                : `Imported ${imported.length} themes.`,
              { kind: "info" },
            );
          }}
        />
      )}

      {/* Header */}
      <header className="flex items-center justify-between border-b border-rule/60 px-8 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="m-0 font-sans text-[20px] font-medium tracking-[-0.015em] text-paper">
            Themes
          </h1>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-faint">
            {customs.length === 0
              ? "Built-in only"
              : `${customs.length} custom`}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer border border-rule bg-transparent px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted transition-colors duration-150 hover:border-paper hover:text-paper"
        >
          Done
        </button>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Theme list */}
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-rule/60 bg-ink-1">
          <div className="flex-1 overflow-y-auto py-2">
            <ThemeListGroup
              title="Built-in"
              themes={builtins}
              activeId={activeThemeId}
              onSelect={onSelectTheme}
            />
            <ThemeListGroup
              title="Custom"
              themes={customs}
              activeId={activeThemeId}
              onSelect={onSelectTheme}
              emptyHint="Duplicate a built-in to start."
            />
          </div>
          <div className="border-t border-rule/60 p-3">
            <button
              type="button"
              onClick={handleDuplicate}
              className="mb-1.5 flex w-full cursor-pointer items-center justify-between border border-amber/40 bg-amber/[0.06] px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-amber transition-colors duration-150 hover:border-amber hover:bg-amber/[0.10]"
            >
              <span>New from current</span>
              <span aria-hidden>+</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const created = createRandomTheme();
                onSelectTheme(created.id);
              }}
              title="Generate a fresh random theme"
              className="mb-1.5 flex w-full cursor-pointer items-center justify-between border border-rule bg-transparent px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors duration-150 hover:border-paper hover:text-paper"
            >
              <span>Random theme</span>
              <span aria-hidden>✦</span>
            </button>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="flex w-full cursor-pointer items-center justify-between border border-rule px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors duration-150 hover:border-paper hover:text-paper"
            >
              <span>Import JSON</span>
              <span aria-hidden>↑</span>
            </button>
          </div>
        </aside>

        {/* Details */}
        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto px-10 py-8">
          <ThemeDetails
            theme={activeTheme}
            confirmDelete={confirmDelete}
            onRequestDelete={() => setConfirmDelete(true)}
            onCancelDelete={() => setConfirmDelete(false)}
            onDuplicate={handleDuplicate}
            onRandomize={handleRandomize}
            onDelete={() => {
              setConfirmDelete(false);
              handleDelete();
            }}
            onExport={handleExport}
          />
        </section>
      </div>
    </div>
  );
}

function ThemeListGroup({
  title,
  themes,
  activeId,
  onSelect,
  emptyHint,
}: {
  title: string;
  themes: Theme[];
  activeId: string;
  onSelect: (id: string) => void;
  emptyHint?: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="px-4 py-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.22em] text-faint">
        {title}
      </h2>
      {themes.length === 0 && emptyHint && (
        <p className="px-4 py-2 text-[11px] italic leading-[1.5] text-faint">
          {emptyHint}
        </p>
      )}
      {themes.map((t) => (
        <ThemeListItem
          key={t.id}
          theme={t}
          active={t.id === activeId}
          onSelect={() => onSelect(t.id)}
        />
      ))}
    </div>
  );
}

function ThemeListItem({
  theme,
  active,
  onSelect,
}: {
  theme: Theme;
  active: boolean;
  onSelect: () => void;
}) {
  const rowClass = active
    ? "border-l-amber bg-amber/[0.06] text-paper"
    : "border-l-transparent text-muted hover:bg-ink-2 hover:text-paper";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full cursor-pointer items-center gap-2.5 border-l-2 px-3.5 py-2 text-left transition-colors duration-150 ${rowClass}`}
    >
      <ThemeChip tokens={theme.tokens} size="md" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium tracking-[-0.005em]">
          {theme.name}
        </span>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-faint">
          {theme.appearance}
        </span>
      </span>
    </button>
  );
}

function ThemeDetails({
  theme,
  confirmDelete,
  onRequestDelete,
  onCancelDelete,
  onDuplicate,
  onRandomize,
  onDelete,
  onExport,
}: {
  theme: Theme;
  confirmDelete: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDuplicate: () => void;
  onRandomize: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const editable = !theme.isBuiltin;

  function handleRename(name: string) {
    if (!editable) return;
    updateCustomTheme(theme.id, { name });
  }
  function handleAppearance(appearance: ThemeAppearance) {
    if (!editable) return;
    updateCustomTheme(theme.id, { appearance });
  }
  function handleTokenChange(key: keyof ThemeTokens, hex: string) {
    if (!editable) return;
    const tokens: Partial<ThemeTokens> = { [key]: hex };
    updateCustomTheme(theme.id, { tokens });
  }

  return (
    <div className="mx-auto w-full max-w-[640px] pb-12">
      {/* Title row */}
      <div className="mb-1 flex items-baseline gap-3">
        <NameField
          value={theme.name}
          editable={editable}
          onCommit={handleRename}
        />
        {!editable && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
            Built-in · read-only
          </span>
        )}
      </div>

      {/* Appearance + actions */}
      <div className="mb-8 flex items-center justify-between gap-4">
        <AppearanceToggle
          value={theme.appearance}
          editable={editable}
          onChange={handleAppearance}
        />
        <div className="flex items-center gap-1.5">
          <ActionButton onClick={onRandomize} tone="accent">
            {editable ? "Reroll" : "Randomize"}
          </ActionButton>
          <ActionButton onClick={onExport}>Export</ActionButton>
          <ActionButton onClick={onDuplicate}>Duplicate</ActionButton>
          {editable && (
            <ActionButton tone="danger" onClick={onRequestDelete}>
              Delete
            </ActionButton>
          )}
        </div>
      </div>

      {/* Token groups */}
      {TOKEN_GROUPS.map((group) => (
        <section key={group.title} className="mb-7">
          <h3 className="mb-2 font-sans text-[10.5px] font-semibold uppercase tracking-[0.22em] text-faint">
            {group.title}
          </h3>
          <div className="border-t border-rule/40">
            {group.rows.map((row) => (
              <TokenRow
                key={row.key}
                label={row.label}
                hint={row.hint}
                value={theme.tokens[row.key]}
                editable={editable}
                onChange={(hex) => handleTokenChange(row.key, hex)}
              />
            ))}
          </div>
        </section>
      ))}

      {confirmDelete && (
        <DeleteConfirm
          name={theme.name}
          onCancel={onCancelDelete}
          onConfirm={onDelete}
        />
      )}
    </div>
  );
}

function NameField({
  value,
  editable,
  onCommit,
}: {
  value: string;
  editable: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Sync when the upstream changes (e.g. switching themes).
  useEffect(() => setDraft(value), [value]);
  if (!editable) {
    return (
      <h2 className="m-0 font-sans text-[24px] font-medium tracking-[-0.015em] text-paper">
        {value}
      </h2>
    );
  }
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed && trimmed !== value) onCommit(trimmed);
        else setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      maxLength={60}
      className="m-0 min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 py-1 font-sans text-[24px] font-medium tracking-[-0.015em] text-paper outline-none focus:border-amber/60"
    />
  );
}

function AppearanceToggle({
  value,
  editable,
  onChange,
}: {
  value: ThemeAppearance;
  editable: boolean;
  onChange: (next: ThemeAppearance) => void;
}) {
  return (
    <div className="inline-flex items-stretch border border-rule">
      {(["dark", "light"] as const).map((a) => {
        const active = value === a;
        return (
          <button
            key={a}
            type="button"
            disabled={!editable}
            onClick={() => onChange(a)}
            aria-pressed={active}
            className={`px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.16em] transition-colors duration-100 ${
              active
                ? "bg-amber/[0.10] text-amber"
                : "text-muted hover:bg-ink-2 hover:text-paper"
            } ${!editable ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "cursor-pointer"}`}
          >
            {a}
          </button>
        );
      })}
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "danger" | "accent";
}) {
  const cls =
    tone === "danger"
      ? "border-coral/45 bg-coral/[0.06] text-coral hover:border-coral hover:bg-coral/[0.10]"
      : tone === "accent"
        ? "border-amber/45 bg-amber/[0.06] text-amber hover:border-amber hover:bg-amber/[0.10]"
        : "border-rule text-muted hover:border-paper hover:text-paper";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer border bg-transparent px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] transition-colors duration-150 ${cls}`}
    >
      {children}
    </button>
  );
}

function TokenRow({
  label,
  hint,
  value,
  editable,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  editable: boolean;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-rule/40 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] text-paper">{label}</span>
        {hint && (
          <span className="text-[11px] leading-[1.5] text-faint">{hint}</span>
        )}
      </div>
      <ColorField
        label={label}
        value={value}
        editable={editable}
        onChange={onChange}
      />
    </div>
  );
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function ColorField({
  label,
  value,
  editable,
  onChange,
}: {
  /// Used to give the swatch button an accessible name — screen
  /// readers otherwise announce just "Color picker" for every row.
  label: string;
  value: string;
  editable: boolean;
  onChange: (hex: string) => void;
}) {
  // Local draft state so the input stays editable while the user types
  // partial values like "#abc". Commits on Enter, blur, or when the
  // draft passes the full 6-digit hex shape.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const isValid = HEX_RE.test(draft);

  function commit(next: string) {
    if (!editable) return;
    if (HEX_RE.test(next) && next.toLowerCase() !== value.toLowerCase()) {
      onChange(next.toLowerCase());
    } else {
      setDraft(value);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={draft}
        readOnly={!editable}
        onChange={(e) => {
          let next = e.target.value.trim();
          if (next && !next.startsWith("#")) next = `#${next}`;
          setDraft(next);
          if (HEX_RE.test(next)) onChange(next.toLowerCase());
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        spellCheck={false}
        className={`w-[88px] border bg-ink-1 px-2 py-1 text-center font-mono text-[11px] uppercase tracking-[0.06em] tabular-nums text-paper focus:outline-none ${
          isValid ? "border-rule focus:border-amber/60" : "border-coral/55"
        } ${!editable ? "cursor-not-allowed opacity-70" : ""}`}
      />
      <label
        aria-label={`${label} — pick a color`}
        className={`relative inline-flex h-7 w-7 items-center justify-center border border-rule/70 ${
          editable ? "cursor-pointer" : "cursor-not-allowed opacity-70"
        }`}
        style={{ backgroundColor: isValid ? draft : value }}
      >
        <input
          type="color"
          disabled={!editable}
          value={isValid ? draft : value}
          onChange={(e) => {
            const next = e.target.value.toLowerCase();
            setDraft(next);
            onChange(next);
          }}
          aria-label={`${label} — pick a color`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

function ImportDialog({
  onCancel,
  onImported,
}: {
  onCancel: () => void;
  onImported: (imported: Theme[]) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // ESC handling is provided by <Modal>; no per-dialog keydown effect
  // needed here.

  function handleImport() {
    try {
      const imported = importThemesFromJson(text);
      onImported(imported);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal ariaLabel="Import theme" onDismiss={onCancel} zIndex={50}>
      <div className="w-full max-w-[520px] border border-rule bg-ink-1 px-7 py-6 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        <h2 className="m-0 mb-3 font-sans text-[18px] font-medium tracking-[-0.015em] text-paper">
          Import theme
        </h2>
        <p className="mt-0 mb-3 text-[12px] leading-[1.55] text-muted">
          Paste a theme JSON below. You can also paste an array to import
          multiple themes at once. Existing themes are not overwritten.
        </p>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          rows={10}
          spellCheck={false}
          placeholder={`{\n  "name": "My Theme",\n  "appearance": "dark",\n  "tokens": { ... }\n}`}
          className="w-full resize-none border border-rule bg-ink-0 px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-paper focus:border-amber/60 focus:outline-none"
        />
        {error && <p className="mt-2 text-[11.5px] text-coral">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <SecondaryButton size="sm" onClick={onCancel}>
            Cancel
          </SecondaryButton>
          <button
            type="button"
            disabled={text.trim().length === 0}
            onClick={handleImport}
            className="cursor-pointer border border-amber/55 bg-amber/[0.10] px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-amber transition-colors duration-150 hover:border-amber hover:bg-amber/[0.15] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Import
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteConfirm({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // ESC handling is provided by <Modal>.
  return (
    <Modal ariaLabel="Delete theme" onDismiss={onCancel} zIndex={50}>
      <div className="w-full max-w-[420px] border border-rule bg-ink-1 px-7 py-6 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        <h2 className="m-0 mb-3 font-sans text-[18px] font-medium tracking-[-0.015em] text-paper">
          Delete <em className="font-normal italic text-coral">{name}</em>?
        </h2>
        <p className="mt-0 mb-5 text-[12px] leading-[1.55] text-muted">
          This can&rsquo;t be undone. The active theme will fall back to Loom
          Dark.
        </p>
        <div className="flex items-center justify-end gap-2">
          <SecondaryButton size="sm" onClick={onCancel}>
            Cancel
          </SecondaryButton>
          <button
            type="button"
            onClick={onConfirm}
            className="cursor-pointer border border-coral/55 bg-coral/[0.08] px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-coral transition-colors duration-150 hover:border-coral hover:bg-coral/15"
          >
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}
