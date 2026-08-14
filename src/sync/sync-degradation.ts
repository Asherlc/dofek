export type SyncDegradationKind =
  | "pagination_stalled"
  | "pagination_empty_page_with_cursor"
  | "pagination_max_pages_exceeded"
  | "schema_mismatch"
  | "record_rejected"
  | "optional_endpoint_unavailable";

export type SyncDegradationContext = Record<string, string | number | boolean | null>;

export interface SyncDegradation {
  kind: SyncDegradationKind;
  providerId: string;
  stepName: string;
  message: string;
  externalId?: string;
  context?: SyncDegradationContext;
}
