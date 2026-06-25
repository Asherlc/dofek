const DATE_FILTER_COLUMNS = new Set(["date", "start_date", "end_date"]);

export type FilterInputType = "text" | "date" | "datetime-local";

export function isDateFilterColumn(column: string): boolean {
  return DATE_FILTER_COLUMNS.has(column);
}

export function isDateTimeFilterColumn(column: string): boolean {
  return column === "synced_at" || column === "syncedAt" || column.endsWith("_at");
}

export function isRangeFilterColumn(column: string): boolean {
  return isDateFilterColumn(column) || isDateTimeFilterColumn(column);
}

export function parseRangeFilterKey(key: string): { column: string; bound: "from" | "to" } | null {
  if (key.endsWith("_from")) {
    return { column: key.slice(0, -"_from".length), bound: "from" };
  }
  if (key.endsWith("_to")) {
    return { column: key.slice(0, -"_to".length), bound: "to" };
  }
  return null;
}

/** Resolve the HTML input type for a provider detail filter column. */
export function getFilterInputType(columnKey: string): FilterInputType {
  if (isDateFilterColumn(columnKey)) {
    return "date";
  }

  if (isDateTimeFilterColumn(columnKey)) {
    return "datetime-local";
  }

  return "text";
}
