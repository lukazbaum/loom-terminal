/// Subscribe to a Tauri event and clean up on unmount.
///
/// Replaces the hand-rolled `let cancelled = false; let unlisten = null;`
/// pattern that appears in five places — easy to get subtly wrong
/// (unhandled promise rejection, listener firing during the
/// listen() → .then(unlisten) gap, stale-deps refire).
///
/// The handler is captured in a ref so the listener doesn't have to
/// re-register every render. Deps default to `[]` (mount once).

import { useEffect, useRef } from "react";
import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";

export function useTauriEvent<T>(
  event: string,
  handler: EventCallback<T>,
  deps: React.DependencyList = [],
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    listen<T>(event, (e) => {
      if (cancelled) return;
      handlerRef.current(e);
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[loom] failed to subscribe to ${event}`, err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps]);
}
