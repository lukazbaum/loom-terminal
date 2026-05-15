import {
  useClaudeRateLimits,
  type RateLimitWindow,
} from "./useClaudeRateLimits";
import { useSetting } from "./settings";

/// Two compact pills (5h / 7d) showing % of the user's Claude.ai
/// subscription rate-limit window consumed. Rendered in the top-left of
/// the header. Hidden entirely until the backend has any data — API-key
/// users never see it.
export function RateLimitBadge() {
  const enabled = useSetting("showClaudeUsage");
  const rl = useClaudeRateLimits();
  if (!enabled) return null;
  if (!rl) return null;
  const five = rl.five_hour;
  const seven = rl.seven_day;
  if (!five && !seven) return null;

  return (
    // Left padding clears the macOS traffic-light buttons (close /
    // minimize / zoom). Tauri's `titleBarStyle: "Overlay"` keeps them
    // floating on top of our custom title bar at the standard ~70 px
    // offset; an 80 px gutter leaves a small breathing strip.
    <div
      className="flex shrink-0 items-center gap-1 pl-[80px]"
      data-tauri-drag-region="false"
    >
      {five && <Pill label="5h" window={five} updatedAt={rl.updated_at} />}
      {seven && <Pill label="7d" window={seven} updatedAt={rl.updated_at} />}
    </div>
  );
}

function Pill({
  label,
  window: w,
  updatedAt,
}: {
  label: string;
  window: RateLimitWindow;
  updatedAt: number;
}) {
  const pct = Math.max(0, Math.min(100, w.used_percentage));
  const tone = pctTone(pct);
  // Tone classes are explicit string literals so Tailwind's JIT can see
  // them at build time — interpolated class names get pruned. Coral is
  // the theme's danger color; using it here means custom themes can
  // recolor "you're nearly out" without forking a separate red token.
  const colorText =
    tone === "danger"
      ? "text-coral"
      : tone === "warn"
        ? "text-amber"
        : "text-mint";
  const colorBar =
    tone === "danger" ? "bg-coral" : tone === "warn" ? "bg-amber" : "bg-mint";

  // Prefer the label string from `/usage` ("9:30pm (Europe/Berlin)")
  // over the epoch-derived countdown — the label is what Claude
  // itself shows users, so it matches their expectations exactly.
  const resetsText = w.resets_label
    ? `resets ${w.resets_label}`
    : w.resets_at
      ? `resets in ${formatResetsIn(w.resets_at)}`
      : null;
  const updatedAgo = formatAgo(updatedAt);
  const tooltip = [
    `${label} window — ${pct.toFixed(0)}% used`,
    resetsText,
    `updated ${updatedAgo}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      title={tooltip}
      className="group/rl flex h-[20px] items-center gap-1.5 border border-rule/60 bg-ink-2/40 px-1.5 font-mono text-[10px] tabular-nums tracking-[-0.005em] hover:border-rule"
    >
      <span className="text-faint uppercase">{label}</span>
      <span className={`${colorText} font-medium`}>{pct.toFixed(0)}%</span>
      <span
        aria-hidden
        className="relative block h-[3px] w-8 overflow-hidden bg-ink-3/70"
      >
        <span
          className={`absolute left-0 top-0 h-full ${colorBar}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

function pctTone(pct: number): "ok" | "warn" | "danger" {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "ok";
}

/// "2h 14m" / "47m" / "30s". `resets_at` is unix epoch seconds. Returns
/// null when the reset has already passed (we still show the pill — the
/// percentage is the authoritative value; the timer will refresh on the
/// next Claude turn).
function formatResetsIn(resetsAt: number): string | null {
  const now = Math.floor(Date.now() / 1000);
  const delta = resetsAt - now;
  if (delta <= 0) return null;
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${delta}s`;
}

function formatAgo(unixSecs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - unixSecs);
  if (delta < 60) return `${delta}s ago`;
  const m = Math.floor(delta / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
