import { useDebouncedValue } from "../hooks/useDebouncedValue";
import {
  type FilterInputType,
  type FilterOption,
  filterRangeBoundKey,
  getFilterInputType,
  isRangeFilterInputType,
} from "../lib/provider-detail-filter-options.ts";
import { DateRangeFilterField } from "./DateRangeFilterField.tsx";

export function useDebouncedFilters(filters: Record<string, string>, delayMs = 300) {
  return useDebouncedValue(filters, delayMs);
}

export function pruneEmptyFilters(filters: Record<string, string>): Record<string, string> {
  const pruned: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value.trim()) pruned[key] = value.trim();
  }
  return pruned;
}

const FILTER_CONTROL_CLASS =
  "w-full px-2 py-1.5 text-xs bg-accent/10 border border-border rounded text-foreground placeholder:text-dim focus:outline-none focus:border-border-strong";

function FilterField({
  column,
  filters,
  options,
  inputType = "text",
  onFilterChange,
  align = "left",
  className = FILTER_CONTROL_CLASS,
}: {
  column: { key: string; label: string };
  filters: Record<string, string>;
  options?: readonly FilterOption[];
  inputType?: FilterInputType;
  onFilterChange: (key: string, value: string) => void;
  align?: "left" | "right";
  className?: string;
}) {
  if (options && options.length > 0) {
    return (
      <select
        value={filters[column.key] ?? ""}
        onChange={(event) => onFilterChange(column.key, event.target.value)}
        aria-label={`Filter ${column.label}`}
        className={`${className} ${align === "right" ? "text-right" : "text-left"}`}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (isRangeFilterInputType(inputType)) {
    return (
      <DateRangeFilterField
        column={column}
        inputType={inputType}
        fromValue={filters[filterRangeBoundKey(column.key, "from")] ?? ""}
        toValue={filters[filterRangeBoundKey(column.key, "to")] ?? ""}
        onFromChange={(value) => onFilterChange(filterRangeBoundKey(column.key, "from"), value)}
        onToChange={(value) => onFilterChange(filterRangeBoundKey(column.key, "to"), value)}
        className={className}
      />
    );
  }

  return (
    <input
      type="text"
      value={filters[column.key] ?? ""}
      onChange={(event) => onFilterChange(column.key, event.target.value)}
      placeholder={`Filter ${column.label}`}
      aria-label={`Filter ${column.label}`}
      className={`${className} ${align === "right" ? "text-right" : "text-left"}`}
    />
  );
}

export function RecordFiltersGrid({
  columns,
  filters,
  onFilterChange,
  getOptions,
}: {
  columns: ReadonlyArray<{ key: string; label: string }>;
  filters: Record<string, string>;
  onFilterChange: (key: string, value: string) => void;
  getOptions?: (columnKey: string) => readonly FilterOption[] | undefined;
}) {
  if (columns.length === 0) return null;

  return (
    <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {columns.map((column) => (
        <div key={column.key} className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-subtle">
            {column.label}
          </span>
          <FilterField
            column={column}
            filters={filters}
            options={getOptions?.(column.key)}
            inputType={getFilterInputType(column.key)}
            onFilterChange={onFilterChange}
          />
        </div>
      ))}
    </div>
  );
}
