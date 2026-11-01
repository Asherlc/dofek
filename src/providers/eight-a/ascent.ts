import { z } from "zod";
import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import { exportDate, exportGrades, nullableExportText } from "../../lib/climbing-file.ts";

export const eightACategories = ["bouldering", "sportclimbing", "gymroute", "gymboulder"] as const;
export type EightACategory = (typeof eightACategories)[number];
const sourceAscent = z
  .object({
    ascentId: z.union([z.number().int().nonnegative(), z.string().trim().min(1)]),
    platform: z.string().trim().min(1),
    date: z.string().nullable(),
    difficulty: z.string().nullable(),
    zlaggableName: z.string().nullable(),
    cragName: z.string().nullable().optional(),
    sectorName: z.string().nullable().optional(),
    areaName: z.string().nullable().optional(),
    countryName: z.string().nullable().optional(),
    type: z.string().nullable(),
    repeat: z.boolean(),
    project: z.boolean(),
    duplicate: z.boolean(),
    tries: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
    comment: z.string().nullable().optional(),
    rating: z.number().nullable().optional(),
    recommended: z.boolean().nullable().optional(),
  })
  .passthrough();
const pageSchema = z.object({
  ascents: z.array(sourceAscent),
  totalItems: z.number().int().nonnegative(),
  pageIndex: z.number().int().nonnegative(),
});

/** Shared app API ascents, verified 2026-11-01; retain unrecognized vendor facts in raw. */
export function parseEightAAscentPage(
  value: unknown,
  category: EightACategory,
  pageIndex: number,
): SourceClimbingLogEntry[] {
  const page = pageSchema.parse(value);
  if (page.pageIndex !== pageIndex)
    throw new Error("Vertical-Life returned an unexpected logbook page. Try syncing again.");
  return page.ascents.map((row) => {
    const boulder = category === "bouldering" || category === "gymboulder";
    const indoor = category === "gymroute" || category === "gymboulder";
    const attempt: SourceClimbingAttempt = { scope: "climb" };
    const result = row.type?.toLowerCase();
    if (result === "f" || result === "os" || result === "rp") {
      attempt.sourceResult = row.type;
      attempt.qualifier =
        result === "f" ? "free-flash" : result === "os" ? "free-onsight" : "free-send";
    } else if (result === "tr") {
      attempt.sourceResult = row.type;
      attempt.ropeMethod = "top_rope";
    }
    const names = [row.countryName, row.areaName, row.cragName, row.sectorName]
      .map((name) => nullableExportText(name ?? undefined))
      .filter((name): name is string => name !== null && name !== "Unknown Sector");
    return {
      externalId: `eight-a:native:${category}:${encodeURIComponent(row.platform)}:${encodeURIComponent(String(row.ascentId))}`,
      climbedOn: exportDate(row.date ?? undefined, "Vertical-Life"),
      discipline: "rock_climbing",
      reportedGrades: exportGrades(
        row.difficulty ?? undefined,
        indoor ? null : boulder ? "font" : "french",
      ),
      ...(row.tries != null && row.tries > 0
        ? { reportedAttemptCounts: [{ scope: "climb" as const, count: row.tries }] }
        : {}),
      attempts: [attempt],
      notes: nullableExportText(row.comment ?? undefined),
      climb: {
        externalId: null,
        name: nullableExportText(row.zlaggableName ?? undefined),
        kind: boulder ? "boulder" : "route",
        setting: indoor ? "indoor" : "outdoor",
        ...(names.length ? { areas: names.map((name) => ({ name, externalId: null })) } : {}),
      },
      sourceName: "8a.nu / Vertical-Life",
      raw: z.json().parse(row),
    };
  });
}
