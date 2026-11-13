import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import {
  exportBoolean,
  exportCount,
  exportDate,
  exportGrades,
  exportNumber,
  fileOccurrenceId,
  nullableExportText,
  readClimbingCsv,
} from "../../lib/climbing-file.ts";
import { ClimbingImportValidationError } from "../../lib/climbing-import-error.ts";

const header = [
  "board",
  "angle",
  "climb_name",
  "date",
  "logged_grade",
  "displayed_grade",
  "is_benchmark",
  "tries",
  "is_mirror",
  "sessions_count",
  "tries_total",
  "is_repeat",
  "is_ascent",
  "comment",
];

/** Historical BoardLib CSV, not the current MoonBoard application's private API. */
export function parseMoonBoardExport(csvText: string): SourceClimbingLogEntry[] {
  const counts = new Map<string, number>();
  return readClimbingCsv(csvText, header, "MoonBoard BoardLib CSV").map((row) => {
    if (!/^moon(?:2016|2017|2019|2020|2024)$/.test(row.board ?? ""))
      throw new ClimbingImportValidationError(
        "BoardLib CSV must contain a supported MoonBoard setup",
      );
    const angle = exportNumber(row.angle, "MoonBoard angle");
    if (angle !== null && (angle < -90 || angle > 90))
      throw new ClimbingImportValidationError("MoonBoard angle must be between -90 and 90 degrees");
    const triesText = nullableExportText(row.tries);
    const tries =
      triesText === "4+" || triesText === "project"
        ? null
        : exportCount(triesText ?? undefined, "MoonBoard tries");
    const completed = exportBoolean(row.is_ascent, "MoonBoard is_ascent");
    const repeat = exportBoolean(row.is_repeat, "MoonBoard is_repeat");
    exportBoolean(row.is_benchmark, "MoonBoard is_benchmark");
    exportBoolean(row.is_mirror, "MoonBoard is_mirror");
    const attempt: SourceClimbingAttempt = {
      scope: "climb",
      ...(completed === null ? {} : { sourceCompleted: completed }),
      ...(repeat === null ? {} : { hadCompletedBefore: repeat }),
    };
    const gradeSystem = /^V\d/i.test(row.logged_grade ?? row.displayed_grade ?? "")
      ? "v_scale"
      : "font";
    return {
      externalId: fileOccurrenceId("moonboard", row, counts),
      climbedOn: exportDate(row.date, "MoonBoard"),
      discipline: "rock_climbing",
      board: { name: `MoonBoard ${(row.board ?? "").slice(4)}`, externalId: row.board ?? null },
      ...(angle === null ? {} : { wallAngle: { value: angle, unit: "degrees" } }),
      reportedGrades: exportGrades(row.logged_grade, gradeSystem),
      ...(tries !== null && tries > 0
        ? { reportedAttemptCounts: [{ scope: "climb", count: tries }] }
        : {}),
      attempts: [attempt],
      notes: nullableExportText(row.comment),
      climb: {
        externalId: null,
        name: nullableExportText(row.climb_name),
        kind: "boulder",
        setting: "indoor",
        publishedGrades: exportGrades(row.displayed_grade, gradeSystem),
      },
      sourceName: "MoonBoard (BoardLib export)",
      raw: row,
    };
  });
}
