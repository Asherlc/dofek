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
  const [clientError, setClientError] = useState<string | null>(null);
  const generateReport = trpc.healthReport.generate.useMutation({
    onSuccess: async (report) => {
      try {
        await trpcUtils.healthReport.myReports.invalidate();
      } catch (error: unknown) {
        captureException(error, { source: "health-report-list-invalidation" });
      }

      const shareUrl = `${serverUrl.replace(/\/$/, "")}/health-report?token=${report.shareToken}`;
      try {
        await Share.share({ message: shareUrl, url: shareUrl });
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
      <TouchableOpacity
        style={[styles.button, buttonDisabled && styles.buttonDisabled]}
        disabled={buttonDisabled}
        onPress={() => {
          setClientError(null);
          generateReport.mutate(input);
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
    gap: 6,
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
