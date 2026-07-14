import type { ProviderStats } from "@dofek/providers/provider-stats";
import type { SyncLogEntry } from "./DataSourcesSyncTypes.ts";
import { FileImportZone, type FileImportZoneProps } from "./FileImportZone.tsx";

export type FileImportProviderCardProps = FileImportZoneProps & {
  providerId: string;
  stats?: ProviderStats;
  recentLogs?: SyncLogEntry[];
  showDetailsLink?: boolean;
};

export function FileImportProviderCard(props: FileImportProviderCardProps) {
  return <FileImportZone {...props} />;
}
