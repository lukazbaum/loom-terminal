import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTauriEvent } from "./useTauriEvent";

export type RateLimitWindow = {
  used_percentage: number;
  /// Human-readable reset string from claude's `/usage` modal
  /// (e.g. `"9:30pm (Europe/Berlin)"`). Preferred over `resets_at`
  /// when both are present.
  resets_label: string | null;
  resets_at: number | null;
};

export type RateLimits = {
  five_hour: RateLimitWindow | null;
  seven_day: RateLimitWindow | null;
  updated_at: number;
};

const EVENT_RATE_LIMITS_CHANGED = "loom-rate-limits-changed";

/// Subscribes to the global Claude.ai subscription rate-limit cache
/// maintained by the Rust backend. Fed by two sources (stream-json
/// `rate_limit_event` lines and the statusline OSC marker) — both
/// dedupe through the same Tauri event.
///
/// Returns `null` until the first snapshot is available. Subscription
/// users will normally have at least the disk-persisted last-known
/// value after the first `claude` turn ever ran on this machine.
export function useClaudeRateLimits(): RateLimits | null {
  const [data, setData] = useState<RateLimits | null>(null);

  // Initial fetch of the disk-persisted snapshot. The event subscription
  // below keeps it live as new pollings arrive.
  useEffect(() => {
    let cancelled = false;
    void invoke<RateLimits | null>("rate_limits_get").then((next) => {
      if (!cancelled) setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useTauriEvent<RateLimits>(EVENT_RATE_LIMITS_CHANGED, (event) => {
    setData(event.payload);
  });

  return data;
}
