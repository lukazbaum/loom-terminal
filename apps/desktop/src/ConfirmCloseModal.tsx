import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { pad2 } from "./format";
import { Modal } from "./Modal";
import { SecondaryButton } from "./SecondaryButton";
import type { DirtySummary } from "./types";

export function ConfirmCloseModal({
  label,
  shellCount,
  workspaceId,
  onCancel,
  onConfirm,
}: {
  label: string;
  shellCount: number;
  workspaceId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [dirty, setDirty] = useState<DirtySummary | null>(null);

  // Best-effort dirty check. Treat any failure (not a repo, no git) as
  // "no warning" rather than blocking the user from closing.
  useEffect(() => {
    let cancelled = false;
    invoke<DirtySummary>("workspace_dirty_summary", { workspaceId })
      .then((res) => {
        if (!cancelled) setDirty(res);
      })
      .catch(() => {
        if (!cancelled) setDirty({ dirty_files: null, branch: null });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const dirtyCount =
    dirty && typeof dirty.dirty_files === "number" ? dirty.dirty_files : 0;
  const showDirty = dirtyCount > 0;

  return (
    <Modal
      ariaLabelledBy="confirm-close-title"
      onDismiss={onCancel}
      initialFocusRef={cancelRef}
      zIndex={50}
    >
      <div className="w-full max-w-[460px] border border-rule bg-ink-1 px-7 py-7 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        <h2
          id="confirm-close-title"
          className="m-0 font-sans text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-paper"
        >
          Close <em className="font-normal italic text-amber">{label}</em>?
        </h2>
        <p className="mt-3 mb-3 text-[12.5px] leading-[1.55] text-muted">
          {shellCount === 1
            ? "The running shell will be terminated."
            : `All ${pad2(shellCount)} running shells will be terminated.`}{" "}
          This can&rsquo;t be undone.
        </p>
        {showDirty && (
          <div className="mb-3 flex items-start gap-2 border border-coral/30 bg-coral/[0.06] px-3 py-2 text-[11.5px] leading-[1.5] text-coral">
            <span aria-hidden className="font-mono text-[14px] leading-none">
              !
            </span>
            <span>
              {dirty?.branch ? (
                <>
                  <code className="font-mono text-paper">{dirty.branch}</code>{" "}
                  has{" "}
                </>
              ) : (
                "Workspace has "
              )}
              <span className="font-mono">{dirtyCount}</span> uncommitted file
              {dirtyCount === 1 ? "" : "s"}. Closing will leave them on disk but
              you&rsquo;ll lose the running shell.
            </span>
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <SecondaryButton ref={cancelRef} onClick={onCancel}>
            Cancel
          </SecondaryButton>
          <button
            type="button"
            onClick={onConfirm}
            className="cursor-pointer border border-coral/45 bg-coral/[0.08] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-coral transition-colors duration-150 hover:border-coral hover:bg-coral/15"
          >
            Close workspace
          </button>
        </div>
      </div>
    </Modal>
  );
}
