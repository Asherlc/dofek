import type { ImportProviderId } from "../../lib/share-import";

type FileImportProviderConfig = {
  providerId: ImportProviderId;
  documentTypes: string[];
  selectionErrorMessage: string;
};

const csvDocumentTypes = [
  "text/csv",
  "text/comma-separated-values",
  "application/csv",
  "text/plain",
];

const fileImportProviderConfigs = {
  "strong-csv": {
    providerId: "strong-csv",
    documentTypes: csvDocumentTypes,
    selectionErrorMessage: "Unable to select Strong export",
  },
  "cronometer-csv": {
    providerId: "cronometer-csv",
    documentTypes: csvDocumentTypes,
    selectionErrorMessage: "Unable to select Cronometer export",
  },
  "garmin-dump": {
    providerId: "garmin-dump",
    documentTypes: ["application/zip", "application/x-zip-compressed"],
    selectionErrorMessage: "Unable to select Garmin export",
  },
} satisfies Partial<Record<ImportProviderId, FileImportProviderConfig>>;

export function getFileImportProviderConfig(
  providerId: string,
): FileImportProviderConfig | undefined {
  switch (providerId) {
    case "strong-csv":
    case "cronometer-csv":
    case "garmin-dump":
      return fileImportProviderConfigs[providerId];
    default:
      return undefined;
  }
}
