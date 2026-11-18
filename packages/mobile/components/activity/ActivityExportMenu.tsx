import { Modal, Pressable, Text } from "react-native";
import type { ActivityExportFormat } from "../../lib/activity-export";
import { styles } from "./styles";

export interface ActivityExportOption {
  accessibilityLabel: string;
  label: string;
  format: ActivityExportFormat;
  disabled?: boolean;
}

export function ActivityExportMenu({
  visible,
  options,
  exportingFormat,
  onSelect,
  onClose,
}: {
  visible: boolean;
  options: ActivityExportOption[];
  exportingFormat: ActivityExportFormat | null;
  onSelect: (format: ActivityExportFormat) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.exportModalBackdrop} onPress={onClose} accessible={false}>
        <Pressable style={styles.exportModalCard} onPress={() => undefined} accessible={false}>
          <Text style={styles.exportModalTitle}>Export Activity</Text>
          <Text style={styles.exportModalSubtitle}>Choose a file format</Text>
          {options.map(({ accessibilityLabel, label, format, disabled }) => (
            <Pressable
              key={format}
              disabled={disabled || exportingFormat != null}
              onPress={() => onSelect(format)}
              accessibilityRole="button"
              accessibilityLabel={`Export as ${accessibilityLabel}`}
              accessibilityState={{
                busy: exportingFormat === format,
                disabled: disabled || exportingFormat != null,
              }}
              style={({ pressed }) => [
                styles.exportModalOption,
                pressed && !disabled && styles.exportModalOptionPressed,
                disabled && styles.exportModalOptionDisabled,
              ]}
            >
              <Text style={styles.exportModalOptionText}>
                {disabled ? `${label} (no GPS)` : label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel export"
            style={({ pressed }) => [
              styles.exportModalCancel,
              pressed && styles.exportModalOptionPressed,
            ]}
          >
            <Text style={styles.exportModalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
