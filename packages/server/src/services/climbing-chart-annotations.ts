import type { ClimbingChartAnnotation } from "@dofek/training/climbing-chart";
import { climbingLogEntryName } from "@dofek/training/climbing-log";
import { z } from "zod";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";

const kayaTimingSchema = z.object({ date: z.iso.datetime({ offset: true }) });

/** Only ascent-owned instants qualify, never session starts or ingestion times. */
export function climbingChartAnnotations(log: ClimbingLogEntryDetail): ClimbingChartAnnotation[] {
  const isAscent = log.providerId === "kaya" && log.externalId?.startsWith("kaya:ascent:");
  const isExport = log.providerId === "kaya-export" && log.externalId?.startsWith("kaya:entry:");
  if (!isAscent && !isExport) return [];
  const timing = kayaTimingSchema.safeParse(log.raw);
  if (!timing.success) return [];
  const name = climbingLogEntryName(log);
  return [
    {
      id: log.id,
      label: log.displayGrade ? `${name} · ${log.displayGrade}` : name,
      startedAt: new Date(timing.data.date).toISOString(),
      endedAt: null,
    },
  ];
}
