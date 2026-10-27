export function MapProcessingIndicator({
  compact = false,
  label = "Processing map…",
}: {
  compact?: boolean;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center gap-2 rounded-[inherit] bg-surface-secondary text-xs text-muted"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-muted motion-reduce:animate-none"
      />
      <span className={compact ? "sr-only" : undefined}>{label}</span>
    </div>
  );
}
