import { z } from "zod";
import type { RangeDays } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { JournalEntryDetail } from "../repositories/journal-repository.ts";

const providerProvenanceSchema = z.object({
  providerId: z.string(),
  label: z.string(),
});

export const journalTrendPointSchema = z.object({
  date: dateStringSchema,
  value: z.number().nullable(),
  source: providerProvenanceSchema.nullable(),
});

export const journalTrendSeriesSchema = z.object({
  questionSlug: z.string(),
  displayName: z.string(),
  dataType: z.enum(["boolean", "numeric"]),
  unit: z.string().nullable(),
  observationCount: z.number().int().nonnegative(),
  observedDayCount: z.number().int().nonnegative(),
  missingDayCount: z.number().int().nonnegative(),
  statement: z.string(),
  points: z.array(journalTrendPointSchema),
});

export const journalTrendEvidenceSchema = z.object({
  window: z.object({
    startDate: dateStringSchema,
    endDate: dateStringSchema,
    dayCount: z.number().int().positive(),
    gapRepresentation: z.enum(["explicit_daily", "count_only"]),
  }),
  statement: z.string(),
  uncertainty: z.object({
    status: z.literal("unavailable"),
    statement: z.string(),
  }),
  series: z.array(journalTrendSeriesSchema),
});

export type JournalTrendEvidence = z.infer<typeof journalTrendEvidenceSchema>;

interface BuildJournalTrendEvidenceInput {
  days: RangeDays;
  endDate: string;
  entries: JournalEntryDetail[];
}

interface SeriesAccumulator {
  questionSlug: string;
  displayName: string;
  dataType: "boolean" | "numeric";
  unit: string | null;
  observationsByDate: Map<
    string,
    Array<{
      value: number;
      source: JournalEntryDetail["source"];
    }>
  >;
}

const UNCERTAINTY = {
  status: "unavailable" as const,
  statement: "Uncertainty interval: not available for raw journal observations.",
};

export function buildJournalTrendEvidence(
  input: BuildJournalTrendEvidenceInput,
): JournalTrendEvidence {
  const chartableEntries = input.entries.filter(
    (
      entry,
    ): entry is JournalEntryDetail & {
      answer_numeric: number;
      data_type: "boolean" | "numeric";
    } =>
      entry.answer_numeric !== null &&
      (entry.data_type === "boolean" || entry.data_type === "numeric"),
  );
  const startDate =
    input.days === null
      ? (chartableEntries
          .map((entry) => entry.date)
          .sort((left, right) => left.localeCompare(right))[0] ?? input.endDate)
      : addDays(input.endDate, -(input.days - 1));
  const gapRepresentation = input.days === null ? "count_only" : "explicit_daily";
  const dayCount = inclusiveDayCount(startDate, input.endDate);
  const dates = input.days === null ? null : inclusiveDates(startDate, input.endDate);
  const accumulators = new Map<string, SeriesAccumulator>();

  for (const entry of chartableEntries) {
    const accumulator = accumulators.get(entry.question_slug) ?? {
      questionSlug: entry.question_slug,
      displayName: entry.display_name,
      dataType: entry.data_type,
      unit: entry.unit,
      observationsByDate: new Map(),
    };
    const observations = accumulator.observationsByDate.get(entry.date) ?? [];
    observations.push({ value: entry.answer_numeric, source: entry.source });
    accumulator.observationsByDate.set(entry.date, observations);
    accumulators.set(entry.question_slug, accumulator);
  }

  const series = [...accumulators.values()]
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .map((accumulator) => {
      const points: JournalTrendEvidence["series"][number]["points"] = [];
      if (dates === null) {
        for (const [date, observations] of [...accumulator.observationsByDate.entries()].sort(
          ([left], [right]) => left.localeCompare(right),
        )) {
          points.push(
            ...observations
              .sort((left, right) => left.source.providerId.localeCompare(right.source.providerId))
              .map((observation) => ({ date, ...observation })),
          );
        }
      } else {
        for (const date of dates) {
          const observations = accumulator.observationsByDate.get(date);
          if (!observations) {
            points.push({ date, value: null, source: null });
            continue;
          }
          points.push(
            ...observations
              .sort((left, right) => left.source.providerId.localeCompare(right.source.providerId))
              .map((observation) => ({ date, ...observation })),
          );
        }
      }
      const observationCount = [...accumulator.observationsByDate.values()].reduce(
        (total, observations) => total + observations.length,
        0,
      );
      const observedDayCount = accumulator.observationsByDate.size;
      const missingDayCount = dayCount - observedDayCount;
      return {
        questionSlug: accumulator.questionSlug,
        displayName: accumulator.displayName,
        dataType: accumulator.dataType,
        unit: accumulator.unit,
        observationCount,
        observedDayCount,
        missingDayCount,
        statement: `${countLabel(observationCount, "exact observation")} across ${observedDayCount} of ${countLabel(dayCount, "day")}; ${countLabel(missingDayCount, "day")} ${missingDayCount === 1 ? "has" : "have"} no recorded value.`,
        points,
      };
    });

  if (series.length === 0) {
    return {
      window: { startDate, endDate: input.endDate, dayCount, gapRepresentation },
      statement: "No numeric or Yes/No journal observations in this window.",
      uncertainty: UNCERTAINTY,
      series,
    };
  }

  const observedDates = new Set(chartableEntries.map((entry) => entry.date));
  return {
    window: { startDate, endDate: input.endDate, dayCount, gapRepresentation },
    statement:
      gapRepresentation === "explicit_daily"
        ? `${countLabel(chartableEntries.length, "exact observation")} across ${observedDates.size} of ${countLabel(dayCount, "day")}. Missing days indicate no journal value was recorded.`
        : `${countLabel(chartableEntries.length, "exact observation")} across ${observedDates.size} of ${countLabel(dayCount, "day")}. Missing days are summarized by count for the all-history window.`,
    uncertainty: UNCERTAINTY,
    series,
  };
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function inclusiveDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function inclusiveDayCount(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
