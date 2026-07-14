import type { FileImportZoneProps } from "./FileImportZone.tsx";

export const appleHealthFileImportConfig: FileImportZoneProps = {
  title: "Apple Health",
  description: ".zip or .xml from Health app export",
  accept: ".zip,.xml",
  uploadUrl: "/api/upload/apple-health?fullSync=true",
  statusUrl: "/api/upload/apple-health/status",
  chunked: true,
};

export const fileImportConfigs: Record<string, FileImportZoneProps> = {
  "apple-health": appleHealthFileImportConfig,
  "strong-csv": {
    title: "Strong",
    description: ".csv export from Strong app",
    accept: ".csv",
    uploadUrl: "/api/upload/strong-csv?units=kg",
    statusUrl: "/api/upload/strong-csv/status",
    chunked: true,
  },
  "cronometer-csv": {
    title: "Cronometer",
    description: ".csv servings export from Cronometer",
    accept: ".csv",
    uploadUrl: "/api/upload/cronometer-csv",
    statusUrl: "/api/upload/cronometer-csv/status",
    chunked: true,
  },
  "garmin-dump": {
    title: "Garmin Dump",
    description: ".zip account export from Garmin",
    accept: ".zip",
    uploadUrl: "/api/upload/garmin-dump",
    statusUrl: "/api/upload/garmin-dump/status",
    chunked: true,
  },
  "kaya-export": {
    title: "Kaya",
    description: ".csv export from Kaya",
    accept: ".csv",
    uploadUrl: "/api/upload/kaya-export",
    statusUrl: "/api/upload/kaya-export/status",
    chunked: true,
  },
};

export function getFileImportConfig(providerId: string): FileImportZoneProps | undefined {
  if (providerId === "apple_health") return appleHealthFileImportConfig;
  return fileImportConfigs[providerId];
}
