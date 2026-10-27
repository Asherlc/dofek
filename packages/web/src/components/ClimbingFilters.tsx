import {
  type ClimbingFilterKey,
  climbingContextPreset,
  climbingContextPresets,
  climbingFilterKeys,
  climbingFilterLabels,
  climbingFilterOptions,
  climbingFiltersSchema,
  type ClimbingFilters as Filters,
  selectClimbingContext,
} from "@dofek/training/climbing-filters";
import { useId, useState } from "react";

export function ClimbingFilters({
  value,
  onChange,
}: {
  value: Filters;
  onChange: (value: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const preset = climbingContextPreset(value);
  const advancedKeys = climbingFilterKeys.filter((key) => key !== "setting");
  const chipKeys = advancedKeys.filter(
    (key) => preset === null || (key !== "climbKind" && key !== "ropeMethod"),
  );
  function remove(key: ClimbingFilterKey) {
    const next = { ...value };
    delete next[key];
    onChange(next);
  }
  return (
    <div className="space-y-4">
      <fieldset className="flex flex-wrap gap-4 border-b border-border" aria-label="Climbing type">
        {climbingContextPresets.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={preset === item.value}
            onClick={() => onChange(selectClimbingContext(value, item.value))}
            className={`min-h-11 border-b-2 px-1 pb-2 text-sm font-medium ${preset === item.value ? "border-accent text-accent" : "border-transparent text-muted"}`}
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      {preset === null ? <p className="text-xs text-muted">Custom climbing selection</p> : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <fieldset aria-label="Setting">
          <legend className="mb-2 text-xs text-muted">Setting</legend>
          <div className="flex flex-wrap gap-1">
            {[
              { value: undefined, label: "All settings" },
              ...climbingFilterOptions.setting.map(([option, label]) => ({ value: option, label })),
            ].map((item) => (
              <button
                key={item.value ?? "all"}
                type="button"
                aria-pressed={value.setting === item.value}
                onClick={() =>
                  item.value === undefined
                    ? remove("setting")
                    : onChange({ ...value, setting: item.value })
                }
                className={`min-h-11 rounded-lg px-3 py-2 text-sm ${value.setting === item.value ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-hover"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex gap-2">
          <button
            type="button"
            className="min-h-11 rounded-lg border border-border px-3 text-sm"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
          >
            More filters
          </button>
          {Object.keys(value).length ? (
            <button
              type="button"
              className="min-h-11 px-3 text-sm text-accent"
              onClick={() => onChange({})}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>
      {chipKeys.some((key) => value[key] !== undefined) ? (
        <div className="flex flex-wrap gap-2">
          {chipKeys.map((key) => {
            const label = climbingFilterOptions[key].find(([option]) => option === value[key])?.[1];
            return label ? (
              <button
                key={key}
                type="button"
                aria-label={`Remove ${climbingFilterLabels[key]}: ${label} filter`}
                className="min-h-11 rounded-full bg-surface-hover px-3 text-xs"
                onClick={() => remove(key)}
              >
                {climbingFilterLabels[key]}: {label} <span aria-hidden="true">×</span>
              </button>
            ) : null;
          })}
        </div>
      ) : null}
      {open ? (
        <div id={id} className="flex flex-wrap gap-4 border-t border-border pt-4">
          {advancedKeys.map((key) => (
            <label key={key} className="flex flex-col gap-1 text-xs text-muted">
              {climbingFilterLabels[key]}
              <select
                className="min-h-11 rounded border border-border bg-surface px-2 text-base text-foreground"
                value={value[key] === undefined ? "" : String(value[key])}
                onChange={(event) => {
                  const next = { ...value };
                  delete next[key];
                  const selected = climbingFilterOptions[key].find(
                    ([option]) => String(option) === event.target.value,
                  );
                  onChange(
                    climbingFiltersSchema.parse(selected ? { ...next, [key]: selected[0] } : next),
                  );
                }}
              >
                <option value="">All</option>
                {climbingFilterOptions[key].map(([option, label]) => (
                  <option key={String(option)} value={String(option)}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
