import { ActivityIndicator, Text, TouchableOpacity } from "react-native";
import { colors } from "../../theme";
import { styles } from "./styles.ts";

export function FileImportButton({
  accessibilityLabel,
  disabled,
  loading,
  onPress,
}: {
  accessibilityLabel: string;
  disabled: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.syncButton, disabled && styles.syncButtonDisabled]}
      onPress={onPress}
      activeOpacity={0.7}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: loading, disabled }}
    >
      {loading ? (
        <ActivityIndicator color={colors.text} size="small" />
      ) : (
        <Text style={styles.syncButtonText}>Import file</Text>
      )}
    </TouchableOpacity>
  );
}
