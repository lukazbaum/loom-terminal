import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { SkeletonList } from "./Skeleton";
import { useTauriEvent } from "./useTauriEvent";

type WorkspacePort = {
  pane_id: string;
  url: string;
  original_url: string;
  first_seen_ms: number;
  ready: boolean;
};

type Props = {
  workspaceId: string;
  onClose: () => void;
  onPreview: (url: string) => void;
};

function relativeAge(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/// Modal listing dev-server URLs the backend has detected for the active
/// workspace. Per port: URL + age + actions (preview, copy, ↗, dismiss).
/// Auto-refreshes when a new port is detected while the panel is open.
export function PortsPanel({ workspaceId, onClose, onPreview }: Props) {
  const [list, setList] = useState<WorkspacePort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await invoke<WorkspacePort[]>("list_workspace_ports", {
        workspaceId,
      });
      // Newest first.
      res.sort((a, b) => b.first_seen_ms - a.first_seen_ms);
      setList(res);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [workspaceId]);

  // Initial load + refresh whenever a new port is detected for any
  // workspace. The handler ignores the payload and just re-queries so
  // it doesn't have to know the event shape.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useTauriEvent("workspace-port-detected", () => {
    void refresh();
  });

  // Re-tick the relative ages once a minute so "12s ago" doesn't sit
  // there for an hour.
  useEffect(() => {
    const tick = window.setInterval(
      () => setList((l) => (l ? [...l] : l)),
      60_000,
    );
    return () => window.clearInterval(tick);
  }, []);

  const onDismiss = async (url: string) => {
    try {
      await invoke("dismiss_workspace_port", { workspaceId, url });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const onCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied((c) => (c === url ? null : c)), 1200);
    } catch {
      // ignore clipboard failures
    }
  };

  const onExternal = (url: string) => {
    invoke("plugin:opener|open_url", { url }).catch(() => {});
  };

  return (
    <Modal ariaLabel="Detected ports" onDismiss={onClose} zIndex={30}>
      <div className="flex max-h-[80vh] w-[min(640px,90vw)] flex-col overflow-hidden rounded-md border border-rule bg-ink-1">
        <div className="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-2.5">
          <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-mint">
            ports
          </span>
          <span className="font-sans text-[11px] text-faint">
            {list ? `${list.length} detected` : "loading…"}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto cursor-pointer rounded-sm px-1.5 py-1 font-mono text-[14px] leading-none text-faint transition-colors duration-100 hover:bg-ink-2 hover:text-paper"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error && (
            <div className="px-2 py-3 font-sans text-[12px] text-coral">
              {error}
            </div>
          )}
          {!error && list === null && <SkeletonList count={3} />}
          {!error && list?.length === 0 && (
            <div className="px-2 py-8 text-center font-sans text-[12px] text-faint">
              No dev-server URLs detected yet. Loom watches each terminal for
              things like <code className="text-mint">Local: http://…</code> and
              surfaces them here once the server responds.
            </div>
          )}
          {!error &&
            list?.map((p) => (
              <div
                key={p.url}
                className="mb-2 flex flex-col gap-2 rounded-md bg-ink-2 px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[12px] text-paper">
                    {p.url}
                  </span>
                  <span className="ml-auto shrink-0 font-sans text-[10.5px] text-faint">
                    {relativeAge(p.first_seen_ms)}
                  </span>
                </div>
                {p.original_url !== p.url && (
                  <div className="font-mono text-[10.5px] text-faint truncate">
                    from {p.original_url}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onPreview(p.url);
                      onClose();
                    }}
                    className="cursor-pointer rounded-sm bg-mint/[0.12] px-2.5 py-1 font-sans text-[11px] text-mint transition-colors duration-100 hover:bg-mint/20"
                  >
                    preview
                  </button>
                  <button
                    type="button"
                    onClick={() => onCopy(p.url)}
                    className="cursor-pointer rounded-sm bg-ink-3 px-2.5 py-1 font-sans text-[11px] text-paper transition-colors duration-100 hover:bg-ink-4"
                  >
                    {copied === p.url ? "copied" : "copy"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onExternal(p.url)}
                    title="Open in default browser"
                    className="cursor-pointer rounded-sm bg-ink-3 px-2.5 py-1 font-mono text-[12px] text-paper transition-colors duration-100 hover:bg-ink-4"
                  >
                    ↗
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismiss(p.url)}
                    className="ml-auto cursor-pointer rounded-sm bg-coral/[0.10] px-2.5 py-1 font-sans text-[11px] text-coral transition-colors duration-100 hover:bg-coral/20"
                  >
                    dismiss
                  </button>
                </div>
              </div>
            ))}
        </div>
      </div>
    </Modal>
  );
}
