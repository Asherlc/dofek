import type { Database } from "dofek/db";
import type { AccessWindow } from "../billing/entitlement.ts";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { AnomalyDetectionRepository, type AnomalyRow } from "./anomaly-detection-repository.ts";
import { JournalRepository } from "./journal-repository.ts";
import { NutritionAnalyticsRepository } from "./nutrition-analytics-repository.ts";
import { ProcessingRepository, type ProcessingStatusDataset } from "./processing-repository.ts";

export const DATA_QUALITY_WINDOW_DAYS = 30;

export type DataQualityCheckKey =
  | "coverage"
  | "source_overlap"
  | "sync_freshness"
  | "outliers"
  | "manual_edits";

export type DataQualityCheckStatus = "healthy" | "attention" | "informational";

export interface DataQualityCheck {
  key: DataQualityCheckKey;
  label: string;
  status: DataQualityCheckStatus;
  title: string;
  message: string;
  count: number;
  lastObservedDate: string | null;
  details: string[];
}

export interface DataQualityOverview {
  generatedAt: string;
  window: {
    days: number;
    endDate: string;
  };
  overallStatus: "healthy" | "attention";
  overallMessage: string;
  checks: DataQualityCheck[];
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
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

function coverageCheck(daysWithNutritionData: number): DataQualityCheck {
  const missingDays = Math.max(DATA_QUALITY_WINDOW_DAYS - daysWithNutritionData, 0);
  const status: DataQualityCheckStatus = missingDays > 0 ? "attention" : "healthy";

  return check({
    key: "coverage",
    label: "Missing days",
    status,
    title: missingDays > 0 ? "Coverage gaps" : "Coverage is complete",
    message:
      missingDays > 0
        ? `Nutrition data is missing for ${missingDays} of the last ${DATA_QUALITY_WINDOW_DAYS} days.`
        : `Nutrition data is present for all ${DATA_QUALITY_WINDOW_DAYS} days in the selected window.`,
    count: missingDays,
    lastObservedDate: null,
    details: [
      `${daysWithNutritionData} of ${DATA_QUALITY_WINDOW_DAYS} days contain nutrition data.`,
    ],
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
  overallStatus: string,
  problemDatasets: readonly ProcessingStatusDataset[],
): string {
  const affectedAreas = problemDatasets.map((dataset) => dataset.label).join(", ") || "Some data";
  if (overallStatus === "failed" || overallStatus === "blocked") {
    return `${affectedAreas} could not be updated. Review the processing status on the dashboard.`;
  }
  if (overallStatus === "delayed" || overallStatus === "cancelled") {
    return `${affectedAreas} are not current. Review the processing status on the dashboard.`;
  }
  return `${affectedAreas} are still updating. Review the processing status on the dashboard.`;
}

function syncFreshnessCheck(
  overallStatus: string,
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

function outlierCheck(anomalies: readonly AnomalyRow[]): DataQualityCheck {
  const lastObservedDate = latestDate(anomalies.map((anomaly) => anomaly.date));
  const attention = anomalies.length > 0;
  return check({
    key: "outliers",
    label: "Outliers",
    status: attention ? "attention" : "healthy",
    title: attention ? "Unusual observations were flagged" : "No unusual observations were flagged",
    message: attention
      ? `${anomalies.length} unusual ${pluralize(anomalies.length, "observation")} were flagged in the last ${DATA_QUALITY_WINDOW_DAYS} days.`
      : `No unusual observations were flagged in the last ${DATA_QUALITY_WINDOW_DAYS} days.`,
    count: anomalies.length,
    lastObservedDate,
    details: anomalies.slice(0, 3).map((anomaly) => `${anomaly.metric} on ${anomaly.date}.`),
  });
}

function manualEntriesCheck(entries: readonly { date: string; source: { providerId: string } }[]) {
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
        ? `${count} manually entered ${pluralize(count, "journal record")} ${count === 1 ? "was" : "were"} recorded in the last ${DATA_QUALITY_WINDOW_DAYS} days.`
        : `No manually entered journal records were recorded in the last ${DATA_QUALITY_WINDOW_DAYS} days.`,
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
    const activityPromise = new ActivitiesCalendarRepository(
      this.#database,
      this.#userId,
      this.#timezone,
      this.#sensorStore,
      this.#accessWindow,
    ).getWeekList({ weeks: 1, endDate, includeProviderAbsent: true });
    const [processing, nutrition, activityDays, anomalies, journalEntries] = await Promise.all([
      new ProcessingRepository(this.#database, this.#userId).status({}),
      new NutritionAnalyticsRepository(
        this.#database,
        this.#userId,
        this.#timezone,
        this.#accessWindow,
      ).getMicronutrientDataQuality(DATA_QUALITY_WINDOW_DAYS),
      activityPromise,
      new AnomalyDetectionRepository(
        this.#database,
        this.#userId,
        this.#timezone,
        this.#sensorStore,
      ).getHistory(DATA_QUALITY_WINDOW_DAYS, endDate),
      new JournalRepository(this.#database, this.#userId).listEntries(DATA_QUALITY_WINDOW_DAYS),
    ]);

    const activityOverlapDates = activityDays.flatMap((day) =>
      day.activities
        .filter((activity) => activity.source.overlapSummary !== null)
        .map(() => day.date),
    );
    const checks = [
      coverageCheck(nutrition.daysWithData),
      sourceOverlapCheck(nutrition.overlapDays, nutrition.conflictDays, activityOverlapDates),
      syncFreshnessCheck(processing.overallStatus, processing.datasets),
      outlierCheck(anomalies),
      manualEntriesCheck(journalEntries),
    ];
    const hasAttention = checks.some((qualityCheck) => qualityCheck.status === "attention");
    const attentionCount = checks.filter(
      (qualityCheck) => qualityCheck.status === "attention",
    ).length;

    return {
      generatedAt: new Date().toISOString(),
      window: { days: DATA_QUALITY_WINDOW_DAYS, endDate },
      overallStatus: hasAttention ? "attention" : "healthy",
      overallMessage: hasAttention
        ? `${attentionCount} data quality ${pluralize(attentionCount, "check")} need review.`
        : "Your recent data is ready to interpret.",
      checks,
    };
  }
}
