import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import {
  exportCount,
  exportDate,
  exportGrades,
  fileOccurrenceId,
  nullableExportText,
  readClimbingCsv,
} from "../../lib/climbing-file.ts";

const header = [
  "route_boulder",
  "name",
  "location_name",
  "sector_name",
  "area_name",
  "country_code",
  "date",
  "type",
  "sub_type",
  "rating",
  "project",
  "tries",
  "repeats",
  "difficulty",
  "perceived_hardness",
  "comment",
  "height",
  "recommended",
  "sits",
];

/** Native ascent CSV: https://www.8a.nu/faq and its 19-column export contract. */
export function parseEightAExport(csvText: string): SourceClimbingLogEntry[] {
  const counts = new Map<string, number>();
  return readClimbingCsv(csvText, header, "8a.nu CSV").map((row) => {
    const kind =
      row.route_boulder === "BOULDER" ? "boulder" : row.route_boulder === "ROUTE" ? "route" : null;
    const system = kind === "boulder" ? "font" : kind === "route" ? "french" : null;
    const tries = exportCount(row.tries, "8a.nu tries");
    const label = nullableExportText(row.type)?.toLowerCase();
    const attempt: SourceClimbingAttempt = { scope: "climb" };
    if (label === "f" || label === "os" || label === "rp") {
      attempt.sourceResult = row.type;
      attempt.qualifier =
        label === "f" ? "free-flash" : label === "os" ? "free-onsight" : "free-send";
    } else if (label === "tr") {
      attempt.sourceResult = row.type;
      attempt.ropeMethod = "top_rope";
    }
    const areas = [row.country_code, row.area_name, row.location_name, row.sector_name]
      .map(nullableExportText)
      .filter((name): name is string => name !== null && name !== "Unknown Sector");
    return {
      externalId: fileOccurrenceId("eight-a", row, counts),
      climbedOn: exportDate(row.date, "8a.nu"),
      discipline: kind === null ? null : "rock_climbing",
      reportedGrades: exportGrades(row.difficulty, system),
      ...(tries !== null && tries > 0
        ? { reportedAttemptCounts: [{ scope: "climb", count: tries }] }
        : {}),
      attempts: [attempt],
      notes: nullableExportText(row.comment),
      climb: {
        externalId: null,
        name: nullableExportText(row.name),
        kind,
        setting: null,
        ...(areas.length ? { areas: areas.map((name) => ({ name, externalId: null })) } : {}),
      },
      sourceName: "8a.nu / Vertical-Life",
      raw: row,
    };
  });
}
