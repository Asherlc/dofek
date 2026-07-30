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

export interface ProcessingAlertsFailurePresentation {
  title: string;
  message: string;
  retryLabel: string;
}

export function processingAlertsFailurePresentation(input: {
  errorMessage: string;
  lastCheckedLabel: string | null;
}): ProcessingAlertsFailurePresentation {
  const statusScope =
    input.lastCheckedLabel === null
      ? "We could not check for new alerts."
      : `Showing alerts last checked ${input.lastCheckedLabel}.`;

  return {
    title:
      input.lastCheckedLabel === null
        ? "Alert status is unavailable"
        : "Alert status may be out of date",
    message: `${statusScope} Your synced health data is still available, and this status check did not pause syncs or imports. Details: ${input.errorMessage}`,
    retryLabel: "Retry alert status",
  };
}
