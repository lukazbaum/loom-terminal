/// The new-workspace setup view: orchestrates the composer form, the
/// presets rail, the agent-hook consent cards, and the keyboard shortcut
/// dispatch. Sub-sections live in ./welcome/* so this file stays focused
/// on form state and side effects (folder picker dialog, hook installs,
/// recents persistence).
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";

import { normalizeCommands, type Preset } from "./presets";
import { shortenHome } from "./format";
import { loadRecentCommands } from "./recentCommands";

import { Header, Hero } from "./welcome/Chrome";
import { PresetsSection } from "./welcome/PresetsSection";
import { ComposerSection } from "./welcome/ComposerSection";
import { HookFooter } from "./welcome/HookFooter";
import {
  HOOK_AGENT_COPY,
  HOOK_AGENTS,
  loadRecents,
  pushRecent,
  saveRecents,
  statusFor,
  type HookAgent,
  type HookStatuses,
  type HookUiStates,
  type Mode,
} from "./welcome/internals";

export type LaunchInput = {
  path: string;
  count: number;
  commands: string[];
  name?: string;
};

export function Welcome({
  presets,
  onLaunch,
  onSavePreset,
  onUpdatePreset,
  onDeletePreset,
  onCancel,
}: {
  presets: Preset[];
  onLaunch: (input: LaunchInput) => void;
  onSavePreset: (input: Omit<Preset, "id" | "createdAt">) => Preset;
  onUpdatePreset: (
    id: string,
    patch: Partial<Omit<Preset, "id" | "createdAt">>,
  ) => void;
  onDeletePreset: (id: string) => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "create" });
  const [hookStatuses, setHookStatuses] = useState<HookStatuses | null>(null);
  const [hookUi, setHookUi] = useState<HookUiStates>({
    claude: "idle",
    codex: "idle",
    gemini: "idle",
  });

  // Load consent + detection state from the backend. The status is the
  // source of truth (lives in ~/.loom/hooks.json); we re-fetch after each
  // mutation so cards drop out as the user enables/skips.
  useEffect(() => {
    let cancelled = false;
    invoke<HookStatuses>("hook_consent_status")
      .then((s) => {
        if (!cancelled) setHookStatuses(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [path, setPath] = useState("");
  const [count, setCount] = useState<number>(1);
  const [commands, setCommands] = useState<string[]>([""]);
  const [title, setTitle] = useState("");
  const [saveAsPreset, setSaveAsPreset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [recentCommands, setRecentCommands] =
    useState<string[]>(loadRecentCommands);
  const [showPerShell, setShowPerShell] = useState(false);
  const [home, setHome] = useState<string>("");
  // Tracks whether the component is still mounted so the async
  // pickFolder() (file dialog) can drop its setState calls if the user
  // closes Welcome while the dialog is up.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Refresh the cached list whenever Welcome re-mounts so a fresh launch
  // gets the latest entries.
  useEffect(() => {
    setRecentCommands(loadRecentCommands());
  }, []);

  // Resolve the home directory once and use it as a sensible default
  // path so a fresh user can launch immediately without browsing.
  useEffect(() => {
    let cancelled = false;
    homeDir()
      .then((h) => {
        if (cancelled) return;
        setHome(h);
        setPath((prev) => (prev ? prev : h));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // A card is visible when the agent is installed AND the user hasn't
  // already decided (unset), or while a configure attempt is in-flight or
  // failed and waiting for retry.
  const visibleHookAgents: HookAgent[] =
    mode.kind === "create" && hookStatuses
      ? HOOK_AGENTS.filter((agent) => {
          const status = hookStatuses[agent];
          if (!status.installed) return false;
          if (hookUi[agent] !== "idle") return true;
          return status.consent === "unset";
        })
      : [];

  function resetForm() {
    setPath(home);
    setCount(1);
    setCommands([""]);
    setTitle("");
    setSaveAsPreset(false);
    setError(null);
    setShowPerShell(false);
  }

  function enterEdit(preset: Preset) {
    const cmds = normalizeCommands(preset.commands, preset.count);
    const divergent = cmds.some((c) => c !== cmds[0]);
    setMode({ kind: "edit", preset });
    setPath(preset.path);
    setCount(preset.count);
    setCommands(cmds);
    setTitle(preset.name);
    setSaveAsPreset(false);
    setError(null);
    setShowPerShell(divergent);
  }

  function enterCreatePreset() {
    setMode({ kind: "createPreset" });
    resetForm();
  }

  function exitPresetMode() {
    setMode({ kind: "create" });
    resetForm();
  }

  function changeCount(n: number) {
    setCount(n);
    setCommands((prev) => normalizeCommands(prev, n));
  }

  async function pickFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose a project folder",
      defaultPath: path || home || undefined,
    });
    // Drop the result if Welcome unmounted while the OS dialog was up
    // (user pressed Escape, switched workspaces, etc.). saveRecents to
    // disk is fine to keep, but setState on a dead component is wasted.
    if (!mountedRef.current) return;
    if (typeof picked === "string") {
      setPath(picked);
      setError(null);
      setRecents((prev) => {
        const next = pushRecent(prev, picked);
        saveRecents(next);
        return next;
      });
    }
  }

  function adoptRecent(folder: string) {
    setPath(folder);
    setError(null);
    setRecents((prev) => {
      const next = pushRecent(prev, folder);
      saveRecents(next);
      return next;
    });
  }

  function applyAgentToAll(command: string) {
    setCommands((prev) => prev.map(() => command));
  }

  function changeOneCommand(i: number, value: string) {
    setCommands((prev) => prev.map((c, idx) => (idx === i ? value : c)));
  }

  function launchPreset(p: Preset) {
    onLaunch({
      path: p.path,
      count: p.count,
      commands: p.commands,
      name: p.name,
    });
  }

  async function enableHookFor(agent: HookAgent) {
    setHookUi((prev) => ({ ...prev, [agent]: "configuring" }));
    try {
      // Configure first; only persist consent if the install succeeded.
      // Reverse order would leave `consent = enabled` recorded for an
      // agent whose hook never landed, so the card would silently drop
      // off the welcome screen and the user would never get notified.
      await invoke(HOOK_AGENT_COPY[agent].configureCmd);
      await invoke("hook_consent_set", { agent, value: "enabled" });
      const next = await invoke<HookStatuses>("hook_consent_status");
      setHookStatuses(next);
      setHookUi((prev) => ({ ...prev, [agent]: "idle" }));
    } catch {
      setHookUi((prev) => ({ ...prev, [agent]: "error" }));
    }
  }

  async function dismissHookFor(agent: HookAgent) {
    try {
      await invoke("hook_consent_set", { agent, value: "declined" });
      const next = await invoke<HookStatuses>("hook_consent_status");
      setHookStatuses(next);
      setHookUi((prev) => ({ ...prev, [agent]: "idle" }));
    } catch {
      // Best-effort: if persistence fails the card stays up. The
      // backend log line is the diagnostic, not the UI.
    }
  }

  function commit() {
    setError(null);
    const trimmedTitle = title.trim();
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      setError("Pick a working directory before continuing.");
      return;
    }

    if (mode.kind === "edit") {
      if (!trimmedTitle) {
        setError("Give the preset a title.");
        return;
      }
      onUpdatePreset(mode.preset.id, {
        name: trimmedTitle,
        path: trimmedPath,
        count,
        commands,
      });
      exitPresetMode();
      return;
    }

    if (mode.kind === "createPreset") {
      if (!trimmedTitle) {
        setError("Give the preset a title.");
        return;
      }
      onSavePreset({
        name: trimmedTitle,
        path: trimmedPath,
        count,
        commands,
      });
      exitPresetMode();
      return;
    }

    const finalName = trimmedTitle || undefined;
    if (saveAsPreset) {
      if (!trimmedTitle) {
        setError("Add a title to save this as a preset.");
        return;
      }
      onSavePreset({
        name: trimmedTitle,
        path: trimmedPath,
        count,
        commands,
      });
    }
    setRecents((prev) => {
      const next = pushRecent(prev, trimmedPath);
      saveRecents(next);
      return next;
    });
    onLaunch({
      path: trimmedPath,
      count,
      commands,
      name: finalName,
    });
    resetForm();
  }

  function deleteCurrent() {
    if (mode.kind !== "edit") return;
    onDeletePreset(mode.preset.id);
    exitPresetMode();
  }

  // Refs so the keyboard listener always sees the latest state without
  // re-binding every render.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const launchPresetRef = useRef(launchPreset);
  launchPresetRef.current = launchPreset;
  const pickFolderRef = useRef(pickFolder);
  pickFolderRef.current = pickFolder;

  const presetsRef = useRef(presets);
  presetsRef.current = presets;

  // The keyboard handler reads the freshest commit / pickFolder /
  // launchPreset / presets via refs above so it doesn't have to re-bind
  // on every keystroke. `exitPresetMode` is the one direct call that
  // would benefit from a ref too, but the effect already re-binds on
  // every `mode` change (which is when exitPresetMode's behavior would
  // actually shift), so adding it to deps would just mean repeating
  // `mode` semantically.
  // biome-ignore lint/correctness/useExhaustiveDependencies: exitPresetMode is captured from closure; the deps key on `mode` cover the only meaningful state shift
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        if (mode.kind !== "create") {
          e.preventDefault();
          exitPresetMode();
        } else if (onCancel) {
          e.preventDefault();
          onCancel();
        }
        return;
      }

      if (!meta) return;

      if (e.key === "Enter") {
        e.preventDefault();
        commitRef.current();
        return;
      }

      if (!inField && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void pickFolderRef.current();
        return;
      }

      if (mode.kind === "create" && /^[1-9]$/.test(e.key)) {
        const n = parseInt(e.key, 10);
        const list = presetsRef.current;
        const target = list[n - 1];
        if (target) {
          e.preventDefault();
          launchPresetRef.current(target);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onCancel]);

  const status = statusFor(mode, !!path.trim());
  const shortPath = useMemo(() => (path ? shortenHome(path) : ""), [path]);
  const filteredRecents = useMemo(
    () => recents.filter((r) => r !== path).slice(0, 4),
    [recents, path],
  );

  return (
    <main
      className="relative h-full overflow-y-auto px-10 py-12"
      style={{
        background:
          "radial-gradient(900px 500px at 78% 18%, rgba(245,163,90,0.045), transparent 60%), radial-gradient(700px 600px at 8% 96%, rgba(245,163,90,0.025), transparent 60%), linear-gradient(180deg, #0a0a0c 0%, #0e0e11 100%)",
      }}
    >
      <div
        className="setup-grid pointer-events-none absolute inset-0"
        aria-hidden
      />

      <div className="pointer-events-none absolute inset-6" aria-hidden>
        <span className="absolute top-0 left-0 h-3.5 w-3.5 border border-fade border-r-0 border-b-0 opacity-60" />
        <span className="absolute top-0 right-0 h-3.5 w-3.5 border border-fade border-l-0 border-b-0 opacity-60" />
        <span className="absolute bottom-0 left-0 h-3.5 w-3.5 border border-fade border-r-0 border-t-0 opacity-60" />
        <span className="absolute bottom-0 right-0 h-3.5 w-3.5 border border-fade border-l-0 border-t-0 opacity-60" />
      </div>

      <div className="relative mx-auto w-full max-w-[1180px] animate-rise">
        <Header
          mode={mode}
          onCancel={onCancel}
          onExitPresetMode={exitPresetMode}
        />

        <Hero status={status} mode={mode} />

        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <ComposerSection
            mode={mode}
            path={path}
            shortPath={shortPath}
            recents={filteredRecents}
            recentCommands={recentCommands}
            home={home}
            count={count}
            commands={commands}
            title={title}
            saveAsPreset={saveAsPreset}
            showPerShell={showPerShell}
            error={error}
            numeral={mode.kind === "create" ? "01" : undefined}
            onPickFolder={pickFolder}
            onAdoptRecent={adoptRecent}
            onClearPath={() => setPath(home)}
            onChangeCount={changeCount}
            onApplyAgentToAll={applyAgentToAll}
            onChangeCommand={changeOneCommand}
            onTogglePerShell={() => setShowPerShell((v) => !v)}
            onChangeTitle={setTitle}
            onToggleSave={setSaveAsPreset}
            onCommit={commit}
            onDelete={deleteCurrent}
          />

          <div className="flex flex-col">
            {mode.kind === "create" && (
              <PresetsSection
                presets={presets}
                onLaunch={launchPreset}
                onEdit={enterEdit}
                onCreate={enterCreatePreset}
              />
            )}

            {visibleHookAgents.map((agent) => (
              <HookFooter
                key={agent}
                agent={agent}
                ui={hookUi[agent]}
                onEnable={() => enableHookFor(agent)}
                onDismiss={() => dismissHookFor(agent)}
              />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
