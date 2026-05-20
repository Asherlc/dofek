interface QueryStatePanelProps {
  error?: unknown;
  variant?: "loading" | "error" | "empty";
  message?: string;
  height?: number;
}

function getQueryErrorMessage(error: unknown, fallback = "Failed to load data."): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

export function QueryStatePanel({
  error,
  variant = error ? "error" : "empty",
  message,
  height = 180,
}: QueryStatePanelProps) {
  if (variant === "loading") {
    return (
      <div
        className="query-state-panel flex items-center justify-center"
        style={{ minHeight: height }}
        data-testid="query-state-loading"
        aria-busy="true"
      >
        <div className="w-5 h-5 border-2 border-border-strong border-t-muted rounded-full animate-spin" />
      </div>
    );
  }

  const resolvedMessage =
    message ?? (variant === "error" ? getQueryErrorMessage(error) : "No data yet.");

  return (
    <div
      className={variant === "error" ? "query-error-panel" : "query-state-panel"}
      style={{ minHeight: height }}
      data-testid={`query-state-${variant}`}
    >
      <p>{resolvedMessage}</p>
    </div>
  );
}
