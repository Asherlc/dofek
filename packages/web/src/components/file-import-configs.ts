import type { FileImportZoneProps } from "./FileImportZone.tsx";

export const appleHealthFileImportConfig: FileImportZoneProps = {
  title: "Apple Health",
  description: ".zip or .xml from Health app export",
  accept: ".zip,.xml",
  importType: "apple-health",
  fullSync: true,
};

export const fileImportConfigs: Record<string, FileImportZoneProps> = {
  "apple-health": appleHealthFileImportConfig,
  "strong-csv": {
    title: "Strong",
    description: ".csv export from Strong app",
    accept: ".csv",
    importType: "strong-csv",
  },
  "cronometer-csv": {
    title: "Cronometer",
    description: ".csv servings export from Cronometer",
    accept: ".csv",
    importType: "cronometer-csv",
  },
  "garmin-dump": {
    title: "Garmin Dump",
    description: ".zip account export from Garmin",
    accept: ".zip",
    importType: "garmin-dump",
  },
  "fit-file": {
    title: "FIT File",
    description: ".fit activity or weight file",
    accept: ".fit",
    importType: "fit-file",
  },
  "kaya-export": {
    title: "Kaya",
    description: ".csv export from Kaya",
    accept: ".csv",
    importType: "kaya-export",
  },
};

export function getFileImportConfig(providerId: string): FileImportZoneProps | undefined {
  if (providerId === "apple_health") return appleHealthFileImportConfig;
  if (!Object.hasOwn(fileImportConfigs, providerId)) return undefined;
  return fileImportConfigs[providerId];
}
