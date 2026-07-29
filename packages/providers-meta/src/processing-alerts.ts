export const PROCESSING_ALERT_ACTIONS = [
  "retry_sync",
  "reconnect",
  "retry_import",
  "contact_support",
] as const;

export type ProcessingAlertAction = (typeof PROCESSING_ALERT_ACTIONS)[number];

export const PROCESSING_ALERTS_EMPTY_PREVIEW = {
  title: "Nothing needs your attention",
  message: "New sync, connection, and import problems will appear here.",
  previewTitle: "When an alert appears, it will show",
  previewItems: ["What happened", "When it happened", "What to do next"],
  note: "Only real problems detected for your account are shown.",
} as const;

export interface ProcessingAlert {
  id: string;
  providerId: string | null;
  providerLabel: string | null;
  datasetKey: string;
  occurredAt: string;
  title: string;
  message: string;
  action: ProcessingAlertAction;
  actionLabel: string;
}

export interface ProcessingAlertsSnapshot {
  generatedAt: string;
  alerts: ProcessingAlert[];
}
