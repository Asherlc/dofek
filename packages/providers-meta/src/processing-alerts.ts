export const PROCESSING_ALERT_ACTIONS = [
  "retry_sync",
  "reconnect",
  "retry_import",
  "contact_support",
] as const;

export type ProcessingAlertAction = (typeof PROCESSING_ALERT_ACTIONS)[number];

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
