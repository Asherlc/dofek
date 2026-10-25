import { userFacingErrorMessage } from "@dofek/format/user-facing-error";

export type ProviderSyncLogTone = "success" | "warning" | "danger";

export interface ProviderSyncLogPresentationInput {
  providerName: string;
  dataType: string;
  status: string;
  authFailureReason: string | null;
  errorMessage?: string | null;
  pushOnly?: boolean;
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
  const updateLabel = input.dataType === "update" ? "Update" : `${dataTypeLabel} update`;

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
      message: input.pushOnly
        ? `Reconnect ${input.providerName} to resume incoming updates.`
        : `Reconnect ${input.providerName} to resume ${dataTypeLabel} data.`,
      tone: "danger",
    };
  }

  if (input.status === "error") {
    return {
      dataTypeLabel,
      heading: input.pushOnly
        ? `${updateLabel} not processed`
        : `${dataTypeLabel} data sync failed`,
      message: input.pushOnly
        ? userFacingErrorMessage(
            input.errorMessage,
            "Earlier updates remain available. Open Diagnostics for details.",
          )
        : `Try syncing ${input.providerName} again. Open Diagnostics if the problem continues.`,
      tone: "danger",
    };
  }

  if (input.status === "degraded") {
    const subject = dataTypeLabel === "Data" ? "data" : `${dataTypeLabel.toLowerCase()} data`;
    const message = `Some ${subject} may be missing. Open Diagnostics for details.`;
    return {
      dataTypeLabel,
      heading: input.pushOnly
        ? `${updateLabel} processed with issues`
        : `${dataTypeLabel} data synced with issues`,
      message: input.pushOnly ? userFacingErrorMessage(input.errorMessage, message) : message,
      tone: "warning",
    };
  }

  if (input.status === "success") {
    return {
      dataTypeLabel,
      heading: input.pushOnly ? `${updateLabel} processed` : `${dataTypeLabel} data synced`,
      message: null,
      tone: "success",
    };
  }

  return {
    dataTypeLabel,
    heading: `${dataTypeLabel} data status unavailable`,
    message: input.pushOnly
      ? "Open Diagnostics for the processing status."
      : "Open Diagnostics for the raw sync status.",
    tone: "warning",
  };
}
