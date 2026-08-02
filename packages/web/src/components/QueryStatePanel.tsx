import { operationalStatusColors } from "@dofek/scoring/colors";
import type { ReactNode } from "react";

interface QueryStatePanelProps {
  contextLabel?: string;
  error?: unknown;
  variant?: "loading" | "error" | "empty";
  title?: string;
  message?: ReactNode;
  height?: number;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
}

export function getQueryErrorMessage(error: unknown, fallback = "Failed to load data."): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

export function QueryStatePanel({
  contextLabel,
  error,
  variant = error ? "error" : "empty",
  title,
  message,
  height = 180,
  onRetry,
  retryLabel = "Retry",
  retrying = false,
}: QueryStatePanelProps) {
  if (variant === "loading") {
    const loadingMessage =
      typeof message === "string"
        ? message
        : contextLabel
          ? `Loading ${contextLabel.toLowerCase()}.`
          : "Loading data.";

    return (
      <output
        className="query-state-panel flex items-center justify-center"
        style={{ minHeight: height }}
        data-testid="query-state-loading"
        aria-label={loadingMessage}
        aria-live="polite"
        aria-busy="true"
      >
        <span
          aria-hidden="true"
          className="w-5 h-5 border-2 border-border-strong border-t-muted rounded-full animate-spin"
        />
        <span className="sr-only">{loadingMessage}</span>
      </output>
    );
  }

  const resolvedMessage =
    message ?? (variant === "error" ? getQueryErrorMessage(error) : "No data yet.");
  const errorTone = operationalStatusColors.danger;

  return (
    <div
      className={variant === "error" ? "query-error-panel" : "query-state-panel"}
      style={{
        minHeight: height,
        ...(variant === "error"
          ? {
              backgroundColor: errorTone.surface,
              borderColor: errorTone.border,
              color: errorTone.foreground,
            }
          : {}),
      }}
      data-testid={`query-state-${variant}`}
      role={variant === "error" ? "alert" : undefined}
    >
      {variant === "error" ? (
        <>
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded-full border text-sm font-bold"
            data-testid="query-state-error-icon"
            style={{ borderColor: errorTone.border, color: errorTone.foreground }}
          >
            !
          </span>
          <h2 className="text-sm font-semibold" style={{ color: errorTone.foreground }}>
            {title ??
              (contextLabel
                ? `${contextLabel}: Could not load this section`
                : "Could not load this section")}
          </h2>
        </>
      ) : null}
      <p style={variant === "error" ? { color: errorTone.foreground } : undefined}>
        {resolvedMessage}
      </p>
      {onRetry ? (
        <button
          type="button"
          disabled={retrying}
          onClick={onRetry}
          className="mt-3 text-xs px-3 py-1.5 rounded bg-accent/10 border border-border-strong text-foreground disabled:text-dim disabled:cursor-not-allowed"
          style={
            variant === "error"
              ? {
                  backgroundColor: errorTone.surface,
                  borderColor: errorTone.border,
                  color: errorTone.foreground,
                }
              : undefined
          }
        >
          {retrying ? "Retrying..." : retryLabel}
        </button>
      ) : null}
    </div>
  );
}
