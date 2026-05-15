import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/// Top-level boundary so a crash inside any sidebar/panel prints a useful
/// recovery card instead of yielding a blank window. Logged to console
/// with the component stack so the failure can still be diagnosed.
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(
    error: Error,
    info: { componentStack?: string | null },
  ) {
    // eslint-disable-next-line no-console
    console.error("[loom] uncaught render error", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full w-full items-center justify-center bg-ink-0 px-10 py-12 text-paper"
      >
        <div className="w-full max-w-[560px] border border-coral/30 bg-coral/[0.04] px-6 py-6">
          <div className="mb-3 flex items-center gap-2 text-[10.5px] uppercase tracking-[0.18em] text-coral">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-coral" />
            crash · render
          </div>
          <h2 className="m-0 mb-2 font-sans text-[20px] font-medium tracking-[-0.012em] text-paper">
            Something broke while drawing the UI.
          </h2>
          <p className="m-0 mb-4 text-[12.5px] leading-[1.6] text-muted">
            The error is logged to the console. Click reload to continue —
            in-flight terminal output is preserved by the backend.
          </p>
          <pre className="mb-5 max-h-[240px] overflow-auto whitespace-pre-wrap border border-rule bg-ink-1/60 px-3 py-2.5 font-mono text-[11px] leading-[1.55] text-faint">
            {error.message || String(error)}
          </pre>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="cursor-pointer border border-amber/45 bg-amber/[0.06] px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-amber transition-colors duration-150 hover:bg-amber/15"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="cursor-pointer border border-rule bg-transparent px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted transition-colors duration-150 hover:border-paper hover:text-paper"
            >
              Reload window
            </button>
          </div>
        </div>
      </div>
    );
  }
}
