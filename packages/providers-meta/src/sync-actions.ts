export const ROUTINE_SYNC_DAYS = 7;

export const SYNC_ALL_ACTIONS = {
  recent: {
    label: "Sync recent data",
    accessibilityLabel: `Sync all providers for the last ${ROUTINE_SYNC_DAYS} days`,
    description: `Updates the last ${ROUTINE_SYNC_DAYS} days for every connected provider.`,
  },
  full: {
    label: "Sync full history…",
    accessibilityLabel: "Sync full history for all providers",
    confirmationTitle: "Sync full provider history?",
    confirmationDescription:
      "This requests all history each connected provider makes available. It may take longer and use more provider requests than a recent sync. Matching records are updated, and activities removed upstream may be hidden. It does not erase or rebuild unrelated Dofek data.",
    confirmLabel: "Start full sync",
    cancelLabel: "Cancel",
  },
  progressMessage: "Sync in progress. Follow each provider below for progress.",
} as const;
