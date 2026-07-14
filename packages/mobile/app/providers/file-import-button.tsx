import { ActivityIndicator, Text, TouchableOpacity } from "react-native";
import { colors } from "../../theme";
import { styles } from "./styles.ts";

export function FileImportButton({
  disabled,
  loading,
  onPress,
}: {
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
    >
      {loading ? (
        <ActivityIndicator color={colors.text} size="small" />
      ) : (
        <Text style={styles.syncButtonText}>Import file</Text>
      )}
    </TouchableOpacity>
  );
}
