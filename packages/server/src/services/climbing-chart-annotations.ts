import type { ClimbingChartAnnotation } from "@dofek/training/climbing-chart";
import { climbingLogEntryName } from "@dofek/training/climbing-log";
import { z } from "zod";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";

const kayaTimingSchema = z.object({ date: z.string().trim() });
const preciseInstantSchema = z.iso.datetime({ offset: true });
const exportedInstantPattern =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-](?:[01]\d|2[0-3])[0-5]\d(?: \([^)]*\))?$/;

/** Only ascent-owned instants qualify, never session starts or ingestion times. */
export function climbingChartAnnotations(log: ClimbingLogEntryDetail): ClimbingChartAnnotation[] {
  const isAscent = log.providerId === "kaya" && log.externalId?.startsWith("kaya:ascent:");
  const isExport = log.providerId === "kaya-export" && log.externalId?.startsWith("kaya:entry:");
  if (!isAscent && !isExport) return [];
  const timing = kayaTimingSchema.safeParse(log.raw);
  if (!timing.success) return [];
  const date = timing.data.date;
  if (
    !preciseInstantSchema.safeParse(date).success &&
    !(isExport && exportedInstantPattern.test(date))
  )
    return [];
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return [];
  const name = climbingLogEntryName(log);
  return [
    {
      id: log.id,
      label: log.displayGrade ? `${name} · ${log.displayGrade}` : name,
      startedAt: new Date(timestamp).toISOString(),
      endedAt: null,
    },
  ];
}
