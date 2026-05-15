/// Module-level toast store + viewport. Anywhere in the app (including
/// non-React modules like TerminalView's IPC error handler) can call
/// pushToast(); a single <ToastViewport /> rendered in App displays them.

import { useEffect, useState } from "react";

export type ToastKind = "error" | "info" | "warn";

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
  /// Optional secondary action label + handler.
  action?: { label: string; onClick: () => void };
  /// Set by pushToastOnce — `dismissToast` clears the matching seenKeys
  /// entry so the same key can fire again after the user dismisses it
  /// (vs. being suppressed forever for the rest of the session).
  dedupKey?: string;
};

let toasts: Toast[] = [];
const subscribers = new Set<(t: Toast[]) => void>();

function emit() {
  for (const s of subscribers) s(toasts);
}

function makeId(): string {
  return `t_${crypto.randomUUID()}`;
}

const DEFAULT_TIMEOUT_MS = 4500;

export function pushToast(
  message: string,
  opts: { kind?: ToastKind; timeoutMs?: number; action?: Toast["action"] } = {},
): string {
  const id = makeId();
  const t: Toast = {
    id,
    kind: opts.kind ?? "error",
    message,
    action: opts.action,
  };
  toasts = [...toasts, t];
  emit();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeout > 0) {
    window.setTimeout(() => dismissToast(id), timeout);
  }
  return id;
}

export function dismissToast(id: string): void {
  const before = toasts.length;
  const dismissed = toasts.find((t) => t.id === id);
  toasts = toasts.filter((t) => t.id !== id);
  // Clear the dedup key so the same condition (e.g. localStorage quota
  // exceeded after the user clears storage) can produce a fresh toast
  // next time it actually re-occurs.
  if (dismissed?.dedupKey) seenKeys.delete(dismissed.dedupKey);
  if (toasts.length !== before) emit();
}

/// One-shot dedup helper: if a toast with the same key is already showing,
/// don't push another. Once the user dismisses the toast (manually or via
/// timeout), the key is released and a future occurrence can show again.
const seenKeys = new Set<string>();
export function pushToastOnce(
  key: string,
  message: string,
  opts: Parameters<typeof pushToast>[1] = {},
): string | null {
  if (seenKeys.has(key)) return null;
  seenKeys.add(key);
  const id = makeId();
  const t: Toast = {
    id,
    kind: opts.kind ?? "error",
    message,
    action: opts.action,
    dedupKey: key,
  };
  toasts = [...toasts, t];
  emit();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeout > 0) {
    window.setTimeout(() => dismissToast(id), timeout);
  }
  return id;
}

export function useToasts(): Toast[] {
  const [snapshot, setSnapshot] = useState<Toast[]>(toasts);
  useEffect(() => {
    subscribers.add(setSnapshot);
    setSnapshot(toasts);
    return () => {
      subscribers.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}

/// Convenience for IPC failures — same signature shape that callers use
/// today, just routed through the toast system instead of console.error.
/// Still logs to the console for diagnostics.
export function reportInvokeError(cmd: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[loom] ${cmd} failed`, err);
  pushToast(`${cmd} failed: ${formatError(err)}`, { kind: "error" });
}

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/// Stacked toasts in the bottom-right corner. Wired up by App once,
/// reads the module-level store via useToasts.
export function ToastViewport() {
  const list = useToasts();
  if (list.length === 0) return null;
  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-[min(420px,calc(100vw-2rem))] flex-col gap-2"
    >
      {list.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </section>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const tone =
    toast.kind === "error"
      ? "border-coral/45 bg-coral/[0.10]"
      : toast.kind === "warn"
        ? "border-amber/45 bg-amber/[0.10]"
        : "border-rule bg-ink-1";
  const labelColor =
    toast.kind === "error"
      ? "text-coral"
      : toast.kind === "warn"
        ? "text-amber"
        : "text-faint";
  const label =
    toast.kind === "error"
      ? "error"
      : toast.kind === "warn"
        ? "warning"
        : "info";
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className={`pointer-events-auto flex items-start gap-2.5 border px-3 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-sm ${tone}`}
    >
      <span
        className={`shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] opacity-90 ${labelColor}`}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 font-sans text-[12px] leading-[1.5] break-words text-paper">
        {toast.message}
      </span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            dismissToast(toast.id);
          }}
          className="shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-paper transition-colors duration-100 hover:bg-paper/10"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss"
        className="shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 font-mono text-[12px] leading-none text-faint transition-colors duration-100 hover:text-paper"
      >
        ×
      </button>
    </div>
  );
}
