import { formatTableCellValue } from "@dofek/format/format";

export function formatColumnName(column: string): string {
  return column.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatCellValue(value: unknown): string {
  return formatTableCellValue(value);
}

export function recordAccessibilityLabel(
  row: Record<string, unknown>,
  visibleColumns: string[],
  fallbackIndex: number,
): string {
  const identifyingValue = [row.name, row.id, ...visibleColumns.map((column) => row[column])].find(
    (value) => value !== null && value !== undefined && String(value).trim().length > 0,
  );
  return `Open record ${formatCellValue(identifyingValue ?? fallbackIndex)}`;
}
