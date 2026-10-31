import { createHash } from "node:crypto";
import { type GradeSystem, isValidClimbingGrade } from "@dofek/training/climbing-grades";
import type { GradeComponent } from "@dofek/training/climbing-log";
import { z } from "zod";
import { ClimbingImportValidationError } from "./climbing-import-error.ts";
import { decodeCsv } from "./csv.ts";

export function readClimbingCsv(
  text: string,
  requiredHeaders: readonly string[],
  format: string,
): Record<string, string>[] {
  const decoded = decodeCsv(text);
  if (!decoded.ok) throw new ClimbingImportValidationError(`${format}: ${decoded.message}`);
  const [header, ...rows] = decoded.rows;
  if (
    !header ||
    new Set(header.fields).size !== header.fields.length ||
    !requiredHeaders.every((key) => header.fields.includes(key))
  ) {
    throw new ClimbingImportValidationError(
      `${format} header does not match the documented export format`,
    );
  }
  return rows.map(({ fields, rowNumber }) => {
    if (fields.length !== header.fields.length)
      throw new ClimbingImportValidationError(`${format} row ${rowNumber}: malformed CSV row`);
    return Object.fromEntries(header.fields.map((key, index) => [key, fields[index] ?? ""]));
  });
}

export function nullableExportText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return !trimmed || trimmed === "null" ? null : trimmed;
}

export function exportDate(value: string | undefined, format: string): string | null {
  const text = nullableExportText(value);
  if (text === null) return null;
  const date = text.slice(0, 10);
  if (
    !z.iso.date().safeParse(date).success ||
    (text !== date && !z.iso.datetime({ offset: true }).safeParse(text).success)
  )
    throw new ClimbingImportValidationError(`${format}: invalid source date`);
  return date;
}

export function exportNumber(value: string | undefined, field: string): number | null {
  const text = nullableExportText(value);
  if (text === null) return null;
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(Number(text)))
    throw new ClimbingImportValidationError(`${field} must be a finite number`);
  return Number(text);
}

export function exportCount(value: string | undefined, field: string): number | null {
  const number = exportNumber(value, field);
  if (number !== null && (!Number.isInteger(number) || number < 0 || number > 2_147_483_647))
    throw new ClimbingImportValidationError(`${field} must be a nonnegative integer`);
  return number;
}

export function exportBoolean(value: string | undefined, field: string): boolean | null {
  const text = nullableExportText(value)?.toLowerCase();
  if (text == null) return null;
  if (text !== "true" && text !== "false")
    throw new ClimbingImportValidationError(`${field} must be true or false`);
  return text === "true";
}

export function exportGrades(
  value: string | undefined,
  system: GradeSystem | null,
): GradeComponent[] {
  const text = nullableExportText(value);
  return text === null
    ? []
    : [
        {
          value: text,
          system: system !== null && isValidClimbingGrade(text, system) ? system : null,
        },
      ];
}

export function fileOccurrenceId(
  provider: string,
  row: Record<string, string>,
  counts: Map<string, number>,
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify(Object.entries(row).sort(([first], [second]) => first.localeCompare(second))),
    )
    .digest("hex");
  const occurrence = (counts.get(hash) ?? 0) + 1;
  counts.set(hash, occurrence);
  return `${provider}:${hash}:${occurrence}`;
}
