import { FileImportZone, type FileImportZoneProps } from "./FileImportZone.tsx";

export type FileImportProviderCardProps = FileImportZoneProps &
  Required<Pick<FileImportZoneProps, "providerId">>;

export function FileImportProviderCard(props: FileImportProviderCardProps) {
  return <FileImportZone {...props} />;
}
