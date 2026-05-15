import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/// Thin construct/dispose wrapper around `Terminal`. A previous iteration
/// of this module parked Terminal instances and reused their DOM subtree
/// on the next mount to skip xterm's ~10–30 ms `term.open(host)` cost.
/// That backfired: xterm v6's renderer is bound to the original host's
/// measurements at `term.open()` time, and the reuse path had no way to
/// re-initialise it. `term.reset()` clears the buffer but not the
/// renderer's `_screenElement` inline sizing or its `.xterm-rows`
/// child-element count. After re-parenting `term.element` into a new
/// host of a different size, the renderer kept rendering into the stale
/// row container — the visible content landed in the bottom slots of an
/// oversized grid, pushing the shell prompt below the viewport. Always
/// constructing fresh costs the open-time hit but keeps the renderer
/// state consistent with the live host.
export function acquireTerminal(
  opts: ITerminalOptions,
  host: HTMLElement,
): { term: Terminal; fit: FitAddon } {
  const term = new Terminal(opts);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  return { term, fit };
}

export function releaseTerminal(term: Terminal): void {
  term.dispose();
}
