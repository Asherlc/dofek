export type ProviderSyncLogTone = "success" | "warning" | "danger";

export interface ProviderSyncLogPresentationInput {
  providerName: string;
  dataType: string;
  status: string;
  authFailureReason: string | null;
}

export interface ProviderSyncLogPresentation {
  dataTypeLabel: string;
  heading: string;
  message: string | null;
  tone: ProviderSyncLogTone;
}

const AUTHORIZATION_EXPIRED_REASONS = new Set([
  "access_token_expired",
  "refresh_token_revoked",
  "session_expired",
]);

function humanizeIdentifier(value: string): string {
  const words = value.replaceAll(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function providerSyncLogPresentation(
  input: ProviderSyncLogPresentationInput,
): ProviderSyncLogPresentation {
  const dataTypeLabel = humanizeIdentifier(input.dataType);

  if (input.authFailureReason !== null) {
    let heading = "Sign-in failed";

    if (AUTHORIZATION_EXPIRED_REASONS.has(input.authFailureReason)) {
      heading = "Authorization expired";
    } else if (input.authFailureReason === "authorization_failed") {
      heading = "Authorization failed";
    }

    return {
      dataTypeLabel,
      heading,
      message: `Reconnect ${input.providerName} to resume ${dataTypeLabel} data.`,
      tone: "danger",
    };
  }

  if (input.status === "error") {
    return {
      dataTypeLabel,
      heading: `${dataTypeLabel} data sync failed`,
      message: `Try syncing ${input.providerName} again. Open Diagnostics if the problem continues.`,
      tone: "danger",
    };
  }

  if (input.status === "degraded") {
    return {
      dataTypeLabel,
      heading: `${dataTypeLabel} data synced with issues`,
      message: `Some ${dataTypeLabel.toLowerCase()} data may be missing. Open Diagnostics for details.`,
      tone: "warning",
    };
  }

  if (input.status === "success") {
    return {
      dataTypeLabel,
      heading: `${dataTypeLabel} data synced`,
      message: null,
      tone: "success",
    };
  }

  return {
    dataTypeLabel,
    heading: `${dataTypeLabel} data status unavailable`,
    message: "Open Diagnostics for the raw sync status.",
    tone: "warning",
  };
}
