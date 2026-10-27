import {
  CLIMBING_STRENGTHS_VIEWS,
  type ClimbingStrengthsView,
} from "@dofek/training/climbing-strengths-views";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export function ClimbingStrengthsViewPicker({
  value,
  onChange,
}: {
  value: ClimbingStrengthsView;
  onChange: (value: ClimbingStrengthsView) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = CLIMBING_STRENGTHS_VIEWS.find((view) => view.value === value)?.label;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View: ${label}`}
        accessibilityState={{ expanded: open }}
        aria-haspopup="dialog"
        onPress={() => setOpen(true)}
        style={styles.trigger}
      >
        <Text style={styles.text}>View · {label} ▾</Text>
      </Pressable>
      {open && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <View style={styles.overlay}>
            <View style={styles.dialog} accessibilityViewIsModal>
              <Text accessibilityRole="header" style={styles.title}>
                Climbing strengths view
              </Text>
              <ScrollView>
                {CLIMBING_STRENGTHS_VIEWS.map((view) => (
                  <Pressable
                    key={view.value}
                    accessibilityRole="radio"
                    accessibilityLabel={view.label}
                    accessibilityState={{ checked: value === view.value }}
                    onPress={() => {
                      onChange(view.value);
                      setOpen(false);
                    }}
                    style={styles.choice}
                  >
                    <Text style={[styles.text, value === view.value && styles.selected]}>
                      {view.label}
                      {value === view.value ? " ✓" : ""}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpen(false)}
                style={styles.choice}
              >
                <Text style={styles.text}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  trigger: {
    alignSelf: "flex-start",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.surfaceSecondary,
  },
  text: { color: colors.text, fontSize: 13 },
  selected: { color: colors.accent, fontWeight: "700" },
  title: { color: colors.text, fontWeight: "600", fontSize: 16 },
  overlay: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.5)" },
  dialog: {
    maxHeight: "90%",
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  choice: { minHeight: 44, padding: 12, justifyContent: "center" },
});
