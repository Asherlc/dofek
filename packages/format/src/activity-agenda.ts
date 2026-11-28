import { resolveRawProviderActivityType } from "@dofek/training/activity-types";
import { createActivityTypeMapper, STRAVA_ACTIVITY_TYPE_MAP } from "@dofek/training/training";
import { formatDateMedium, formatDateShort, shiftDateYmd } from "./format.ts";

/** Shared Activities agenda date presets and day-merge helpers. */

export type ActivityAgendaPreset = "this-week" | "4-weeks" | "8-weeks" | "12-weeks";

export type ActivityAgendaDateOrder = "oldest" | "newest";

/** The planned-workout endpoint accepts up to 90 inclusive calendar dates. */
export function upcomingActivityAgendaRange(today: string) {
  return { startDate: today, endDate: shiftDateYmd(today, 89) };
}

const mapPlannedSport = createActivityTypeMapper(STRAVA_ACTIVITY_TYPE_MAP);

/** Preserve day and timed order, placing plans without a start time last. */
export function filterUpcomingActivityAgenda<
  TWorkout extends { sportType: string | null; startTime: string | null },
>(days: ReadonlyArray<{ date: string; workouts: readonly TWorkout[] }> = [], sport?: string) {
  const sports = new Set<string>();

  const filteredDays = days
    .map((day) => {
      const workouts = day.workouts.filter(({ sportType }) => {
        const raw = sportType?.trim();
        const canonical =
          raw && Object.hasOwn(STRAVA_ACTIVITY_TYPE_MAP, raw)
            ? mapPlannedSport(raw).canonicalType
            : raw
              ? resolveRawProviderActivityType(raw.toLowerCase()).canonicalType
              : "other";
        if (canonical !== "other") sports.add(canonical);
        return sport === undefined || (canonical !== "other" && canonical === sport);
      });
      return {
        date: day.date,
        workouts: [
          ...workouts.filter((workout) => workout.startTime !== null),
          ...workouts.filter((workout) => workout.startTime === null),
        ],
      };
    })
    .filter(({ workouts }) => workouts.length > 0);

  if (sport !== undefined) sports.add(sport);
  return { days: filteredDays, sports: [...sports] };
}

export const ACTIVITY_AGENDA_RANGES: ReadonlyArray<{
  preset: ActivityAgendaPreset;
  label: string;
}> = [
  { preset: "this-week", label: "This week" },
  { preset: "4-weeks", label: "4 weeks" },
  { preset: "8-weeks", label: "8 weeks" },
  { preset: "12-weeks", label: "12 weeks" },
];

/** Narrow a select/chip string to a known Activities agenda preset. */
export function isActivityAgendaPreset(value: string): value is ActivityAgendaPreset {
  return ACTIVITY_AGENDA_RANGES.some((range) => range.preset === value);
}

/** Monday of the week that contains `today`, using UTC day-of-week on the YMD parts. */
function mondayOfContainingWeek(today: string): string {
  const validated = shiftDateYmd(today, 0);
  const year = Number(validated.slice(0, 4));
  const month = Number(validated.slice(5, 7));
  const day = Number(validated.slice(8, 10));
  const daysSinceMonday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return shiftDateYmd(validated, -daysSinceMonday);
}

/** Inclusive date bounds for an Activities agenda preset. */
export function activityAgendaRange(
  preset: ActivityAgendaPreset,
  today: string,
): { startDate: string; endDate: string; weeks: number } {
  switch (preset) {
    case "this-week": {
      const startDate = mondayOfContainingWeek(today);
      return { startDate, endDate: shiftDateYmd(startDate, 6), weeks: 1 };
    }
    case "4-weeks":
      // Match activityOverview: inclusive weeks*7 days ending today → start is weeks*7-1 back.
      return { startDate: shiftDateYmd(today, -(4 * 7 - 1)), endDate: today, weeks: 4 };
    case "8-weeks":
      return { startDate: shiftDateYmd(today, -(8 * 7 - 1)), endDate: today, weeks: 8 };
    case "12-weeks":
      return { startDate: shiftDateYmd(today, -(12 * 7 - 1)), endDate: today, weeks: 12 };
  }
}

/** Plan-date ownership for one completed activity page inside an explicit range. */
export function activityAgendaPlannedWindow(input: {
  rangeStart: string;
  rangeEnd: string;
  pageActivityDates: readonly string[];
  hasLaterPage: boolean;
  previousPageLastActivityDate?: string;
  dateOrder?: ActivityAgendaDateOrder;
}): { startDate: string; endDate: string } | null {
  if (input.pageActivityDates.length === 0) {
    return { startDate: input.rangeStart, endDate: input.rangeEnd };
  }

  const dateOrder = input.dateOrder ?? "newest";
  const pageLastDate =
    input.pageActivityDates[input.pageActivityDates.length - 1] ?? input.rangeEnd;

  if (dateOrder === "oldest") {
    const startDate = input.previousPageLastActivityDate
      ? shiftDateYmd(input.previousPageLastActivityDate, 1)
      : input.rangeStart;
    const endDate = input.hasLaterPage ? pageLastDate : input.rangeEnd;
    return startDate > endDate ? null : { startDate, endDate };
  }

  const startDate = input.hasLaterPage ? pageLastDate : input.rangeStart;
  const endDate = input.previousPageLastActivityDate
    ? shiftDateYmd(input.previousPageLastActivityDate, -1)
    : input.rangeEnd;
  return startDate > endDate ? null : { startDate, endDate };
}

/** Merge completed and planned day buckets, sorted by the requested date order. */
export function mergeActivityAgendaDays<TActivity, TWorkout>(
  completedDays: ReadonlyArray<{ date: string; activities: readonly TActivity[] }> | undefined,
  plannedDays: ReadonlyArray<{ date: string; workouts: readonly TWorkout[] }> | undefined,
  plannedWindow: { startDate: string; endDate: string } | null,
  dateOrder: ActivityAgendaDateOrder = "newest",
): Array<{ date: string; activities: TActivity[]; workouts: TWorkout[] }> {
  const byDate = new Map<string, { activities: TActivity[]; workouts: TWorkout[] }>();

  for (const day of completedDays ?? []) {
    const entry = byDate.get(day.date) ?? { activities: [], workouts: [] };
    entry.activities.push(...day.activities);
    byDate.set(day.date, entry);
  }

  if (plannedWindow) {
    for (const day of plannedDays ?? []) {
      if (day.date < plannedWindow.startDate || day.date > plannedWindow.endDate) continue;
      const entry = byDate.get(day.date) ?? { activities: [], workouts: [] };
      entry.workouts.push(...day.workouts);
      byDate.set(day.date, entry);
    }
  }

  return Array.from(byDate.entries())
    .sort(([left], [right]) =>
      dateOrder === "oldest" ? left.localeCompare(right) : right.localeCompare(left),
    )
    .map(([date, entry]) => ({
      date,
      activities: entry.activities,
      workouts: entry.workouts,
    }));
}

/** Inclusive YYYY-MM-DD dates from start through end. */
function activityAgendaDatesInRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = shiftDateYmd(startDate, 0); date <= endDate; date = shiftDateYmd(date, 1)) {
    dates.push(date);
  }
  return dates;
}

/** Fill empty weekdays inside the page's planned window (This week browse view). */
export function withActivityAgendaEmptyDays<TActivity, TWorkout>(
  days: ReadonlyArray<{
    date: string;
    activities: readonly TActivity[];
    workouts: readonly TWorkout[];
  }>,
  plannedWindow: { startDate: string; endDate: string } | null,
  dateOrder: ActivityAgendaDateOrder,
): Array<{ date: string; activities: TActivity[]; workouts: TWorkout[] }> {
  if (!plannedWindow) {
    return days.map((day) => ({
      date: day.date,
      activities: [...day.activities],
      workouts: [...day.workouts],
    }));
  }
  const byDate = new Map(
    days.map((day) => [day.date, { activities: [...day.activities], workouts: [...day.workouts] }]),
  );
  for (const date of activityAgendaDatesInRange(plannedWindow.startDate, plannedWindow.endDate)) {
    if (!byDate.has(date)) byDate.set(date, { activities: [], workouts: [] });
  }
  return Array.from(byDate.entries())
    .sort(([left], [right]) =>
      dateOrder === "oldest" ? left.localeCompare(right) : right.localeCompare(left),
    )
    .map(([date, entry]) => ({ date, activities: entry.activities, workouts: entry.workouts }));
}

/** Selected-range caption for the Workout calendar heading (UTC calendar dates). */
export function formatActivityAgendaCaption(startDate: string, endDate: string): string {
  // Hermes lacks reliable formatRange; compose with supported DateTimeFormat.format helpers.
  const utc = { locale: "en-US", timeZone: "UTC" } as const;
  if (startDate === endDate) return formatDateMedium(startDate, utc);
  if (startDate.slice(0, 4) === endDate.slice(0, 4)) {
    return `${formatDateShort(startDate, utc)} – ${formatDateMedium(endDate, utc)}`;
  }
  return `${formatDateMedium(startDate, utc)} – ${formatDateMedium(endDate, utc)}`;
}

/** Plan ownership for the Activities page currently shown (including same-range placeholders). */
export function resolveActivityAgendaOwnedPlannedWindow(input: {
  futureOnly: boolean;
  selectedSpan: { startDate: string; endDate: string };
  pageData:
    | {
        plannedWindow?: { startDate: string; endDate: string } | null;
      }
    | undefined;
  activityPage: number;
}): { startDate: string; endDate: string } | null {
  if (input.futureOnly) return input.selectedSpan;
  if (input.pageData != null && "plannedWindow" in input.pageData) {
    return input.pageData.plannedWindow ?? null;
  }
  if (input.activityPage === 0) return input.selectedSpan;
  return null;
}
