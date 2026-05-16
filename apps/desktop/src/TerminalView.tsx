import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type DragEvent,
  type MutableRefObject,
} from "react";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon as WebglAddonType } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { reportInvokeError } from "./toast";
import { useSetting } from "./settings";
import { resumeAwareCommand, type SessionAgent } from "./sessionPersist";
import { acquireTerminal, releaseTerminal } from "./terminalPool";
import { getThemeOrDefault, useThemes, xtermThemeFromTheme } from "./themes";

/// Disposes drained off the main thread one-at-a-time. Closing a workspace
/// unmounts every TerminalView in one React commit; doing `term.dispose()`
/// + `webgl.dispose()` synchronously for each pane blocked the click frame
/// for hundreds of ms per pane (WebGL context teardown + 5000-line
/// scrollback). Yielding between disposes lets the workspace tab disappear
/// immediately and tears the panes down behind the paint.
type DisposeFn = () => void;
const disposeQueue: DisposeFn[] = [];
let disposeScheduled = false;
function scheduleDispose(fn: DisposeFn) {
  disposeQueue.push(fn);
  if (disposeScheduled) return;
  disposeScheduled = true;
  const drain = () => {
    const start = performance.now();
    // Cap each batch at ~4 ms so we never noticeably stall a frame, but
    // still amortize the scheduling overhead when many disposes pile up.
    while (disposeQueue.length > 0 && performance.now() - start < 4) {
      const next = disposeQueue.shift();
      try {
        next?.();
      } catch {
        // A failed dispose is rare and not actionable here — xterm logs
        // the underlying error already. Don't let one bad dispose strand
        // the rest of the queue.
      }
    }
    if (disposeQueue.length > 0) {
      const w = window as Window & {
        requestIdleCallback?: (cb: () => void) => number;
      };
      if (typeof w.requestIdleCallback === "function") {
        w.requestIdleCallback(drain);
      } else {
        setTimeout(drain, 0);
      }
    } else {
      disposeScheduled = false;
    }
  };
  // First batch runs on the next macrotask so the current React commit
  // (which removes the host from the DOM) lands first.
  setTimeout(drain, 0);
}

/// Feature-detect WebGL before we even attempt to load the addon.
/// On hosts without WebGL (older VMs, headless test runners, browsers
/// where the user disabled it) the import is wasted bytes — xterm
/// transparently falls back to its DOM renderer.
function hostSupportsWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const ctx =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    return !!ctx;
  } catch {
    return false;
  }
}

export type CompletionSignal = "bell" | "osc133" | "idle";

type Props = {
  paneId: string;
  workspaceId: string;
  path: string;
  index: number;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  /// When set and `command` matches `sessionAgent`, the PTY is spawned
  /// with that agent's resume flag (Claude: `--resume <id>`, Codex:
  /// `resume <id>`, Gemini: `--resume <id>`) so the conversation
  /// continues mid-stream. Spliced at invoke time only — never baked
  /// into the saved command string — so a newer session id (e.g. after
  /// `/clear`) always wins over a hydrated one.
  sessionId?: string;
  /// Which agent captured `sessionId`. Used to pick the right resume
  /// flag in `resumeAwareCommand`. Absent on legacy snapshots —
  /// `resumeAwareCommand` defaults to "claude" when unspecified.
  sessionAgent?: SessionAgent;
  focused?: boolean;
  /// True when the terminal's parent workspace is the active one.
  /// When false we stop writing chunks to xterm and capture the
  /// backend ring-buffer cursor; on resume we ask the backend for
  /// everything that streamed during the pause and write it in one
  /// go, leaving xterm's existing scrollback intact.
  visible?: boolean;
  /// Override the persisted terminal font size. When omitted, falls
  /// back to the user's Settings value.
  fontSize?: number;
  /// Override the idle quiet-window timer (ms). Falls back to settings.
  idleQuietMs?: number;
  /// Fired when the terminal detects the agent finished a turn (bell,
  /// OSC 133 prompt marker, or a quiet-period heuristic). The `paneId` is
  /// the caller-supplied prop — forwarded so the parent can use the same
  /// handler instance for every pane (a per-pane closure was the previous
  /// shape and busted memoization on every parent render).
  onCompletion?: (paneId: string, signal: CompletionSignal) => void;
};

type OutputPayload = { id: string; data: string };
type ExitPayload = { id: string };

type PaneSnapshot = { data: string; new_token: number; dropped: boolean };

const IDLE_MIN_BURST_BYTES = 50;

function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/// Surface IPC failures instead of dropping them silently. Most often
/// the cause is a pane that was killed mid-flight (write_terminal after
/// kill_terminal). For those benign races we just log; for everything
/// else we route through the toast system so users see when something
/// genuinely went wrong (e.g. the daemon stopped responding).
function logIpcError(cmd: string, err: unknown) {
  const msg = typeof err === "string" ? err : String(err);
  if (
    msg.includes("Unknown terminal") ||
    msg.includes("pane gone") ||
    msg.includes("not registered")
  ) {
    // eslint-disable-next-line no-console
    console.warn(`[loom] ${cmd} (pane already gone): ${msg}`);
    return;
  }
  reportInvokeError(cmd, err);
}

// ─── Mount-effect helpers ───────────────────────────────────────────────
//
// The mount effect used to be a ~600-line block doing seven things in
// tightly-coupled order (webgl load, completion signals, output channel,
// pause/resume, spawn, resize/fit, cleanup). Pulled out as named helpers
// here, each owning one phase of the lifecycle; they share `TermState`
// (mutable bag) so they can flip flags the others read without resorting
// to closure-only locals. The effect itself is now mostly composition.

type Mode = "live" | "paused" | "resuming";

type TermState = {
  /// Flipped true in cleanup. Every async path checks before touching
  /// xterm or invoking IPC, since both can land after unmount.
  disposed: boolean;
  /// Backend session id from `spawn_terminal`. Null until the spawn
  /// promise resolves; cleanup uses it to fire `kill_terminal`.
  id: string | null;
  /// Output dispatcher state machine. `paused` drops bytes (the backend
  /// ring buffer keeps them); `resuming` queues them behind the catch-up
  /// snapshot; `live` writes through.
  mode: Mode;
  /// Ring-buffer cursor recorded when the pane was hidden. The resume
  /// path passes this to `snapshot_pane_since` to fetch only what we
  /// missed.
  pausedToken: number;
  /// Bytes streamed during `mode === "resuming"` — these arrived AFTER
  /// the snapshot cursor and must be written after the catch-up so the
  /// stream order is preserved.
  resumingQueue: string[];
  /// RAF-batched output buffer. `flushOutput` writes the whole batch at
  /// most once per frame; without this an `npm install` burst pegged
  /// xterm with one layout per chunk × N panes.
  pendingOutput: string;
  pendingOutputBytes: number;
  outputScheduled: boolean;
  /// Idle-signal hysteresis. Won't fire until the user has typed since
  /// the last completion (kills false-fires on the agent's startup
  /// banner) and the burst since the prior signal is non-trivial.
  hasInputSinceSignal: boolean;
  burstBytes: number;
  idleTimer: number | null;
  /// Latch flipped on the first OSC 9 `loom-stop` seen for this pane.
  /// Once we know the bundled Stop hook is live, the bell / OSC 133 / idle
  /// fallbacks are silenced — they false-fire often for hook-equipped
  /// Claude/Codex/Gemini sessions (permission prompts, shell integration,
  /// mid-turn tool-call pauses).
  sawLoomStopEver: boolean;
  /// True while the resume path is writing catch-up bytes. Suppresses
  /// `scrollToBottom` for OSC signals embedded in the replay — those
  /// completions already happened, so snapping yanks the user out of
  /// scrollback they had open before tabbing away.
  replayingSnapshot: boolean;
  /// Loaded asynchronously; cleared in the addon's `onContextLoss`
  /// fallback. Held here so cleanup can dispose it.
  webgl: WebglAddonType | null;
};

function makeTermState(visible: boolean): TermState {
  return {
    disposed: false,
    id: null,
    mode: visible ? "live" : "paused",
    pausedToken: 0,
    resumingQueue: [],
    pendingOutput: "",
    pendingOutputBytes: 0,
    outputScheduled: false,
    hasInputSinceSignal: false,
    burstBytes: 0,
    idleTimer: null,
    sawLoomStopEver: false,
    replayingSnapshot: false,
    webgl: null,
  };
}

/// Lazy-load the WebGL addon so its ~30 KB raw don't ship in the main
/// xterm vendor chunk. No-op on hosts without WebGL — xterm's DOM
/// renderer takes over implicitly. Records the addon on `state.webgl`
/// so cleanup can dispose it.
function setupWebgl(term: Terminal, state: TermState): void {
  if (!hostSupportsWebgl()) return;
  import("@xterm/addon-webgl")
    .then(({ WebglAddon }) => {
      if (state.disposed) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // Context loss happens on driver crashes, GPU resets, or when
          // the browser hits its per-page WebGL ceiling and recycles the
          // oldest. xterm transparently falls back to the canvas/DOM
          // renderer once the addon disposes — log so a sudden perf
          // cliff has a discoverable cause.
          // eslint-disable-next-line no-console
          console.warn(
            "[loom] xterm WebGL context lost — DOM renderer takes over",
          );
          addon.dispose();
          state.webgl = null;
        });
        term.loadAddon(addon);
        state.webgl = addon;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[loom] xterm WebGL load failed, using DOM renderer", e);
      }
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn("[loom] xterm WebGL chunk failed to load", e);
    });
}

type CompletionCtx = {
  paneId: string;
  onCompletionRef: MutableRefObject<
    ((paneId: string, signal: CompletionSignal) => void) | undefined
  >;
  idleTimeoutMsRef: MutableRefObject<number>;
  mountDisposables: IDisposable[];
};

/// Wire up the three completion signals — bell, OSC 133 D, OSC 9
/// `loom-stop` — plus the silence-based idle heuristic. Returns the
/// signal-firing primitives so the output channel can arm the idle
/// timer after each chunk.
function setupCompletionSignals(
  term: Terminal,
  state: TermState,
  ctx: CompletionCtx,
): {
  fireSignal: (signal: CompletionSignal) => void;
  armIdleTimer: (chunkBytes: number) => void;
} {
  const fireSignal = (signal: CompletionSignal) => {
    state.hasInputSinceSignal = false;
    state.burstBytes = 0;
    if (state.idleTimer !== null) {
      window.clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    // Snap to bottom on completion so the user doesn't miss the final
    // bytes after a long-running command. xterm preserves the user's
    // scroll position during streaming output, but signals are the
    // moment they actually want to see the result.
    if (!state.replayingSnapshot) {
      try {
        term.scrollToBottom();
      } catch {
        // term may be disposing — ignore
      }
    }
    ctx.onCompletionRef.current?.(ctx.paneId, signal);
  };

  const armIdleTimer = (chunkBytes: number) => {
    state.burstBytes += chunkBytes;
    if (state.idleTimer !== null) window.clearTimeout(state.idleTimer);
    state.idleTimer = window.setTimeout(() => {
      state.idleTimer = null;
      if (state.sawLoomStopEver) return;
      if (
        state.hasInputSinceSignal &&
        state.burstBytes >= IDLE_MIN_BURST_BYTES
      ) {
        fireSignal("idle");
      }
    }, ctx.idleTimeoutMsRef.current);
  };

  ctx.mountDisposables.push(
    term.onBell(() => {
      if (state.sawLoomStopEver) return;
      fireSignal("bell");
    }),
  );
  ctx.mountDisposables.push(
    term.parser.registerOscHandler(133, (data) => {
      if (!state.sawLoomStopEver && data.startsWith("D")) fireSignal("osc133");
      return false;
    }),
  );
  // Loom Stop hook emits OSC 9 with "loom-stop"; this is the
  // authoritative "turn ended" signal. Once we've seen it for this
  // pane, the bell / OSC 133 D / idle fallbacks above are silenced.
  ctx.mountDisposables.push(
    term.parser.registerOscHandler(9, (data) => {
      if (data === "loom-stop") {
        state.sawLoomStopEver = true;
        fireSignal("bell");
      }
      return false;
    }),
  );

  return { fireSignal, armIdleTimer };
}

/// Per-pane output / exit channels — eliminates the O(N²) listener
/// fanout that came from one global "terminal-output" event being
/// visited by every pane's listener and filtering by id. With channels,
/// the backend reader sends ONLY to this pane's TerminalView.
///
/// Writes are coalesced through one requestAnimationFrame so xterm sees
/// at most ~60 writes/sec/pane regardless of how fast the backend
/// streams. Without this, an `npm install` flood (dozens of chunks/sec
/// × 4 panes) pegs the renderer with per-chunk layout passes.
function wireOutputChannel(
  term: Terminal,
  state: TermState,
  armIdleTimer: (chunkBytes: number) => void,
  decoder: TextDecoder,
): {
  onOutput: Channel<OutputPayload>;
  onExit: Channel<ExitPayload>;
  flushOutput: () => void;
} {
  const flushOutput = () => {
    state.outputScheduled = false;
    if (state.disposed) return;
    if (!state.pendingOutput) return;
    const text = state.pendingOutput;
    const bytes = state.pendingOutputBytes;
    state.pendingOutput = "";
    state.pendingOutputBytes = 0;
    term.write(text);
    armIdleTimer(bytes);
  };
  const onOutput = new Channel<OutputPayload>();
  onOutput.onmessage = (p) => {
    if (state.disposed) return;
    const bytes = decodeBase64ToBytes(p.data);
    const text = decoder.decode(bytes, { stream: true });
    if (state.mode === "paused") {
      // Backend still buffers in the ring; we'll fetch the missed bytes
      // via snapshot_pane_since on resume.
      return;
    }
    if (state.mode === "resuming") {
      // Snapshot in flight — these bytes are AFTER snap.new_token, so
      // they need to land after the snapshot's catch-up.
      state.resumingQueue.push(text);
      return;
    }
    state.pendingOutput += text;
    state.pendingOutputBytes += bytes.length;
    if (!state.outputScheduled) {
      state.outputScheduled = true;
      requestAnimationFrame(flushOutput);
    }
  };
  const onExit = new Channel<ExitPayload>();
  onExit.onmessage = () => {
    if (state.disposed) return;
    // Drain any pending output before the exit notice so the last bytes
    // the agent printed aren't reordered behind it.
    if (state.pendingOutput) flushOutput();
    term.writeln("\r\n\x1b[2;37m[process exited]\x1b[0m");
  };
  return { onOutput, onExit, flushOutput };
}

/// Pause/resume controller. Returned to the parent so the visibility
/// effect can flip live ↔ paused without re-running the spawn effect.
function wirePauseResume(
  term: Terminal,
  state: TermState,
  decoder: TextDecoder,
  armIdleTimer: (chunkBytes: number) => void,
): { setVisible: (v: boolean) => void } {
  return {
    setVisible: (v: boolean) => {
      if (v && state.mode === "paused") {
        state.mode = "resuming";
        // Hold the flag for the entire resume window. Cleared via a
        // term.write callback after the catch-up bytes have been
        // parsed, so any OSC completion signals embedded in them fire
        // while the flag is still true.
        state.replayingSnapshot = true;
        const token = state.pausedToken;
        const fenceReplayDone = () => {
          // Empty write acts as a parser-drain fence: the callback fires
          // after all preceding writes have been processed.
          term.write("", () => {
            state.replayingSnapshot = false;
          });
        };
        (async () => {
          if (!state.id) {
            state.mode = "live";
            state.replayingSnapshot = false;
            return;
          }
          try {
            const snap = await invoke<PaneSnapshot>("snapshot_pane_since", {
              id: state.id,
              sinceToken: token,
            });
            if (state.disposed) {
              state.replayingSnapshot = false;
              return;
            }
            if (state.mode !== "resuming") {
              // User flipped back to paused before we landed. Discard
              // the stale catch-up; next resume will fetch fresh bytes.
              state.resumingQueue.length = 0;
              state.replayingSnapshot = false;
              return;
            }
            const snapBytes = decodeBase64ToBytes(snap.data);
            const snapText = decoder.decode(snapBytes, { stream: true });
            if (snap.dropped) {
              // Backend ring rolled over while we were paused — there's
              // a gap between what xterm last rendered and the start of
              // this snapshot. Don't clear: that nukes everything the
              // user could still scroll back to from before the pause.
              // Instead, write a faint divider so the gap is visible.
              term.write(
                "\r\n\x1b[2;37m── earlier output truncated (backend buffer rolled over) ──\x1b[0m\r\n",
              );
            }
            if (snapText) term.write(snapText);
            // Drain anything that arrived during the await — those bytes
            // have backend tokens > snap.new_token, so writing them now
            // preserves order.
            for (const t of state.resumingQueue) term.write(t);
            state.resumingQueue.length = 0;
            fenceReplayDone();
            state.mode = "live";
          } catch (e) {
            logIpcError("snapshot_pane_since", e);
            if (state.mode === "resuming") {
              for (const t of state.resumingQueue) term.write(t);
              state.resumingQueue.length = 0;
              fenceReplayDone();
              state.mode = "live";
            } else {
              state.replayingSnapshot = false;
            }
          }
        })();
      } else if (!v && state.mode === "live") {
        // Flush any RAF-pending output to xterm before recording the
        // pause cursor, so the snapshot_since on resume doesn't
        // re-deliver bytes we've already shown.
        if (state.pendingOutput) {
          const text = state.pendingOutput;
          const bytes = state.pendingOutputBytes;
          state.pendingOutput = "";
          state.pendingOutputBytes = 0;
          term.write(text);
          armIdleTimer(bytes);
        }
        state.mode = "paused";
        (async () => {
          if (!state.id) {
            state.pausedToken = 0;
            return;
          }
          try {
            const token = await invoke<number>("pane_token", { id: state.id });
            if (state.disposed || state.mode !== "paused") return;
            state.pausedToken = token;
          } catch (e) {
            logIpcError("pane_token", e);
          }
        })();
      }
    },
  };
}

/// ResizeObserver + window resize + fonts.ready + DPR-change rebind.
/// All four trigger a debounced `fit()` call; the size cache below
/// elides no-op refits driven by unrelated layout shifts. Returns a
/// cleanup the unmount path calls.
function wireResizeAndFit(
  term: Terminal,
  fit: FitAddon,
  host: HTMLElement,
  state: TermState,
): () => void {
  let fitTimer: number | null = null;
  let lastFitWidth = 0;
  let lastFitHeight = 0;
  // Set by callers whose trigger isn't a size change — fonts loading
  // or DPR shifting can change the *char metrics* without changing the
  // host's box, and we still need to recompute cols/rows in those
  // cases. The size-cache below ignores its check when this is set.
  let forceNextFit = false;
  const scheduleFit = () => {
    if (fitTimer !== null) window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => {
      fitTimer = null;
      // Skip when the host has no box (parent is display:none) —
      // fit.fit() would compute zero dimensions and resize the PTY to
      // nothing.
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      // ResizeObserver fires for any layout-affecting change on the
      // box, including ones that don't change its size (e.g. an
      // ancestor toggling pointer-events). Skip the no-op cases so we
      // don't burn a fit() + refresh() per unrelated render — except
      // when an explicit force is set (fonts / DPR), where the box
      // didn't move but the char grid did.
      const wasForce = forceNextFit;
      forceNextFit = false;
      if (!wasForce && w === lastFitWidth && h === lastFitHeight) return;
      lastFitWidth = w;
      lastFitHeight = h;
      try {
        fit.fit();
        // Force a redraw too — xterm's renderer can desync after the
        // container was hidden (e.g. tab-switch).
        term.refresh(0, term.rows - 1);
      } catch (err) {
        // Most likely cause is the host detaching between the
        // scheduleFit() call and the timeout firing; log so a real
        // regression in xterm/fit-addon doesn't disappear.
        // eslint-disable-next-line no-console
        console.warn("[loom] fit.fit() failed", err);
      }
    }, 80);
  };
  const forceFit = () => {
    forceNextFit = true;
    scheduleFit();
  };
  const ro = new ResizeObserver(() => scheduleFit());
  ro.observe(host);
  // Catches OS-level window resizes (drag the window border) as a
  // belt-and-braces fallback alongside the ResizeObserver.
  window.addEventListener("resize", scheduleFit);

  // Web fonts (JetBrains Mono) arrive async. xterm computes char
  // metrics from the fallback font at mount time; once the real font
  // is available, glyph width may shift and the current cols/rows are
  // off by a column or two. Refit when fonts settle. Uses forceFit
  // because the host's pixel box didn't change — only the char grid
  // did, which the size-cache wouldn't otherwise detect.
  if (typeof document !== "undefined" && document.fonts?.ready) {
    document.fonts.ready
      .then(() => {
        if (!state.disposed) forceFit();
      })
      .catch(() => {
        // fonts.ready rejecting is essentially impossible per spec.
      });
  }

  // Monitor devicePixelRatio for changes (window dragged between
  // monitors with different scaling, OS zoom changes). matchMedia
  // queries are pinned to the current DPR value, so we re-bind after
  // each change to listen for the next one.
  let dprQuery: MediaQueryList | null = null;
  const onDprChange = () => {
    forceFit();
    if (dprQuery) dprQuery.removeEventListener("change", onDprChange);
    if (state.disposed) return;
    dprQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    dprQuery.addEventListener("change", onDprChange);
  };
  try {
    dprQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    dprQuery.addEventListener("change", onDprChange);
  } catch {
    // Older WebViews without `resolution` media feature support; skip.
    dprQuery = null;
  }

  return () => {
    ro.disconnect();
    window.removeEventListener("resize", scheduleFit);
    if (dprQuery) dprQuery.removeEventListener("change", onDprChange);
    if (fitTimer !== null) window.clearTimeout(fitTimer);
  };
}

// ─── Component ──────────────────────────────────────────────────────────

// Memoized so a sibling pane updating doesn't force every TerminalView
// (and therefore every xterm + PTY surface) to re-render. The
// component's props are mostly stable already: paneId / workspaceId /
// path / sessionAgent / sessionId are passed straight from the
// session shape and only mutate when their pane mutates; visible,
// focused, fontSize, idleQuietMs are primitives; onCompletion is the
// shared handlePaneCompletion identity.
export const TerminalView = memo(function TerminalView({
  paneId,
  workspaceId,
  path,
  command,
  cwd,
  env,
  sessionId,
  sessionAgent,
  focused,
  visible = true,
  fontSize,
  idleQuietMs,
  onCompletion,
}: Props) {
  // Splice the agent-specific resume flag here, at spawn time — not in
  // the persisted command — so a fresh capture after `/clear` isn't
  // pinned by an old string on disk.
  const effectiveCommand = resumeAwareCommand(command, sessionId, sessionAgent);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Set once the PTY is spawned; cleared on dispose. The drag-drop
  // effect reads this to write dropped file paths into the live PTY.
  const writeRef = useRef<((data: string) => void) | null>(null);
  const onCompletionRef = useRef(onCompletion);
  useEffect(() => {
    onCompletionRef.current = onCompletion;
  }, [onCompletion]);

  // Subscribe to live settings so a Settings-page edit propagates without
  // needing the parent to plumb props down.
  const settingsFontSize = useSetting("terminalFontSize");
  const settingsIdleQuiet = useSetting("idleQuietMs");
  const activeThemeId = useSetting("activeThemeId");
  // Subscribing to the themes registry means edits to the active custom
  // theme repaint the terminal without needing a remount.
  const themes = useThemes();
  const effectiveFontSize = fontSize ?? settingsFontSize;
  const effectiveIdleQuiet = idleQuietMs ?? settingsIdleQuiet;

  // Apply font-size changes after mount. Avoids re-creating the xterm
  // instance (which would lose scrollback) when the user tweaks the
  // setting from elsewhere in the app.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontSize === effectiveFontSize) return;
    term.options.fontSize = effectiveFontSize;
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [effectiveFontSize]);

  // Resolve the active theme from the reactive registry so an edit to
  // *this* theme's tokens flows through, but an edit to a different
  // custom theme leaves the object reference (and the dependent effect)
  // alone. Without the useMemo, depending on `themes` directly retriggered
  // the re-theme effect on every unrelated theme edit — wasted DOM work
  // across every mounted terminal.
  const activeTheme = useMemo(
    () =>
      themes.find((t) => t.id === activeThemeId) ??
      getThemeOrDefault(activeThemeId),
    [themes, activeThemeId],
  );

  // Hot-swap the xterm palette when the active theme (or the tokens of
  // the active custom theme) change. `term.options.theme = ...` is the
  // documented way to re-theme without recreating the terminal — keeps
  // scrollback and cursor position intact.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeFromTheme(activeTheme);
  }, [activeTheme]);

  const idleTimeoutMsRef = useRef<number>(effectiveIdleQuiet);
  useEffect(() => {
    idleTimeoutMsRef.current = effectiveIdleQuiet;
  }, [effectiveIdleQuiet]);

  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  // Pause/resume runs imperatively from inside the spawn effect — keep
  // the latest visibility in a ref so the dispatcher can read it
  // without re-running the spawn effect.
  const visibleRef = useRef(visible);
  const pauseControlsRef = useRef<{
    setVisible: (v: boolean) => void;
  } | null>(null);
  useEffect(() => {
    visibleRef.current = visible;
    pauseControlsRef.current?.setVisible(visible);
  }, [visible]);

  // PTY spawn + xterm lifecycle. Intentionally a mount-only effect:
  // every prop it reads (paneId, workspaceId, path, command, cwd, env,
  // theme tokens, font size) is either captured-at-spawn — respawning
  // the PTY mid-session would lose scrollback and the live shell — or
  // covered by a separate hot-swap effect above. React's `key` on the
  // pane wrapper drives the actual remount when the identity changes.
  //
  // The body composes five lifecycle helpers defined at module scope
  // above: webgl loading, completion signals, output channel,
  // pause/resume, and resize/fit. Each phase owns its own concern and
  // shares the mutable `state` bag so flags one phase flips (e.g.
  // `sawLoomStopEver`) are visible to the others.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — every captured prop is either spawn-time configuration that must not be re-applied or is covered by a separate hot-swap effect above
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const { term, fit } = acquireTerminal(
      {
        fontFamily:
          '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, Monaco, monospace',
        fontSize: effectiveFontSize,
        fontWeight: "500",
        fontWeightBold: "700",
        lineHeight: 1.15,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: "bar",
        cursorWidth: 2,
        allowProposedApi: true,
        allowTransparency: false,
        rescaleOverlappingGlyphs: true,
        // 5× the xterm.js default. Long agent conversations can easily
        // produce thousands of visual lines; the backend ring buffer is
        // the authoritative store for replay across pause/resume, but
        // xterm itself has to hold whatever the user might want to scroll
        // back through within a single live session.
        scrollback: 5000,
        theme: xtermThemeFromTheme(getThemeOrDefault(activeThemeId)),
      },
      host,
    );
    termRef.current = term;
    fitRef.current = fit;

    // Per-mount IDisposables — every `term.onX(...)` / OSC handler
    // registration goes in here so `releaseTerminal` can drop the lot
    // before the Terminal goes back to the pool. Missing one would mean
    // a stale closure firing on the NEXT pane that gets this instance.
    const mountDisposables: IDisposable[] = [];
    const state = makeTermState(visibleRef.current);
    const decoder = new TextDecoder("utf-8", { fatal: false });

    setupWebgl(term, state);
    const { armIdleTimer } = setupCompletionSignals(term, state, {
      paneId,
      onCompletionRef,
      idleTimeoutMsRef,
      mountDisposables,
    });
    const { onOutput, onExit } = wireOutputChannel(
      term,
      state,
      armIdleTimer,
      decoder,
    );
    pauseControlsRef.current = wirePauseResume(
      term,
      state,
      decoder,
      armIdleTimer,
    );
    const teardownResize = wireResizeAndFit(term, fit, host, state);

    requestAnimationFrame(() => fit.fit());

    (async () => {
      try {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;

        // Verify a captured Claude session id still points at a real
        // transcript before splicing `--resume <id>`. A SessionStart hook
        // can fire on a fresh `claude` invocation before the user has
        // committed any turn to disk — if they quit at that point, the
        // id we captured has no `.jsonl` behind it, and the next launch
        // would `claude --resume <bogus>` straight into a "No conversation
        // found" error. Fall back to the bare command so the pane is
        // usable. Codex / Gemini have their own storage layouts; for
        // safety we keep the splice for them and revisit if their
        // equivalent failure surfaces.
        let startupCommand = effectiveCommand;
        if (sessionId && sessionAgent === "claude" && effectiveCommand) {
          try {
            const exists = await invoke<boolean>("claude_session_file_exists", {
              cwd: cwd ?? path,
              sessionId,
            });
            if (!exists) {
              startupCommand = command;
            }
          } catch (e) {
            logIpcError("claude_session_file_exists", e);
          }
        }

        const newId = await invoke<string>("spawn_terminal", {
          paneId,
          workspaceId,
          path,
          command: startupCommand ?? null,
          cwd: cwd ?? null,
          env: env ?? null,
          cols,
          rows,
          onOutput,
          onExit,
        });
        if (state.disposed) {
          invoke("kill_terminal", { id: newId }).catch((e) =>
            logIpcError("kill_terminal", e),
          );
          return;
        }
        state.id = newId;

        // Send anything queued via term.onData. A single invoke per
        // frame is plenty even for fast typing or large pastes; without
        // this, every keystroke was its own IPC roundtrip.
        const writeData = (data: string) => {
          invoke("write_terminal", { id: state.id, data }).catch((e) =>
            logIpcError("write_terminal", e),
          );
        };
        writeRef.current = writeData;

        const startup = startupCommand?.trim();
        if (startup) {
          writeData(`${startup}\n`);
        }

        let pendingInput = "";
        let inputScheduled = false;
        const flushInput = () => {
          inputScheduled = false;
          if (!pendingInput || !state.id) return;
          const data = pendingInput;
          pendingInput = "";
          writeData(data);
        };
        mountDisposables.push(
          term.onData((data) => {
            if (!state.id) return;
            state.hasInputSinceSignal = true;
            pendingInput += data;
            if (!inputScheduled) {
              inputScheduled = true;
              requestAnimationFrame(flushInput);
            }
          }),
        );

        // xterm sends the same \r for Enter and Shift+Enter, so the PTY
        // (and CLIs like Claude Code) can't distinguish them. Translate
        // Shift+Enter to ESC+CR — the Alt/Option+Enter convention that
        // most line-editor TUIs accept as "insert a newline".
        term.attachCustomKeyEventHandler((event) => {
          if (
            event.type === "keydown" &&
            event.key === "Enter" &&
            event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            if (!state.id) return false;
            state.hasInputSinceSignal = true;
            pendingInput += "\x1b\r";
            if (!inputScheduled) {
              inputScheduled = true;
              requestAnimationFrame(flushInput);
            }
            return false;
          }
          return true;
        });

        // Backend resize is a syscall (TIOCSWINSZ) + lock acquisition;
        // skip the round-trip when nothing actually changed. xterm
        // already de-dupes within a single fit() call, but font-size
        // changes and reflows can replay the same cols/rows.
        let lastSentCols = -1;
        let lastSentRows = -1;
        mountDisposables.push(
          term.onResize(({ cols, rows }) => {
            if (!state.id) return;
            // Defensive: ignore degenerate sizes from a hidden /
            // unmounted host.
            if (cols < 1 || rows < 1) return;
            if (cols === lastSentCols && rows === lastSentRows) return;
            lastSentCols = cols;
            lastSentRows = rows;
            invoke("resize_terminal", { id: state.id, cols, rows }).catch((e) =>
              logIpcError("resize_terminal", e),
            );
          }),
        );
      } catch (err) {
        term.writeln(
          `\r\n\x1b[31mFailed to start terminal: ${String(err)}\x1b[0m`,
        );
      }
    })();

    return () => {
      state.disposed = true;
      writeRef.current = null;
      teardownResize();
      if (state.idleTimer !== null) window.clearTimeout(state.idleTimer);
      // Channels die with their JS owner — no explicit unsubscribe
      // needed. The backend reader thread will get an Err on next send
      // and exit.
      if (state.id) {
        invoke("kill_terminal", { id: state.id }).catch((e) =>
          logIpcError("kill_terminal", e),
        );
      }
      // Null the ref BEFORE dispose so any concurrent effect that races
      // the unmount (e.g. the focus effect firing under fast remounts)
      // sees a missing terminal instead of a half-disposed one.
      termRef.current = null;
      fitRef.current = null;
      // Drop every per-mount IDisposable up front and synchronously, so
      // a Terminal handed back to the pool can't fire stale onData /
      // onResize / OSC callbacks on the next pane that picks it up.
      // Cheap on its own (each is a list-removal in xterm internals);
      // the costly work — renderer teardown — is deferred below.
      for (const d of mountDisposables) {
        try {
          d.dispose();
        } catch {
          // ignore — a partially-installed listener (failed setup path)
          // is the only way this throws; don't strand siblings.
        }
      }
      mountDisposables.length = 0;
      // Defer the host-bound renderer teardown + pool handoff so a
      // close-workspace cascade doesn't block the click frame on N
      // synchronous addon disposes. The DOM host is removed by React as
      // part of this same commit, so the parked terminal is already
      // invisible — no user-facing artifacts from the delay.
      const deadTerm = term;
      const deadWebgl = state.webgl;
      const deadFit = fit;
      scheduleDispose(() => {
        // Addons are bound to the renderer that `term.open(host)`
        // created. They must go before we hand the Terminal back to the
        // pool — leaving them attached would carry the dead host into
        // the next mount that picks up this instance.
        try {
          deadWebgl?.dispose();
        } catch {
          // ignore
        }
        try {
          deadFit.dispose();
        } catch {
          // ignore
        }
        releaseTerminal(deadTerm);
      });
    };
  }, []);

  // Drag-and-drop file paths into the focused PTY. macOS Finder drags
  // populate `dataTransfer` with a `text/uri-list` value (`file://...`
  // URIs, newline-separated) — that's the only standards-track way to
  // recover the OS-level path from inside a webview, since
  // `dataTransfer.files` exposes File objects without absolute paths.
  //
  // Tauri's `dragDropEnabled` is off (workspace-tab reorder needs HTML5
  // events to fire normally), so we can't fall back to the
  // `webview.onDragDropEvent` path here. The window-level handler in
  // `App.tsx` preventDefaults dragover/drop on file drops to stop the
  // WebView's "open the file as a document" default — that
  // preventDefault on dragover is also what makes the per-element
  // `drop` below actually fire.
  const onHostDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    const write = writeRef.current;
    if (!write) return;
    const uriList = e.dataTransfer.getData("text/uri-list");
    if (!uriList) return;
    const paths: string[] = [];
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim();
      // text/uri-list spec: lines starting with `#` are comments.
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("file://")) continue;
      try {
        paths.push(decodeURIComponent(trimmed.slice("file://".length)));
      } catch {
        // Mal-encoded URI — skip rather than write garbage to the PTY.
      }
    }
    if (paths.length === 0) return;
    write(paths.map(shellQuotePath).join(" ") + " ");
    termRef.current?.focus();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: xterm's host must be a plain div; the onDrop just routes Finder file paths into the PTY, not a separate AT-targetable surface
    <div
      className="term-host h-full w-full bg-ink-0 px-3 py-2.5"
      ref={hostRef}
      onDrop={onHostDrop}
    />
  );
});

/// POSIX shell-quote: leave shell-safe characters bare, single-quote
/// the rest with the standard `'\''` escape for embedded single
/// quotes. Matches what macOS Terminal.app pastes when you drop a
/// file onto it, so the user can hit Enter without further editing.
function shellQuotePath(p: string): string {
  return /^[A-Za-z0-9_./@:+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}
