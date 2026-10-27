import {
  CLIMBING_STRENGTHS_PURPOSES,
  CLIMBING_STRENGTHS_VIEWS,
  type ClimbingStrengthsView,
  climbingStrengthsPurpose,
  climbingStrengthsPurposeView,
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const label = CLIMBING_STRENGTHS_VIEWS.find((view) => view.value === value)?.label;
  return (
    <View>
      <View style={styles.purposes} accessibilityLabel="Strengths view">
        {CLIMBING_STRENGTHS_PURPOSES.map((purpose) => (
          <Pressable
            key={purpose.value}
            accessibilityRole="button"
            accessibilityState={{ selected: climbingStrengthsPurpose(value) === purpose.value }}
            onPress={() => {
              if (climbingStrengthsPurpose(value) !== purpose.value)
                onChange(climbingStrengthsPurposeView(purpose.value));
            }}
            style={[
              styles.trigger,
              climbingStrengthsPurpose(value) === purpose.value && styles.active,
            ]}
          >
            <Text style={styles.text}>{purpose.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: optionsOpen }}
        onPress={() => setOptionsOpen(!optionsOpen)}
        style={styles.trigger}
      >
        <Text style={styles.text}>Chart options</Text>
      </Pressable>
      {optionsOpen ? (
        <View style={{ gap: 8 }}>
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
        </View>
      ) : null}
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
  purposes: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  active: { borderWidth: 1, borderColor: colors.accent },
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
