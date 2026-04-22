/**
 * ErrorBoundary — catches render-time exceptions so a single broken
 * component (e.g. ProspectGrid choking on an unexpected result shape)
 * doesn't unmount the whole app and expose the body background.
 *
 * React doesn't expose error boundaries via hooks — has to be a class.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional custom fallback. Defaults to a small recoverable card. */
  fallback?: (err: Error, reset: () => void) => ReactNode;
}

interface State {
  err: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  override componentDidCatch(err: Error, info: ErrorInfo) {
    // Non-fatal — surface to console so it shows up during local dev and in
    // sourcemap-mapped production logs.
    console.error("[ErrorBoundary] render crashed:", err, info.componentStack);
  }

  reset = () => this.setState({ err: null });

  override render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    if (this.props.fallback) return this.props.fallback(err, this.reset);
    return (
      <div
        style={{
          minHeight: "100vh",
          padding: 32,
          background: "var(--bg-0, #f5f3ef)",
          color: "var(--text, #1a1730)",
          fontFamily: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            maxWidth: 520,
            padding: "24px 28px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.5)",
            border: "1px solid rgba(20,14,40,0.08)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Something rendered wrong.</div>
          <div style={{ fontSize: 12.5, color: "var(--text-dim, #5e5878)", marginBottom: 14, lineHeight: 1.55 }}>
            The page hit an unexpected error. Your data is safe — try again, or reload the page if it keeps happening.
          </div>
          <pre
            style={{
              fontFamily: "'Geist Mono', monospace",
              fontSize: 11,
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(20,14,40,0.04)",
              color: "var(--text-dim, #5e5878)",
              whiteSpace: "pre-wrap",
              maxHeight: 160,
              overflow: "auto",
              marginBottom: 14,
            }}
          >
            {err.message}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={this.reset}
              style={{
                padding: "7px 14px",
                borderRadius: 8,
                border: "1px solid rgba(20,14,40,0.12)",
                background: "var(--accent, #466e3a)",
                color: "white",
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "7px 14px",
                borderRadius: 8,
                border: "1px solid rgba(20,14,40,0.12)",
                background: "transparent",
                color: "var(--text, #1a1730)",
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
