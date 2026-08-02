export type DataQualityCheckKey =
  | "coverage"
  | "source_overlap"
  | "activity_source_overlap"
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

export type DataQualityReviewDestination = "nutrition" | "activities" | "dashboard" | "journal";

export interface DataQualityReview {
  destination: DataQualityReviewDestination;
  label: string;
}

export interface DataQualityDetailItem {
  key: string;
  text: string;
}

const DATA_QUALITY_STATUS_LABELS: Record<DataQualityCheckStatus, string> = {
  attention: "Needs review",
  informational: "Info",
  healthy: "Ready",
};

const DATA_QUALITY_REVIEWS: Record<DataQualityCheckKey, DataQualityReview> = {
  coverage: { destination: "nutrition", label: "Review nutrition" },
  source_overlap: { destination: "nutrition", label: "Review nutrition" },
  activity_source_overlap: { destination: "activities", label: "Review activities" },
  sync_freshness: { destination: "dashboard", label: "Review dashboard" },
  outliers: { destination: "dashboard", label: "Review dashboard" },
  manual_edits: { destination: "journal", label: "Review journal" },
};

export function getDataQualityStatusLabel(status: DataQualityCheckStatus): string {
  return DATA_QUALITY_STATUS_LABELS[status];
}

export function getDataQualityReview(key: DataQualityCheckKey): DataQualityReview {
  return DATA_QUALITY_REVIEWS[key];
}

export function getDataQualityDetailItems(
  checkKey: DataQualityCheckKey,
  details: readonly string[],
): DataQualityDetailItem[] {
  const occurrences = new Map<string, number>();
  return details.map((text) => {
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return { key: `${checkKey}-${text}-${occurrence}`, text };
  });
}
