import { formatActivityTypeLabel } from "@dofek/training/training";

export type FilterOption = { value: string; label: string };

export type FilterInputType = "text" | "date" | "datetime-local";

const DATE_FILTER_COLUMNS = new Set(["date", "start_date", "end_date"]);

/** Resolve the HTML input type for a provider detail filter column. */
export function getFilterInputType(columnKey: string): FilterInputType {
  if (DATE_FILTER_COLUMNS.has(columnKey)) {
    return "date";
  }

  if (columnKey === "syncedAt" || columnKey.endsWith("_at")) {
    return "datetime-local";
  }

  return "text";
}

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
  if (columnKey === "activity_type") {
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
