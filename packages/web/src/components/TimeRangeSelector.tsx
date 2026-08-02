import { useId } from "react";
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
  const groupName = `time-range-${useId()}`;

  return (
    <div className="flex flex-col items-end gap-1">
      <fieldset
        className="flex shrink-0 gap-0.5 sm:gap-1 bg-surface-solid rounded-lg p-1 border border-border"
        aria-label="Time range"
      >
        {TIME_RANGE_OPTIONS.map((range) => {
          const selected = days === range.days;
          return (
            <label
              key={range.label}
              className={`cursor-pointer rounded-md px-2 py-1.5 text-xs transition-colors sm:px-3 ${
                selected ? "bg-accent/15 text-foreground" : "text-subtle hover:text-foreground"
              } focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent`}
            >
              <input
                type="radio"
                name={groupName}
                value={range.days ?? "all"}
                checked={selected}
                className="sr-only"
                onChange={() => onChange(range.days)}
              />
              {range.label}
            </label>
          );
        })}
      </fieldset>
      <p className="max-w-sm text-right text-xs text-muted">{description}</p>
    </div>
  );
}
