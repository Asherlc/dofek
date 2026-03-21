const TIME_RANGES = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: 3650 },
] as const;

export function TimeRangeSelector({
  days,
  onChange,
}: {
  days: number;
  onChange: (days: number) => void;
}) {
  return (
    <fieldset
      className="flex shrink-0 gap-0.5 sm:gap-1 bg-surface-solid rounded-lg p-1 border border-border"
      aria-label="Time range"
    >
      {TIME_RANGES.map((r) => (
        <button
          key={r.label}
          type="button"
          onClick={() => onChange(r.days)}
          className={`px-2 sm:px-3 py-1.5 text-xs rounded-md transition-colors ${
            days === r.days ? "bg-accent/15 text-foreground" : "text-subtle hover:text-foreground"
          }`}
        >
          {r.label}
        </button>
      ))}
    </fieldset>
  );
}
