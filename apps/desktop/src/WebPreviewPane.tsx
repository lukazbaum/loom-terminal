import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  paneId: string;
  url: string;
  focused?: boolean;
};

type Viewport = "full" | "desktop" | "tablet" | "mobile";

const VIEWPORT_WIDTHS: Record<Viewport, number | null> = {
  full: null,
  desktop: 1280,
  tablet: 768,
  mobile: 375,
};

const VIEWPORT_LABELS: Record<Viewport, string> = {
  full: "fit",
  desktop: "1280",
  tablet: "768",
  mobile: "375",
};

/// Cap on the back/forward history stack. Long-running preview panes
/// (or programmatic SPAs that swap routes rapidly) would otherwise grow
/// the array without bound across a workspace session, and the resulting
/// stack is persisted to localStorage on every workspace save.
const HISTORY_CAP = 50;

/// Iframe-based preview of a localhost dev server. Modeled on VSCode's
/// Simple Browser. Cross-origin iframes are opaque so back/forward use
/// our own history stack and reload via a cache-buster query param.
export function WebPreviewPane({ paneId: _paneId, url: initialUrl }: Props) {
  const [history, setHistory] = useState<string[]>([initialUrl]);
  const [idx, setIdx] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(Date.now());
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [viewport, setViewport] = useState<Viewport>("full");
  const [isLoading, setIsLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // history is seeded with initialUrl and only appended to (or replaced
  // via setHistory), and idx is always clamped to within bounds, so
  // `current` is never actually undefined — but `noUncheckedIndexedAccess`
  // wants us to prove it. Fall back to initialUrl if it ever did happen.
  const current = history[idx] ?? initialUrl;

  // `reloadNonce` is in the dep list on purpose — the reload button
  // bumps it without changing `current`, and we want the loading
  // indicator + input reset to re-fire when that happens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is an intentional retrigger signal
  useEffect(() => {
    setUrlInput(current);
    setIsLoading(true);
  }, [current, reloadNonce]);

  // Defense-in-depth scheme gate on whatever lands in the iframe `src`.
  // `onSubmitUrl` already prefixes `http://` for naked hostnames, but
  // `current` can also flow from `initialUrl` (persisted from a prior
  // session) and the back/forward history, neither of which goes
  // through that path. A `javascript:` or `data:` URL would otherwise
  // execute inside the iframe's sandbox — bounded by the sandbox
  // attrs above, but still a code-smell CodeQL flags as XSS.
  const cacheBustedSrc = (() => {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return "about:blank";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "about:blank";
    }
    const sep = current.includes("?") ? "&" : "?";
    return `${current}${sep}_loomReload=${reloadNonce}`;
  })();

  const navigate = (newUrl: string) => {
    if (newUrl === current) {
      setReloadNonce(Date.now());
      return;
    }
    // Truncate any "forward" history before pushing, then enforce the cap
    // so a long-lived preview pane doesn't accumulate hundreds of URLs
    // (each of which lands in localStorage on the next workspace save).
    // The new active position is always one past the current one, clamped
    // to the cap; the history updater drops oldest entries from the head
    // to match, preserving the user's "current" pointer.
    setHistory((h) => {
      const appended = [...h.slice(0, idx + 1), newUrl];
      return appended.length <= HISTORY_CAP
        ? appended
        : appended.slice(appended.length - HISTORY_CAP);
    });
    setIdx((i) => Math.min(i + 1, HISTORY_CAP - 1));
  };

  const onSubmitUrl = () => {
    let u = urlInput.trim();
    if (!u) return;
    if (!/^https?:\/\//.test(u)) u = `http://${u}`;
    navigate(u);
  };

  const back = () => {
    if (idx > 0) setIdx(idx - 1);
  };
  const forward = () => {
    if (idx < history.length - 1) setIdx(idx + 1);
  };
  const reload = () => setReloadNonce(Date.now());
  const openExternal = () => {
    invoke("plugin:opener|open_url", { url: current }).catch(() => {});
  };

  const viewportWidth = VIEWPORT_WIDTHS[viewport];
  const canBack = idx > 0;
  const canForward = idx < history.length - 1;

  return (
    <div className="flex h-full flex-col bg-ink-0">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-rule bg-ink-1/80 px-2 py-1.5">
        <button
          type="button"
          onClick={back}
          disabled={!canBack}
          title="Back"
          className="cursor-pointer rounded-sm px-1.5 py-0.5 font-mono text-[12px] text-faint transition-colors duration-100 hover:bg-ink-2 hover:text-paper disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-faint"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={forward}
          disabled={!canForward}
          title="Forward"
          className="cursor-pointer rounded-sm px-1.5 py-0.5 font-mono text-[12px] text-faint transition-colors duration-100 hover:bg-ink-2 hover:text-paper disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-faint"
        >
          ›
        </button>
        <button
          type="button"
          onClick={reload}
          title="Reload"
          className="cursor-pointer rounded-sm px-1.5 py-0.5 font-mono text-[11px] text-faint transition-colors duration-100 hover:bg-ink-2 hover:text-paper"
        >
          ↻
        </button>
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmitUrl();
          }}
          className="min-w-0 flex-1 rounded-sm bg-ink-2 px-2 py-1 font-mono text-[11px] text-paper outline-none transition-colors duration-150 focus:bg-ink-3"
          spellCheck={false}
        />
        <div className="ml-1 flex shrink-0 items-center gap-0.5">
          {(["full", "desktop", "tablet", "mobile"] as Viewport[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setViewport(v)}
              title={`Viewport ${VIEWPORT_LABELS[v]}`}
              className={`cursor-pointer rounded-sm px-1.5 py-0.5 font-sans text-[10px] transition-colors duration-100 ${
                viewport === v
                  ? "bg-ink-3 text-paper"
                  : "text-faint hover:bg-ink-2 hover:text-paper"
              }`}
            >
              {VIEWPORT_LABELS[v]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={openExternal}
          title="Open in default browser"
          className="cursor-pointer rounded-sm px-1.5 py-0.5 font-mono text-[11px] text-faint transition-colors duration-100 hover:bg-ink-2 hover:text-paper"
        >
          ↗
        </button>
      </div>
      {/* Iframe area */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        <div
          className={`flex h-full ${
            viewportWidth ? "justify-center bg-ink-1" : ""
          }`}
        >
          {/*
           * sandbox + referrerPolicy harden the framed dev server: CSP
           * only restricts which hosts can be framed, not what those hosts
           * can do once framed. Without sandbox, a malicious localhost
           * server can navigate the top window, request native permission
           * prompts, etc. Omitting `allow-top-navigation` blocks the
           * frame-bust path; `allow-same-origin` keeps cookies/localStorage
           * working for legitimate dev workflows.
           */}
          <iframe
            ref={iframeRef}
            src={cacheBustedSrc}
            sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
            referrerPolicy="no-referrer"
            allow=""
            onLoad={() => setIsLoading(false)}
            style={{
              width: viewportWidth ? `${viewportWidth}px` : "100%",
              height: "100%",
              border: 0,
              background: "white",
              maxWidth: "100%",
            }}
            title="Preview"
          />
        </div>
        {isLoading && (
          <div className="pointer-events-none absolute left-2 top-2 rounded-sm bg-ink-1/85 px-2 py-0.5 font-mono text-[10px] text-faint">
            loading…
          </div>
        )}
      </div>
    </div>
  );
}
