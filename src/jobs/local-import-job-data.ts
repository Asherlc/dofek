export interface LocalImportJobData {
  filePath: string;
  since: string;
  userId: string;
  importType:
    | "apple-health"
    | "strong-csv"
    | "cronometer-csv"
    | "kaya-export"
    | "crimpd"
    | "eight-a"
    | "moonboard"
    | "zos-app"
    | "garmin-dump"
    | "fit-file";
  weightUnit?: "kg" | "lbs";
  timezone?: string;
  checkpoint?: unknown;
}
