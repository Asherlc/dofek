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
  "apple-health": {
    providerId: "apple-health",
    documentTypes: [
      "application/zip",
      "application/x-zip-compressed",
      "application/xml",
      "text/xml",
    ],
    selectionErrorMessage: "Unable to select Apple Health export",
  },
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
  "fit-file": {
    providerId: "fit-file",
    documentTypes: ["application/octet-stream"],
    selectionErrorMessage: "Unable to select FIT file",
  },
  "kaya-export": {
    providerId: "kaya-export",
    documentTypes: csvDocumentTypes,
    selectionErrorMessage: "Unable to select Kaya export",
  },
} satisfies Partial<Record<ImportProviderId, FileImportProviderConfig>>;

export function getFileImportProviderConfig(
  providerId: string,
): FileImportProviderConfig | undefined {
  switch (providerId) {
    case "apple-health":
    case "apple_health":
      return fileImportProviderConfigs["apple-health"];
    case "strong-csv":
    case "cronometer-csv":
    case "garmin-dump":
    case "fit-file":
    case "kaya-export":
      return fileImportProviderConfigs[providerId];
    default:
      return undefined;
  }
}
