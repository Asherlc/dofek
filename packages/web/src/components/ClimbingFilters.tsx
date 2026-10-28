import {
  type ClimbingFilterKey,
  climbingAdvancedFilterKeys,
  climbingFilterLabels,
  climbingFilterOptions,
  climbingFilterSelection,
  climbingFilterSummary,
  climbingTypeOptions,
  type ClimbingFilters as Filters,
  toggleClimbingFilter,
  toggleClimbingSetting,
  toggleClimbingType,
} from "@dofek/training/climbing-filters";
import * as Popover from "@radix-ui/react-popover";
import { useId, useState } from "react";

export function ClimbingFilters({
  value,
  onChange,
}: {
  value: Filters;
  onChange: (value: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const id = useId();
  const advancedKeys = climbingAdvancedFilterKeys;
  function remove(key: ClimbingFilterKey) {
    const next = { ...value };
    delete next[key];
    onChange(next);
  }
  function checkboxes(
    label: string,
    options: ReadonlyArray<readonly [string | boolean | null, string]>,
    selected: ReadonlyArray<string | boolean | null>,
    toggle: (option: string | boolean | null) => void,
  ) {
    const all = selected.length === options.length;
    return (
      <fieldset aria-label={label}>
        <legend className="mb-2 text-xs font-medium text-muted">{label}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {(
            [
              [
                "all",
                label === "Type" ? "All climbing" : label === "Setting" ? "All settings" : "All",
              ],
              ...options,
            ] satisfies ReadonlyArray<readonly [string | boolean | null, string]>
          ).map(([option, text]) => (
            <label
              key={String(option)}
              className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={option === "all" ? all : selected.includes(option)}
                ref={
                  option === "all"
                    ? (input) => {
                        if (input) input.indeterminate = !all && selected.length > 0;
                      }
                    : undefined
                }
                onChange={() => {
                  toggle(option);
                }}
              />
              {text}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground">{climbingFilterSummary(value)}</p>
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="min-h-11 rounded-lg border border-border px-4 text-sm text-foreground"
            >
              Filters{" "}
              <span aria-hidden="true" className="ml-3">
                ⌄
              </span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              aria-label="Climbing filters"
              align="end"
              sideOffset={8}
              collisionPadding={16}
              className="z-50 max-h-[min(80vh,var(--radix-popover-content-available-height))] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto space-y-4 rounded-xl border border-border bg-surface-solid p-5 text-foreground shadow-xl"
            >
              {checkboxes(
                "Type",
                climbingTypeOptions,
                value.types ?? climbingTypeOptions.map(([option]) => option),
                (option) => {
                  const type = climbingTypeOptions.find(([item]) => item === option)?.[0];
                  if (option === "all" || type) onChange(toggleClimbingType(value, type ?? "all"));
                },
              )}
              <div className="border-t border-border" />
              {checkboxes(
                "Setting",
                climbingFilterOptions.setting,
                value.setting ?? climbingFilterOptions.setting.map(([option]) => option),
                (option) => {
                  const setting = climbingFilterOptions.setting.find(
                    ([item]) => item === option,
                  )?.[0];
                  if (option === "all" || setting)
                    onChange(toggleClimbingSetting(value, setting ?? "all"));
                },
              )}
              <button
                type="button"
                className="min-h-11 text-sm text-muted"
                aria-expanded={advanced}
                aria-controls={id}
                onClick={() => setAdvanced(!advanced)}
              >
                More filters
              </button>
              {advanced ? (
                <div id={id} className="flex flex-wrap gap-4 border-t border-border pt-4">
                  {advancedKeys.map((key) => (
                    <div key={key} className="w-full">
                      {checkboxes(
                        climbingFilterLabels[key],
                        climbingFilterOptions[key],
                        climbingFilterSelection(value, key),
                        (option) => onChange(toggleClimbingFilter(value, key, option)),
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <button
                  type="button"
                  className="min-h-11 text-sm text-accent"
                  onClick={() => onChange({})}
                >
                  Clear filters
                </button>
                <Popover.Close asChild>
                  <button
                    type="button"
                    className="min-h-11 rounded-lg bg-accent px-5 text-sm text-white"
                  >
                    Done
                  </button>
                </Popover.Close>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {advancedKeys.some((key) => value[key] !== undefined) ? (
        <div className="flex flex-wrap gap-2">
          {advancedKeys.map((key) => {
            const label =
              value[key]
                ?.map(
                  (selected) =>
                    climbingFilterOptions[key].find(([option]) => option === selected)?.[1],
                )
                .join(" + ") || (value[key]?.length === 0 ? "None" : undefined);
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
    </div>
  );
}
