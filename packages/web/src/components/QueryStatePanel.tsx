import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

export type QueryStateVariant = "loading" | "error" | "empty";

interface QueryStatePanelProps {
  variant: QueryStateVariant;
  message: string;
  title?: string;
  height?: number;
}

export function getQueryErrorMessage(
  error: unknown,
  fallback = "Could not load this section.",
): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

export function QueryStatePanel({ variant, message, title, height = 180 }: QueryStatePanelProps) {
  if (variant === "loading") {
    return <ChartLoadingSkeleton height={height} />;
  }

  const resolvedTitle =
    title ?? (variant === "error" ? "Could not load this section" : "No data yet");
  const toneClasses =
    variant === "error"
      ? "border-red-900/60 bg-red-950/20 text-red-200"
      : "border-border bg-surface-solid text-subtle";

  return (
    <div
      data-testid={`query-state-${variant}`}
      className={`flex flex-col items-center justify-center gap-2 rounded-xl border px-4 py-5 text-center ${toneClasses}`}
      style={{ minHeight: height }}
    >
      <p className="text-sm font-semibold text-foreground">{resolvedTitle}</p>
      <p className="max-w-md text-sm">{message}</p>
    </div>
  );
}
