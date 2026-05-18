import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { TerminalView, type CompletionSignal } from "./TerminalView";
import { WebPreviewPane } from "./WebPreviewPane";
import { PaneContextMenu, type PaneMenuItem } from "./PaneContextMenu";
import { pushToast, reportInvokeError } from "./toast";
import type { Pane, Session } from "./types";
import { useActionChord } from "./useActionChord";

const PANE_MIN_PX = 80;
const COMPLETION_PILL_MS = 6000;

// Memoized so a parent re-render with unchanged props (e.g. a sibling
// workspace updating) doesn't redo this workspace's entire pane grid.
// All four action callbacks accept `(workspaceId, ...)` from above; the
// internal wrappers below inject `session.id` so the wrapper identities
// stay stable per workspace, matching the upstream callback shape used
// for handlePaneCompletion.
export const Workspace = memo(function Workspace({
  session,
  activePaneId,
  visible,
  onActivatePane,
  onClosePane,
  onTogglePin,
  onDuplicatePane,
  onCompletion,
  onReachedBottom,
}: {
  session: Session;
  activePaneId: string | null;
  /// True when this workspace is the foreground tab. Threaded down to
  /// each TerminalView so hidden workspaces stop processing PTY chunks
  /// (the backend keeps streaming into its ring buffer; on resume the
  /// terminal asks for a catch-up snapshot).
  visible: boolean;
  onActivatePane: (workspaceId: string, paneId: string) => void;
  onClosePane: (workspaceId: string, paneId: string) => void;
  onTogglePin: (workspaceId: string, paneId: string) => void;
  onDuplicatePane: (workspaceId: string, paneId: string) => void;
  /// Fired when a pane in this workspace finishes a turn. Workspace
  /// injects its own `workspaceId` before bubbling, so callers can use
  /// a single stable handler for every pane across every workspace.
  /// `wasAtBottom` tells the caller whether the user actually saw the
  /// result — used to decide whether to pulse the tab.
  onCompletion?: (
    paneId: string,
    workspaceId: string,
    wasAtBottom: boolean,
  ) => void;
  /// Fired when the user scrolls a pane back to the bottom. Used to
  /// clear the "unseen completion" tab pulse once they've caught up.
  onReachedBottom?: (paneId: string, workspaceId: string) => void;
}) {
  const [paneMenu, setPaneMenu] = useState<{
    paneId: string;
    x: number;
    y: number;
  } | null>(null);

  /// Per-pane "done" pill state. Lives locally instead of on App so a
  /// completion in one workspace doesn't churn every other workspace's
  /// memo. Entries are pruned on insert: any stale completion older than
  /// `COMPLETION_PILL_MS` drops out, so a long-running workspace with
  /// thousands of completions doesn't accumulate dead map keys. Each
  /// surviving entry self-hides via `PaneCompletionPill`'s one-shot
  /// timeout below.
  const [paneCompletions, setPaneCompletions] = useState<
    Record<string, { signal: string; at: number }>
  >({});

  /// Stable adapters that inject this workspace's id before bubbling, so
  /// the same handler identities reach every TerminalView this Workspace
  /// renders. Without this, inline arrows in the .map() below would
  /// create fresh handlers per pane per render and bust TerminalView's
  /// React.memo.
  const wsId = session.id;
  const handleTerminalCompletion = useCallback(
    (paneId: string, _signal: CompletionSignal, wasAtBottom: boolean) => {
      const now = Date.now();
      setPaneCompletions((prev) => {
        // Prune entries past the pill's visible window so the map can't
        // grow without bound across a long-running session (20 panes × 5
        // completions/hour over an 8-hour day = 800 keys otherwise).
        const next: Record<string, { signal: string; at: number }> = {};
        for (const [id, entry] of Object.entries(prev)) {
          if (now - entry.at <= COMPLETION_PILL_MS) {
            next[id] = entry;
          }
        }
        next[paneId] = { signal: "idle", at: now };
        return next;
      });
      onCompletion?.(paneId, wsId, wasAtBottom);
    },
    [onCompletion, wsId],
  );
  const handleTerminalReachedBottom = useCallback(
    (paneId: string) => {
      onReachedBottom?.(paneId, wsId);
    },
    [onReachedBottom, wsId],
  );
  const handleActivatePane = useCallback(
    (paneId: string) => onActivatePane(wsId, paneId),
    [onActivatePane, wsId],
  );
  const handleClosePane = useCallback(
    (paneId: string) => onClosePane(wsId, paneId),
    [onClosePane, wsId],
  );
  const handleTogglePin = useCallback(
    (paneId: string) => onTogglePin(wsId, paneId),
    [onTogglePin, wsId],
  );
  const handleDuplicatePane = useCallback(
    (paneId: string) => onDuplicatePane(wsId, paneId),
    [onDuplicatePane, wsId],
  );

  const copyPaneOutput = async (paneId: string) => {
    try {
      const text = await invoke<string>("read_pane_text", { paneId });
      await navigator.clipboard.writeText(text);
      pushToast("Copied pane output to clipboard.", { kind: "info" });
    } catch (err) {
      reportInvokeError("read_pane_text", err);
    }
  };

  const restartPane = async (paneId: string) => {
    try {
      await invoke("restart_pane", { paneId });
    } catch (err) {
      reportInvokeError("restart_pane", err);
    }
  };

  const closePaneChord = useActionChord("pane.close");

  const buildPaneMenu = (pane: Pane): PaneMenuItem[] => {
    const isTerminal = (pane.kind ?? "terminal") === "terminal";
    const pinned = !!session.pinnedPaneIds?.includes(pane.id);
    // Preview panes already expose reload / open-external on their own
    // toolbar, and Copy/Restart/Duplicate don't apply — so the right-click
    // menu collapses to pin + close to avoid grey-filler items.
    if (!isTerminal) {
      return [
        {
          id: "pin",
          label: pinned ? "Unpin pane" : "Pin pane",
          onClick: () => handleTogglePin(pane.id),
        },
        {
          id: "close",
          label: "Close pane",
          shortcut: closePaneChord,
          tone: "danger",
          disabled: pinned,
          onClick: () => handleClosePane(pane.id),
        },
      ];
    }
    return [
      {
        id: "copy",
        label: "Copy pane output",
        onClick: () => void copyPaneOutput(pane.id),
      },
      {
        id: "restart",
        label: "Restart pane",
        onClick: () => void restartPane(pane.id),
      },
      {
        id: "duplicate",
        label: "Duplicate pane",
        onClick: () => handleDuplicatePane(pane.id),
      },
      {
        id: "pin",
        label: pinned ? "Unpin pane" : "Pin pane",
        onClick: () => handleTogglePin(pane.id),
      },
      {
        id: "close",
        label: "Close pane",
        shortcut: closePaneChord,
        tone: "danger",
        disabled: pinned,
        onClick: () => handleClosePane(pane.id),
      },
    ];
  };
  const paneCount = session.panes.length;
  // Manual override > auto-fit. When override is set we still need at
  // least one row/col per pane, so we clamp upward if the user shrunk
  // below the pane count (e.g. they set 2x2 then spawned a 5th pane).
  const cols = useMemo(() => {
    if (typeof session.gridCols === "number") {
      const minCols = Math.max(
        1,
        Math.ceil(
          paneCount / Math.max(1, session.gridRows ?? session.gridCols),
        ),
      );
      return Math.max(session.gridCols, minCols);
    }
    return Math.max(1, Math.ceil(Math.sqrt(paneCount)));
  }, [paneCount, session.gridCols, session.gridRows]);
  const rows = useMemo(() => {
    if (typeof session.gridRows === "number") {
      const minRows = Math.max(1, Math.ceil(paneCount / cols));
      return Math.max(session.gridRows, minRows);
    }
    return Math.max(1, Math.ceil(paneCount / cols));
  }, [paneCount, cols, session.gridRows]);

  const [colFrs, setColFrs] = useState<number[]>(() => Array(cols).fill(1));
  const [rowFrs, setRowFrs] = useState<number[]>(() => Array(rows).fill(1));
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Refs so the drag handler reads the latest fractions without
  // re-binding on every state change.
  const colFrsRef = useRef(colFrs);
  const rowFrsRef = useRef(rowFrs);

  // Adjust fractions in place when the pane count changes — preserve
  // existing user resizing instead of resetting everything to 1.
  // Append `1`s on growth, slice on shrink.
  useEffect(() => {
    setColFrs((prev) => {
      if (prev.length === cols) return prev;
      if (cols > prev.length) {
        return [...prev, ...Array(cols - prev.length).fill(1)];
      }
      return prev.slice(0, cols);
    });
    setRowFrs((prev) => {
      if (prev.length === rows) return prev;
      if (rows > prev.length) {
        return [...prev, ...Array(rows - prev.length).fill(1)];
      }
      return prev.slice(0, rows);
    });
  }, [cols, rows]);

  // Mirror state into CSS variables on the grid element. The grid
  // template reads `var(--col-N, 1fr)` / `var(--row-N, 1fr)` so the
  // drag handler can update tracks imperatively (skipping a 60 Hz
  // Workspace re-render during the drag) and React state just holds
  // the final value at mouseup. Values are written with the `fr` unit
  // so they slot directly into `grid-template-columns/rows`.
  useEffect(() => {
    colFrsRef.current = colFrs;
    const grid = gridRef.current;
    if (!grid) return;
    for (let i = 0; i < colFrs.length; i++) {
      grid.style.setProperty(`--col-${i}`, `${colFrs[i]}fr`);
    }
  }, [colFrs]);
  useEffect(() => {
    rowFrsRef.current = rowFrs;
    const grid = gridRef.current;
    if (!grid) return;
    for (let i = 0; i < rowFrs.length; i++) {
      grid.style.setProperty(`--row-${i}`, `${rowFrs[i]}fr`);
    }
  }, [rowFrs]);

  // Holds the teardown for the in-flight drag, if any. The mount-only
  // effect below drains it on unmount so a drag interrupted by a
  // workspace switch / hot reload / pane close that unmounts us
  // doesn't leave window listeners, document.body styles, or a
  // pending setState on a dead component behind.
  const activeDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      activeDragCleanupRef.current?.();
      activeDragCleanupRef.current = null;
    },
    [],
  );

  // One handler factory for both axes: col/row geometry differs only
  // in which client coordinate, container dimension, fractions ref,
  // setter, CSS variable, and cursor are read/written. Pulling it
  // into a single function keeps the bug-fix surface in one place.
  const startAxisResize =
    (axis: "col" | "row", idx: number) =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const grid = gridRef.current;
      if (!grid) return;
      const target = e.currentTarget;
      const pointerId = e.pointerId;

      const isCol = axis === "col";
      const fracsRef = isCol ? colFrsRef : rowFrsRef;
      const setFracs = isCol ? setColFrs : setRowFrs;
      const varPrefix = isCol ? "--col-" : "--row-";
      const cursor = isCol ? "col-resize" : "row-resize";

      const startFrs = [...fracsRef.current];
      const startA = startFrs[idx];
      const startB = startFrs[idx + 1];
      if (startA === undefined || startB === undefined) return;
      const totalFr = startFrs.reduce((s, f) => s + f, 0);
      const startCoord = isCol ? e.clientX : e.clientY;

      // Pointer capture keeps move/up events flowing to this element
      // even when the cursor leaves the OS window or sweeps over the
      // xterm canvas (which would otherwise eat the events).
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Older WebViews without pointer capture: window-level listeners
        // would be the fallback, but Tauri's WebView supports it.
      }

      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";

      let lastA = startA;
      let lastB = startB;
      let rafId: number | null = null;
      let pendingA = startA;
      let pendingB = startB;

      const flush = () => {
        rafId = null;
        grid.style.setProperty(`${varPrefix}${idx}`, `${pendingA}fr`);
        grid.style.setProperty(`${varPrefix}${idx + 1}`, `${pendingB}fr`);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        // Pane added/closed mid-drag: idx/idx+1 may no longer name
        // adjacent live tracks. Bail rather than commit a stale shape.
        const liveFrs = fracsRef.current;
        if (idx + 1 >= liveFrs.length) return;
        // Recompute the pixel→fr conversion every frame. The container
        // can change width mid-drag (window resize, sidebar resizer in
        // App.tsx, devtools toggle) — a captured-once factor would
        // make the splitter drift away from the cursor.
        const containerSize = isCol ? grid.clientWidth : grid.clientHeight;
        if (containerSize <= 0) return;
        const frPerPx = totalFr / containerSize;
        const minFr = PANE_MIN_PX * frPerPx;
        const coord = isCol ? ev.clientX : ev.clientY;
        const deltaFr = (coord - startCoord) * frPerPx;
        const aNew = startA + deltaFr;
        const bNew = startB - deltaFr;
        if (aNew < minFr || bNew < minFr) return;
        lastA = aNew;
        lastB = bNew;
        pendingA = aNew;
        pendingB = bNew;
        // RAF-batch the CSS writes: pointermove can fire >120 Hz on
        // high-refresh displays and each write triggers grid track
        // recalc + ResizeObserver fanout to every pane.
        if (rafId === null) rafId = window.requestAnimationFrame(flush);
      };

      const cleanup = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // Already released (e.g. capture lost when target removed).
        }
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      function finish() {
        cleanup();
        if (activeDragCleanupRef.current === cleanup) {
          activeDragCleanupRef.current = null;
        }
        // Only commit if the grid shape still matches what we dragged.
        const liveFrs = fracsRef.current;
        if (idx + 1 >= liveFrs.length) return;
        const next = [...liveFrs];
        next[idx] = lastA;
        next[idx + 1] = lastB;
        setFracs(next);
      }

      activeDragCleanupRef.current?.();
      activeDragCleanupRef.current = cleanup;
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", finish);
    };

  const startColResize = (idx: number) => startAxisResize("col", idx);
  const startRowResize = (idx: number) => startAxisResize("row", idx);

  const menuPane = paneMenu
    ? session.panes.find((p) => p.id === paneMenu.paneId)
    : null;

  // Flat CSS-grid render. Every pane is a direct child of the same
  // container so closing a pane only changes other panes' grid-row /
  // grid-column coordinates — React's reconciler never reparents
  // them, the TerminalView stays mounted, and the backend PTY keeps
  // running. (Previously panes lived inside per-row flex wrappers; a
  // grid reflow on close moved panes between row wrappers, which
  // React treated as unmount + remount → kill_terminal on the live
  // PTY → other panes appeared to wipe.)
  //
  // Track layout: pane tracks at odd grid lines, 3 px separator
  // tracks at even ones. So a pane at (row, col) lives at grid line
  // 2*col + 1 / 2*row + 1.
  const totalCells = rows * cols;
  const hasPartialLastRow = paneCount < totalCells;
  // The last pane (when the row is partial) spans from its natural
  // column to the end of the grid. Separators inside that span would
  // slice the pane visually, so we shorten them to stop above the
  // partial row. Separators left of the span still cross it — they
  // sit between two real panes in the partial row.
  const lastPaneCol = hasPartialLastRow ? (paneCount - 1) % cols : -1;
  const partialRowStartLine = 2 * (rows - 1) + 1;
  const colTemplate = Array.from(
    { length: cols },
    (_, c) => `var(--col-${c}, 1fr)`,
  ).join(" 3px ");
  const rowTemplate = Array.from(
    { length: rows },
    (_, r) => `var(--row-${r}, 1fr)`,
  ).join(" 3px ");
  return (
    <div
      ref={gridRef}
      className="grid h-full bg-ink-0"
      style={{
        gridTemplateColumns: colTemplate,
        gridTemplateRows: rowTemplate,
      }}
    >
      {paneMenu && menuPane && (
        <PaneContextMenu
          items={buildPaneMenu(menuPane)}
          x={paneMenu.x}
          y={paneMenu.y}
          onClose={() => setPaneMenu(null)}
        />
      )}
      {session.panes.map((pane, tileIdx) => {
        const row = Math.floor(tileIdx / cols);
        const col = tileIdx % cols;
        // Stretch the last pane in a partial last row across the
        // remaining empty columns so the row doesn't trail off into
        // blank space.
        const isLastInPartialRow =
          hasPartialLastRow && tileIdx === paneCount - 1;
        const isActive = pane.id === activePaneId;
        const completion = paneCompletions[pane.id];
        // Wrapper for one pane in the grid. Catches mouseDown so a click
        // anywhere in the pane (terminal background, padding, header)
        // marks it active. The actual interactive content is the
        // <TerminalView> or <WebPreviewPane> inside, which is properly
        // keyboard-focusable; activation also flows from keyboard focus
        // there. The wrapper itself isn't a button — it's a layout
        // container that happens to capture activate events.
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: container click activates the inner interactive child (terminal/preview) which is keyboard-focusable on its own
          <div
            key={pane.id}
            className={`group/pane relative min-h-0 min-w-0 overflow-hidden bg-ink-0 ${
              isActive ? "ring-1 ring-inset ring-amber/45" : ""
            }`}
            style={{
              gridColumnStart: 2 * col + 1,
              gridColumnEnd: isLastInPartialRow ? -1 : undefined,
              gridRowStart: 2 * row + 1,
            }}
            onMouseDown={() => handleActivatePane(pane.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              handleActivatePane(pane.id);
              setPaneMenu({
                paneId: pane.id,
                x: e.clientX,
                y: e.clientY,
              });
            }}
          >
            <div
              className="h-full w-full opacity-0 animate-tile-in"
              style={{ animationDelay: `${tileIdx * 40}ms` }}
            >
              {pane.kind === "preview" && pane.previewUrl ? (
                <WebPreviewPane
                  paneId={pane.id}
                  url={pane.previewUrl}
                  focused={isActive}
                />
              ) : (
                <TerminalView
                  paneId={pane.id}
                  workspaceId={session.id}
                  path={session.path}
                  index={tileIdx}
                  command={pane.command}
                  cwd={pane.cwd}
                  env={pane.env}
                  sessionId={pane.sessionId}
                  sessionAgent={pane.sessionAgent}
                  focused={isActive}
                  visible={visible}
                  idleQuietMs={session.idleQuietMs}
                  onCompletion={handleTerminalCompletion}
                  onReachedBottom={handleTerminalReachedBottom}
                />
              )}
            </div>
            {completion && <PaneCompletionPill at={completion.at} />}
            {session.pinnedPaneIds?.includes(pane.id) && (
              <span
                role="img"
                aria-label="Pinned"
                title="Pinned — right-click to unpin"
                className="pointer-events-none absolute right-9 top-2 z-10 font-mono text-[12px] leading-none text-amber/80"
              >
                ⌐
              </span>
            )}
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleClosePane(pane.id);
              }}
              aria-label="Close pane"
              title="Close pane"
              className="absolute right-1.5 top-1.5 z-20 flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm bg-ink-1/85 font-mono text-[14px] leading-none text-faint opacity-0 backdrop-blur-sm transition-opacity duration-150 hover:bg-coral/15 hover:text-coral group-hover/pane:opacity-100 focus-visible:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}
      {Array.from({ length: Math.max(0, cols - 1) }, (_, c) => {
        // Separator c sits between col c and col c+1. If it falls
        // inside the last (spanned) partial-row pane, stop it before
        // the partial row; otherwise let it run full-height so the
        // user can drag it from any row.
        const crossesPartialSpan = hasPartialLastRow && c >= lastPaneCol;
        const rowEnd = crossesPartialSpan ? partialRowStartLine : -1;
        // If the separator would have zero height (single partial row
        // and it's inside the span), skip it entirely.
        if (rowEnd !== -1 && rowEnd <= 1) return null;
        // No role/aria here. A `role="separator"` + `aria-orientation`
        // pair is parsed by ARIA as an interactive *splitter*, which then
        // requires focus + value-now/min/max attributes and a keyboard
        // handler. We don't yet implement keyboard resize, so claiming
        // the splitter contract would lie to assistive tech. Leaving the
        // divs unannounced matches their current capability (mouse-only).
        return (
          <div
            key={`col-sep-${c}`}
            aria-hidden
            className="relative z-10 bg-rule transition-colors duration-150 hover:bg-amber/40"
            style={{
              gridColumnStart: 2 * c + 2,
              gridColumnEnd: 2 * c + 3,
              gridRowStart: 1,
              gridRowEnd: rowEnd,
            }}
          >
            {/* Widen the hit area beyond the 3 px visible bar so the
                cursor still snaps onto it like the old -mx-[5px] trick. */}
            <div
              aria-hidden
              onPointerDown={startColResize(c)}
              className="absolute inset-y-0 -inset-x-[5px] cursor-col-resize"
            />
          </div>
        );
      })}
      {Array.from({ length: Math.max(0, rows - 1) }, (_, r) => (
        <div
          key={`row-sep-${r}`}
          aria-hidden
          className="relative z-10 bg-rule transition-colors duration-150 hover:bg-amber/40"
          style={{
            gridRowStart: 2 * r + 2,
            gridRowEnd: 2 * r + 3,
            gridColumnStart: 1,
            gridColumnEnd: -1,
          }}
        >
          <div
            aria-hidden
            onPointerDown={startRowResize(r)}
            className="absolute inset-x-0 -inset-y-[5px] cursor-row-resize"
          />
        </div>
      ))}
    </div>
  );
});

/// Auto-fading "done" badge in the pane header for a few seconds after
/// onCompletion fires. Previously used a 500ms setInterval that kept
/// ticking for the lifetime of the workspace even after the pill was
/// hidden — across a long session that accumulated dozens of idle 2 Hz
/// timers per workspace. Now: one setTimeout, one fade transition, done.
function PaneCompletionPill({ at }: { at: number }) {
  const [expired, setExpired] = useState(
    () => Date.now() - at > COMPLETION_PILL_MS,
  );
  useEffect(() => {
    const remaining = COMPLETION_PILL_MS - (Date.now() - at);
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const handle = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(handle);
  }, [at]);
  if (expired) return null;
  return (
    <span
      className="pointer-events-none absolute left-1.5 top-1.5 z-20 inline-flex items-center gap-1.5 border border-mint/45 bg-mint/[0.10] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-mint backdrop-blur-sm"
      style={{
        // Hold opacity 1 briefly, then fade across the remainder of the
        // window using CSS transition rather than a JS tick.
        opacity: 0,
        animation: `paneCompletionFade ${COMPLETION_PILL_MS}ms ease-out forwards`,
      }}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-mint"
      />
      done
    </span>
  );
}
