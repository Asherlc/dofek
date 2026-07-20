export interface LocalImportJobData {
  filePath: string;
  since: string;
  userId: string;
  importType:
    | "apple-health"
    | "strong-csv"
    | "cronometer-csv"
    | "kaya-export"
    | "zos-app"
    | "garmin-dump"
    | "fit-file";
  weightUnit?: "kg" | "lbs";
  checkpoint?: unknown;
}
