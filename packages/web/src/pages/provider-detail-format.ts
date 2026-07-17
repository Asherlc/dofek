import { formatTableCellValue } from "@dofek/format/format";

export function formatColumnName(column: string): string {
  return column.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatCellValue(value: unknown): string {
  return formatTableCellValue(value);
}
