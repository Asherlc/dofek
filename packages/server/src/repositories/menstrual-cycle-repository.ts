import { type CyclePhase, computePhase, PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

const MINIMUM_COMPLETED_CYCLES = 3;
const MINIMUM_REGULAR_CYCLE_DAYS = 21;
const MAXIMUM_REGULAR_CYCLE_DAYS = 35;
const MAXIMUM_REGULAR_VARIATION_DAYS = 9;

const cycleEventRowSchema = z.object({
  local_date: dateStringSchema,
  provider_id: z.string(),
  source_name: z.string().nullable(),
  source_bundle: z.string().nullable(),
});

export interface CycleSource {
  providerId: string;
  sourceName: string | null;
  sourceBundle: string | null;
}

export interface CycleStart {
  id: string;
  startDate: string;
  sources: CycleSource[];
}

export type CycleEstimateStatus =
  | "no-history"
  | "sparse-history"
  | "irregular-history"
  | "conflicting-history"
  | "stale-history"
  | "estimated";

export interface CycleEstimateAvailability {
  status: CycleEstimateStatus;
  label: string;
}

export interface CyclePhaseEstimate {
  basis: "personal-cycle-average";
  completedCycleCount: number;
  observedCycleLengthRange: {
    minimumDays: number;
    maximumDays: number;
  };
  phaseLabel: string;
  cycleDayLabel: string;
  dayBasisLabel: string;
  methodLabel: string;
  uncertaintyLabel: string;
  limitationLabel: string;
}

export interface CurrentPhaseResult {
  phase: CyclePhase | null;
  dayOfCycle: number | null;
  cycleLength: number | null;
  estimate: CyclePhaseEstimate | null;
  latestCycleStart: CycleStart | null;
  availability: CycleEstimateAvailability;
}

function calendarDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const value = (type: Intl.DateTimeFormatPartTypes) => values.get(type);
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function shiftCalendarDate(date: string, amount: number, unit: "day" | "month"): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  if (unit === "day") {
    shifted.setUTCDate(shifted.getUTCDate() + amount);
  } else {
    const targetMonth = shifted.getUTCFullYear() * 12 + shifted.getUTCMonth() + amount;
    const targetYear = Math.floor(targetMonth / 12);
    const monthIndex = ((targetMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, monthIndex + 1, 0)).getUTCDate();
    shifted.setUTCFullYear(targetYear, monthIndex, Math.min(shifted.getUTCDate(), lastDay));
  }
  return shifted.toISOString().slice(0, 10);
}

function daysBetween(earlier: string, later: string): number {
  return (
    (Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000
  );
}

function sourceKey(source: CycleSource): string {
  return JSON.stringify([source.providerId, source.sourceBundle, source.sourceName]);
}

function compareSources(left: CycleSource, right: CycleSource): number {
  return (
    left.providerId.localeCompare(right.providerId) ||
    (left.sourceBundle ?? "").localeCompare(right.sourceBundle ?? "") ||
    (left.sourceName ?? "").localeCompare(right.sourceName ?? "")
  );
}

function groupCycleStarts(rows: z.infer<typeof cycleEventRowSchema>[]): CycleStart[] {
  const grouped = new Map<string, Map<string, CycleSource>>();
  for (const row of rows) {
    const source: CycleSource = {
      providerId: row.provider_id,
      sourceName: row.source_name,
      sourceBundle: row.source_bundle,
    };
    const sources = grouped.get(row.local_date) ?? new Map<string, CycleSource>();
    sources.set(sourceKey(source), source);
    grouped.set(row.local_date, sources);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([startDate, sources]) => ({
      id: `cycle-start:${startDate}`,
      startDate,
      sources: [...sources.values()].sort(compareSources),
    }));
}

function unavailable(
  status: Exclude<CycleEstimateStatus, "estimated">,
  label: string,
  latestCycleStart: CycleStart | null,
  cycleLength: number | null = null,
): CurrentPhaseResult {
  return {
    phase: null,
    dayOfCycle: null,
    cycleLength,
    estimate: null,
    latestCycleStart,
    availability: { status, label },
  };
}

function buildEstimate(input: {
  phase: CyclePhase;
  dayOfCycle: number;
  cycleLength: number;
  intervals: number[];
}): CyclePhaseEstimate {
  const minimumDays = Math.min(...input.intervals);
  const maximumDays = Math.max(...input.intervals);
  const completedCycleCount = input.intervals.length;
  return {
    basis: "personal-cycle-average",
    completedCycleCount,
    observedCycleLengthRange: { minimumDays, maximumDays },
    phaseLabel: `Estimated ${PHASE_DISPLAY[input.phase].label} phase`,
    cycleDayLabel: `Day ${input.dayOfCycle} of an estimated ${input.cycleLength}-day cycle`,
    dayBasisLabel: "Cycle day is counted from the latest provider cycle-start record.",
    methodLabel: `Phase and cycle length use the average of ${completedCycleCount} completed cycles from provider records.`,
    uncertaintyLabel:
      minimumDays === maximumDays
        ? `All ${completedCycleCount} recorded cycles were ${minimumDays} days long.`
        : `Recorded cycle lengths ranged from ${minimumDays} to ${maximumDays} days.`,
    limitationLabel: "No calibrated confidence score or next-period forecast is available.",
  };
}

export class MenstrualCycleRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async #cycleStarts(rangeStart: string, rangeEnd: string): Promise<CycleStart[]> {
    const rows = await executeWithSchema(
      this.#db,
      cycleEventRowSchema,
      sql`SELECT
            (start_date AT TIME ZONE ${this.#timezone})::date AS local_date,
            provider_id,
            source_name,
            source_bundle
          FROM fitness.health_event
          WHERE user_id = ${this.#userId}
            AND type = 'HKCategoryTypeIdentifierMenstrualFlow'
            AND metadata ->> 'HKMetadataKeyMenstrualCycleStart' = 'true'
            AND (start_date AT TIME ZONE ${this.#timezone})::date >= ${rangeStart}::date
            AND (start_date AT TIME ZONE ${this.#timezone})::date < ${rangeEnd}::date
          ORDER BY local_date ASC, provider_id ASC, source_bundle ASC NULLS FIRST,
                   source_name ASC NULLS FIRST`,
    );
    return groupCycleStarts(rows);
  }

  async getHistory(months: number, today = new Date()): Promise<CycleStart[]> {
    const currentDate = calendarDate(today, this.#timezone);
    const endDate = shiftCalendarDate(currentDate, 1, "day");
    const startDate = shiftCalendarDate(currentDate, -months, "month");
    return this.#cycleStarts(startDate, endDate);
  }

  async getCurrentPhase(today = new Date()): Promise<CurrentPhaseResult> {
    const currentDate = calendarDate(today, this.#timezone);
    const starts = await this.#cycleStarts("1970-01-01", shiftCalendarDate(currentDate, 1, "day"));
    const latestCycleStart = starts.at(-1) ?? null;
    if (!latestCycleStart) {
      return unavailable(
        "no-history",
        "No cycle starts are available from provider records. Check provider permissions and sync again.",
        null,
      );
    }

    const intervals = starts.flatMap((earlier, index) =>
      starts
        .slice(index + 1, index + 2)
        .map((later) => daysBetween(earlier.startDate, later.startDate)),
    );
    const conflictingIntervalIndex = intervals.findIndex(
      (interval) => interval < MINIMUM_REGULAR_CYCLE_DAYS,
    );
    if (conflictingIntervalIndex >= 0) {
      const conflictingDates = starts
        .slice(conflictingIntervalIndex, conflictingIntervalIndex + 2)
        .map((start) => start.startDate)
        .join(" and ");
      return unavailable(
        "conflicting-history",
        `Provider cycle-start records conflict: ${conflictingDates} are fewer than ${MINIMUM_REGULAR_CYCLE_DAYS} days apart. Correct the record in its source and sync again.`,
        latestCycleStart,
      );
    }

    if (intervals.length < MINIMUM_COMPLETED_CYCLES) {
      return unavailable(
        "sparse-history",
        "Not enough provider records for a phase estimate. At least 3 completed cycles are needed.",
        latestCycleStart,
      );
    }

    const minimumDays = Math.min(...intervals);
    const maximumDays = Math.max(...intervals);
    if (
      maximumDays > MAXIMUM_REGULAR_CYCLE_DAYS ||
      maximumDays - minimumDays > MAXIMUM_REGULAR_VARIATION_DAYS
    ) {
      return unavailable(
        "irregular-history",
        `No phase estimate is shown because provider records do not support a regular-cycle model (observed range: ${minimumDays} to ${maximumDays} days).`,
        latestCycleStart,
      );
    }

    const cycleLength = Math.round(
      intervals.reduce((total, interval) => total + interval, 0) / intervals.length,
    );
    const dayOfCycle = daysBetween(latestCycleStart.startDate, currentDate) + 1;
    if (dayOfCycle > cycleLength + 7) {
      return unavailable(
        "stale-history",
        "The latest provider cycle-start record is beyond the expected cycle window. Correct the record in its source and sync again.",
        latestCycleStart,
        cycleLength,
      );
    }

    const phase = computePhase(dayOfCycle, cycleLength);
    return {
      phase,
      dayOfCycle,
      cycleLength,
      estimate: buildEstimate({ phase, dayOfCycle, cycleLength, intervals }),
      latestCycleStart,
      availability: {
        status: "estimated",
        label: "Phase estimate available from provider cycle-start records.",
      },
    };
  }
}
