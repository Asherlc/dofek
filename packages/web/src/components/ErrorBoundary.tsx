import { operationalStatusColors } from "@dofek/scoring/colors";
import { Component, type ReactNode } from "react";
import { captureException } from "../lib/telemetry.ts";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  /** Called when the user clicks "Try again" — use to reset external state (e.g., React Query cache). */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    captureException(error, {
      "react.component_stack": errorInfo.componentStack ?? "",
    });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorTone = operationalStatusColors.danger;

      return (
        <div
          className="flex min-h-[200px] flex-col items-center justify-center rounded-xl border p-6"
          role="alert"
          style={{
            backgroundColor: errorTone.surface,
            borderColor: errorTone.border,
            color: errorTone.foreground,
          }}
        >
          <span
            aria-hidden="true"
            className="mb-2 flex h-7 w-7 items-center justify-center rounded-full border text-sm font-bold"
            data-testid="error-boundary-icon"
            style={{ borderColor: errorTone.border, color: errorTone.foreground }}
          >
            !
          </span>
          <h2 className="mb-2 text-sm font-semibold" style={{ color: errorTone.foreground }}>
            Something went wrong
          </h2>
          <p className="mb-4 max-w-md text-center text-xs" style={{ color: errorTone.foreground }}>
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={() => {
              this.props.onReset?.();
              this.setState({ hasError: false, error: null });
            }}
            className="rounded-md border px-3 py-1.5 text-xs font-medium transition-[filter,outline] hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
              backgroundColor: errorTone.surface,
              borderColor: errorTone.border,
              color: errorTone.foreground,
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
