import { TIME_RANGE_OPTIONS, type TimeRangeDays } from "../lib/timeRange.ts";

export function TimeRangeSelector({
  days,
  description,
  onChange,
}: {
  days: TimeRangeDays;
  description: string;
  onChange: (days: TimeRangeDays) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <fieldset
        className="flex shrink-0 gap-0.5 sm:gap-1 bg-surface-solid rounded-lg p-1 border border-border"
        aria-label="Time range"
      >
        {TIME_RANGE_OPTIONS.map((range) => (
          <button
            key={range.label}
            type="button"
            onClick={() => onChange(range.days)}
            className={`px-2 sm:px-3 py-1.5 text-xs rounded-md transition-colors ${
              days === range.days
                ? "bg-accent/15 text-foreground"
                : "text-subtle hover:text-foreground"
            }`}
          >
            {range.label}
          </button>
        ))}
      </fieldset>
      <p className="max-w-sm text-right text-xs text-muted">{description}</p>
    </div>
  );
}
