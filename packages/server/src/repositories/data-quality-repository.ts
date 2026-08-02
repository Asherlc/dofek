import type {
  DataQualityCheck,
  DataQualityCheckStatus,
  DataQualityOverview,
} from "@dofek/format/data-quality";

export type {
  DataQualityCheck,
  DataQualityCheckKey,
  DataQualityCheckStatus,
  DataQualityOverview,
} from "@dofek/format/data-quality";

import type { Database } from "dofek/db";
import type { AccessWindow } from "../billing/entitlement.ts";
import { dateWindowEndExclusiveString, dateWindowStartString } from "../lib/date-window.ts";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { AnomalyDetectionRepository, type AnomalyRow } from "./anomaly-detection-repository.ts";
import { JournalRepository } from "./journal-repository.ts";
import { NutritionAnalyticsRepository } from "./nutrition-analytics-repository.ts";
import { ProcessingRepository, type ProcessingStatusDataset } from "./processing-repository.ts";

export const DATA_QUALITY_WINDOW_DAYS = 30;

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

interface DataQualityWindow {
  days: number;
  startDate: string;
  endDateExclusive: string;
}

function effectiveDataQualityWindow(
  endDate: string,
  accessWindow: AccessWindow | undefined,
): DataQualityWindow {
  const selectedStartDate = dateWindowStartString(endDate, DATA_QUALITY_WINDOW_DAYS - 1);
  const selectedEndDateExclusive = dateWindowEndExclusiveString(endDate);
  if (!accessWindow || accessWindow.kind === "full") {
    return {
      days: DATA_QUALITY_WINDOW_DAYS,
      startDate: selectedStartDate,
      endDateExclusive: selectedEndDateExclusive,
    };
  }

  const startDate =
    selectedStartDate > accessWindow.startDate ? selectedStartDate : accessWindow.startDate;
  const endDateExclusive =
    selectedEndDateExclusive < accessWindow.endDateExclusive
      ? selectedEndDateExclusive
      : accessWindow.endDateExclusive;
  const millisecondsPerDay = 24 * 60 * 60 * 1_000;
  const days = Math.max(
    0,
    Math.round(
      (Date.parse(`${endDateExclusive}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
        millisecondsPerDay,
    ),
  );
  return { days, startDate, endDateExclusive };
}

function latestDate(dates: readonly string[]): string | null {
  return [...dates].sort().at(-1) ?? null;
}

function check(input: DataQualityCheck): DataQualityCheck {
  return {
    ...input,
    details: input.details.filter((detail) => detail.length > 0),
  };
}

function coverageCheck(daysWithNutritionData: number, windowDays: number): DataQualityCheck {
  const missingDays = Math.max(windowDays - daysWithNutritionData, 0);
  const status: DataQualityCheckStatus = missingDays > 0 ? "attention" : "healthy";

  return check({
    key: "coverage",
    label: "Missing days",
    status,
    title: missingDays > 0 ? "Coverage gaps" : "Coverage is complete",
    message:
      missingDays > 0
        ? `Nutrition data is missing for ${missingDays} of the last ${windowDays} days.`
        : `Nutrition data is present for all ${windowDays} days in the selected window.`,
    count: missingDays,
    lastObservedDate: null,
    details: [`${daysWithNutritionData} of ${windowDays} days contain nutrition data.`],
  });
}

function sourceOverlapCheck(
  nutritionOverlapDays: number,
  nutritionConflictDays: number,
  activityOverlapDates: readonly string[],
): DataQualityCheck {
  const activityOverlapCount = activityOverlapDates.length;
  const totalOverlapCount = nutritionOverlapDays + activityOverlapCount;
  const status: DataQualityCheckStatus = totalOverlapCount > 0 ? "attention" : "healthy";
  const details: string[] = [];

  if (nutritionOverlapDays > 0) {
    details.push(
      `Nutrition: ${nutritionOverlapDays} overlapping ${pluralize(nutritionOverlapDays, "day")} (${nutritionConflictDays} unresolved).`,
    );
  }
  if (activityOverlapCount > 0) {
    details.push(
      `Activities: ${activityOverlapCount} ${pluralize(activityOverlapCount, "record")} ${activityOverlapCount === 1 ? "has" : "have"} matched source records.`,
    );
  }

  return check({
    key: "source_overlap",
    label: "Source overlap",
    status,
    title: totalOverlapCount > 0 ? "Some records have overlapping sources" : "Sources are distinct",
    message:
      totalOverlapCount > 0
        ? "Review the source decisions before interpreting these records."
        : "No overlapping nutrition or activity sources were detected.",
    count: totalOverlapCount,
    lastObservedDate: latestDate(activityOverlapDates),
    details,
  });
}

function processingMessage(
  overallStatus: ProcessingStatusDataset["status"],
  problemDatasets: readonly ProcessingStatusDataset[],
): string {
  const affectedAreas = problemDatasets.map((dataset) => dataset.label).join(", ") || "Some data";
  const statuses: ReadonlySet<ProcessingStatusDataset["status"]> = new Set([
    overallStatus,
    ...problemDatasets.map((dataset) => dataset.status),
  ]);
  if (statuses.has("failed") || statuses.has("blocked")) {
    return `${affectedAreas} could not be updated. Review the processing status on the dashboard.`;
  }
  if (statuses.has("delayed") || statuses.has("cancelled")) {
    return `${affectedAreas} are not current. Review the processing status on the dashboard.`;
  }
  return `${affectedAreas} are still updating. Review the processing status on the dashboard.`;
}

function syncFreshnessCheck(
  overallStatus: ProcessingStatusDataset["status"],
  datasets: readonly ProcessingStatusDataset[],
): DataQualityCheck {
  const problemDatasets = datasets.filter((dataset) => dataset.status !== "ready");
  const attention = overallStatus !== "ready" || problemDatasets.length > 0;
  return check({
    key: "sync_freshness",
    label: "Sync freshness",
    status: attention ? "attention" : "healthy",
    title: attention ? "Some data is not current" : "Data updates are current",
    message: attention
      ? processingMessage(overallStatus, problemDatasets)
      : "All selected datasets are ready.",
    count: problemDatasets.length,
    lastObservedDate: null,
    details: problemDatasets.map((dataset) => `${dataset.label}: ${dataset.status}.`),
  });
}

function outlierCheck(anomalies: readonly AnomalyRow[], windowDays: number): DataQualityCheck {
  const lastObservedDate = latestDate(anomalies.map((anomaly) => anomaly.date));
  const attention = anomalies.length > 0;
  return check({
    key: "outliers",
    label: "Outliers",
    status: attention ? "attention" : "healthy",
    title: attention ? "Unusual observations were flagged" : "No unusual observations were flagged",
    message: attention
      ? `${anomalies.length} unusual ${pluralize(anomalies.length, "observation")} ${anomalies.length === 1 ? "was" : "were"} flagged in the last ${windowDays} days.`
      : `No unusual observations were flagged in the last ${windowDays} days.`,
    count: anomalies.length,
    lastObservedDate,
    details: anomalies.slice(0, 3).map((anomaly) => `${anomaly.metric} on ${anomaly.date}.`),
  });
}

function manualEntriesCheck(
  entries: readonly { date: string; source: { providerId: string } }[],
  windowDays: number,
) {
  const manualDates = entries
    .filter((entry) => entry.source.providerId === "dofek")
    .map((entry) => entry.date);
  const count = manualDates.length;
  return check({
    key: "manual_edits",
    label: "Manual edits",
    status: count > 0 ? "informational" : "healthy",
    title: count > 0 ? "Manual entries are included" : "No manual entries recorded",
    message:
      count > 0
        ? `${count} manually entered ${pluralize(count, "journal record")} ${count === 1 ? "was" : "were"} recorded in the last ${windowDays} days.`
        : `No manually entered journal records were recorded in the last ${windowDays} days.`,
    count,
    lastObservedDate: latestDate(manualDates),
    details: [],
  });
}

/** Composes existing server-side quality signals for the cross-product center. */
export class DataQualityRepository {
  readonly #database: Database;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #accessWindow: AccessWindow | undefined;
  readonly #sensorStore: ActivitySensorStore;

  constructor(
    database: Database,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
    accessWindow?: AccessWindow,
  ) {
    this.#database = database;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
    this.#accessWindow = accessWindow;
  }

  async overview(endDate: string): Promise<DataQualityOverview> {
    const window = effectiveDataQualityWindow(endDate, this.#accessWindow);
    const activityPromise = new ActivitiesCalendarRepository(
      this.#database,
      this.#userId,
      this.#timezone,
      this.#sensorStore,
      this.#accessWindow,
    ).getWeekList({
      weeks: Math.max(1, Math.ceil(window.days / 7)),
      endDate,
      includeProviderAbsent: true,
    });
    const [processing, nutrition, activityDays, anomalies, journalEntries] = await Promise.all([
      new ProcessingRepository(this.#database, this.#userId).status({}),
      new NutritionAnalyticsRepository(
        this.#database,
        this.#userId,
        this.#timezone,
        this.#accessWindow,
      ).getMicronutrientDataQuality(window.days),
      activityPromise,
      new AnomalyDetectionRepository(
        this.#database,
        this.#userId,
        this.#timezone,
        this.#sensorStore,
      ).getHistory(window.days, endDate),
      new JournalRepository(this.#database, this.#userId).listEntries(window.days),
    ]);

    const activityOverlapDates = activityDays
      .filter((day) => day.date >= window.startDate && day.date < window.endDateExclusive)
      .flatMap((day) =>
        day.activities
          .filter((activity) => activity.source.overlapSummary !== null)
          .map(() => day.date),
      );
    const checks = [
      coverageCheck(nutrition.daysWithData, window.days),
      sourceOverlapCheck(nutrition.overlapDays, nutrition.conflictDays, activityOverlapDates),
      syncFreshnessCheck(processing.overallStatus, processing.datasets),
      outlierCheck(anomalies, window.days),
      manualEntriesCheck(journalEntries, window.days),
    ];
    const hasAttention = checks.some((qualityCheck) => qualityCheck.status === "attention");
    const attentionCount = checks.filter(
      (qualityCheck) => qualityCheck.status === "attention",
    ).length;

    return {
      generatedAt: new Date().toISOString(),
      window: { days: window.days, endDate },
      overallStatus: hasAttention ? "attention" : "healthy",
      overallMessage: hasAttention
        ? `${attentionCount} data quality ${pluralize(attentionCount, "check")} ${attentionCount === 1 ? "needs" : "need"} review.`
        : "Your recent data is ready to interpret.",
      checks,
    };
  }
}
