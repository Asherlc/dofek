interface ChartDescriptionTooltipProps {
  description: string;
  className?: string;
}

export function ChartDescriptionTooltip({ description, className }: ChartDescriptionTooltipProps) {
  return (
    <span
      title={description}
      className={`inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-700 text-[10px] font-semibold text-zinc-500 cursor-help ${className ?? ""}`}
    >
      i
    </span>
  );
}
