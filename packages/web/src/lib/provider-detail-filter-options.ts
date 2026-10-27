import { type FilterInputType, getFilterInputType } from "@dofek/filter-columns";
import { formatActivityTypeLabel } from "@dofek/training/training";

export type { FilterInputType };
export { getFilterInputType };

export type FilterOption = { value: string; label: string };

export function isRangeFilterInputType(
  inputType: FilterInputType,
): inputType is "date" | "datetime-local" {
  return inputType === "date" || inputType === "datetime-local";
}

export function filterRangeBoundKey(columnKey: string, bound: "from" | "to"): string {
  return `${columnKey}_${bound}`;
}

function snakeToLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatFilterOptionLabel(columnKey: string, value: string): string {
  if (columnKey === "canonical_type") {
    return formatActivityTypeLabel(value);
  }
  return snakeToLabel(value);
}

export function toFilterOptions(
  columnKey: string,
  options: ReadonlyArray<{ value: string; label?: string }> | undefined,
): readonly FilterOption[] | undefined {
  if (!options) return undefined;
  return options.map((option) => ({
    value: option.value,
    label: option.label ?? formatFilterOptionLabel(columnKey, option.value),
  }));
}
