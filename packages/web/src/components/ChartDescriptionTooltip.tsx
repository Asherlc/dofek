interface ChartDescriptionTooltipProps {
  description: string;
  className?: string;
}

export function ChartDescriptionTooltip({ description, className }: ChartDescriptionTooltipProps) {
  return (
    <span className={`relative inline-flex group ${className ?? ""}`}>
      <span
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border-strong text-[10px] font-semibold text-subtle cursor-help"
        aria-describedby={undefined}
      >
        i
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 bottom-full mb-2 -translate-x-1/2 rounded-md bg-surface-solid border border-border-strong px-3 py-2 text-xs text-foreground opacity-0 transition-opacity group-hover:opacity-100 whitespace-normal max-w-xs z-50 shadow-lg"
      >
        {description}
        <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-border-strong" />
      </span>
    </span>
  );
}
