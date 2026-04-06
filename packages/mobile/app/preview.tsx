import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { checkAndApplyPreviewUpdate } from "../lib/preview-update";
import { colors } from "../theme";

type UpdateState = "checking" | "no-update" | "reloading" | "error";

export default function PreviewScreen() {
  const { pr } = useLocalSearchParams<{ pr: string }>();
  const [state, setState] = useState<UpdateState>("checking");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    checkAndApplyPreviewUpdate().then((result) => {
      setState(result.status);
      if (result.status === "error") {
        setErrorMessage(result.message);
      }
    });
  }, []);

  return (
    <View style={styles.container}>
      {state === "checking" || state === "reloading" ? (
        <>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.title}>Loading PR #{pr} Preview</Text>
          <Text style={styles.subtitle}>
            {state === "reloading" ? "Applying update..." : "Checking for update..."}
          </Text>
        </>
      ) : state === "error" ? (
        <>
          <Text style={styles.title}>Update Failed</Text>
          <Text style={styles.error}>{errorMessage}</Text>
          <Text style={styles.subtitle}>
            Make sure the preview channel is mapped to this PR branch.
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.title}>No update available</Text>
          <Text style={styles.subtitle}>
            You may already be on the latest version, or the PR OTA has not been published yet.
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
  },
  error: {
    fontSize: 14,
    color: colors.danger,
    textAlign: "center",
  },
});
