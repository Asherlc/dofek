import { formatDateMedium } from "@dofek/format/format";
import {
  DEFAULT_HEALTH_REPORT_SHARE_EXPIRY_DAYS,
  HEALTH_REPORT_SHARE_EXPIRY_OPTIONS,
  type HealthReportShareExpiryDays,
} from "dofek-server/health-report-share-expiry";
import type { HealthReportGenerateInput } from "dofek-server/types";
import { useState } from "react";
import { Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAuth } from "../lib/auth-context";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

export function HealthReportShareButton({
  disabled = false,
  input,
}: {
  disabled?: boolean;
  input: HealthReportGenerateInput;
}) {
  const { serverUrl } = useAuth();
  const trpcUtils = trpc.useUtils();
  const [expiresInDays, setExpiresInDays] = useState<HealthReportShareExpiryDays>(
    DEFAULT_HEALTH_REPORT_SHARE_EXPIRY_DAYS,
  );
  const [clientError, setClientError] = useState<string | null>(null);
  const generateReport = trpc.healthReport.generate.useMutation({
    onSuccess: async (report) => {
      try {
        await trpcUtils.healthReport.myReports.invalidate();
      } catch (error: unknown) {
        captureException(error, { source: "health-report-list-invalidation" });
      }

      const shareUrl = `${serverUrl.replace(/\/$/, "")}/health-report?token=${report.shareToken}`;
      const message = report.expiresAt
        ? `${shareUrl}\nExpires ${formatDateMedium(report.expiresAt)}`
        : shareUrl;
      try {
        await Share.share({ message, url: shareUrl });
      } catch (error: unknown) {
        captureException(error, { source: "health-report-native-share" });
        setClientError("Report created, but the share sheet could not be opened.");
      }
    },
  });

  const reportLabel = `${input.reportType} report`;
  const errorMessage = clientError ?? generateReport.error?.message ?? null;
  const buttonDisabled = disabled || generateReport.isPending;

  return (
    <View style={styles.container}>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Share link expires in"
        style={styles.expiryRow}
      >
        <Text style={styles.expiryLabel}>Expires in</Text>
        {HEALTH_REPORT_SHARE_EXPIRY_OPTIONS.map((days) => {
          const selected = expiresInDays === days;
          return (
            <TouchableOpacity
              key={days}
              style={[styles.expiryOption, selected && styles.expiryOptionSelected]}
              disabled={buttonDisabled}
              onPress={() => setExpiresInDays(days)}
              activeOpacity={0.7}
              accessibilityRole="radio"
              accessibilityLabel={`${days} days`}
              accessibilityState={{ checked: selected, disabled: buttonDisabled }}
            >
              <Text style={[styles.expiryOptionText, selected && styles.expiryOptionTextSelected]}>
                {days} days
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <TouchableOpacity
        style={[styles.button, buttonDisabled && styles.buttonDisabled]}
        disabled={buttonDisabled}
        onPress={() => {
          setClientError(null);
          generateReport.mutate({ ...input, expiresInDays });
        }}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Share ${reportLabel}`}
        accessibilityState={{ busy: generateReport.isPending, disabled: buttonDisabled }}
      >
        <Text style={styles.buttonText}>{generateReport.isPending ? "Creating…" : "Share"}</Text>
      </TouchableOpacity>
      {errorMessage ? (
        <Text style={styles.errorText} accessibilityRole="alert">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "flex-start",
    gap: 8,
  },
  expiryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  expiryLabel: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  expiryOption: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  expiryOptionSelected: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.accent,
  },
  expiryOptionText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },
  expiryOptionTextSelected: {
    color: colors.text,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
  },
});
