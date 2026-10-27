export type DataQualityCheckKey =
  | "coverage"
  | "source_overlap"
  | "activity_source_overlap"
  | "sync_freshness"
  | "outliers";

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
