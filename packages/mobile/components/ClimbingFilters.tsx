import {
  type ClimbingFilterKey,
  climbingFilterKeys,
  climbingFilterLabels,
  climbingFilterOptions,
  climbingFilterSummary,
  climbingFiltersSchema,
  climbingTypeOptions,
  type ClimbingFilters as Filters,
  toggleClimbingSetting,
  toggleClimbingType,
} from "@dofek/training/climbing-filters";
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export function ClimbingFilters({
  value,
  onChange,
}: {
  value: Filters;
  onChange: (value: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const keys = climbingFilterKeys.filter((key) => key !== "setting");
  const selectedSettings = value.setting ?? climbingFilterOptions.setting.map(([option]) => option);
  const allSettings = selectedSettings.length === climbingFilterOptions.setting.length;
  const chipKeys = keys;
  function remove(key: ClimbingFilterKey) {
    const next = { ...value };
    delete next[key];
    onChange(next);
  }
  return (
    <View style={styles.container}>
      <View style={styles.summary}>
        <Text style={[styles.text, { flex: 1 }]}>{climbingFilterSummary(value)}</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ expanded: visible }}
          onPress={() => setVisible(true)}
          style={styles.chip}
        >
          <Text style={styles.text}>Filters ⌄</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.row}>
        {chipKeys.map((key) => {
          const label = climbingFilterOptions[key].find(([option]) => option === value[key])?.[1];
          return label ? (
            <TouchableOpacity
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${climbingFilterLabels[key]}: ${label} filter`}
              style={styles.chip}
              onPress={() => remove(key)}
            >
              <Text style={styles.text}>
                {climbingFilterLabels[key]}: {label} ×
              </Text>
            </TouchableOpacity>
          ) : null;
        })}
      </View>
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <ScrollView contentContainerStyle={styles.container}>
              <Text accessibilityRole="header" style={styles.text}>
                Climbing filters
              </Text>
              <Text style={styles.label}>Type</Text>
              <View style={styles.row}>
                {[["all", "All climbing"] as const, ...climbingTypeOptions].map(
                  ([option, label]) => {
                    const selected = value.types ?? climbingTypeOptions.map(([type]) => type);
                    const all = selected.length === climbingTypeOptions.length;
                    const checked = option === "all" ? all : selected.includes(option);
                    const mixed = option === "all" && !all && selected.length > 0;
                    return (
                      <TouchableOpacity
                        key={option}
                        accessibilityRole="checkbox"
                        accessibilityLabel={label}
                        accessibilityState={{ checked: mixed ? "mixed" : checked }}
                        onPress={() => onChange(toggleClimbingType(value, option))}
                        style={styles.setting}
                      >
                        <Text
                          accessibilityElementsHidden
                          importantForAccessibility="no"
                          style={styles.text}
                        >
                          {mixed ? "▣" : checked ? "☑" : "☐"}
                        </Text>
                        <Text style={styles.text}>{label}</Text>
                      </TouchableOpacity>
                    );
                  },
                )}
              </View>
              <Text style={styles.label}>Setting</Text>
              <View style={styles.row}>
                {[
                  { value: "all" as const, label: "All settings" },
                  ...climbingFilterOptions.setting.map(([option, label]) => ({
                    value: option,
                    label,
                  })),
                ].map((item) => {
                  const checked =
                    item.value === "all" ? allSettings : selectedSettings.includes(item.value);
                  const mixed = item.value === "all" && !allSettings && selectedSettings.length > 0;
                  return (
                    <TouchableOpacity
                      key={item.value}
                      accessibilityRole="checkbox"
                      accessibilityLabel={item.label}
                      accessibilityState={{ checked: mixed ? "mixed" : checked }}
                      onPress={() => onChange(toggleClimbingSetting(value, item.value))}
                      style={styles.setting}
                    >
                      <Text
                        accessibilityElementsHidden
                        importantForAccessibility="no"
                        style={styles.text}
                      >
                        {mixed ? "▣" : checked ? "☑" : "☐"}
                      </Text>
                      <Text style={styles.text}>{item.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.row}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  onPress={() => setOpen(!open)}
                  style={styles.chip}
                >
                  <Text style={styles.text}>More filters</Text>
                </TouchableOpacity>
                {Object.keys(value).length ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => onChange({})}
                    style={styles.chip}
                  >
                    <Text style={styles.text}>Clear filters</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {open ? (
                <View style={styles.container}>
                  {keys.map((key) => (
                    <View key={key} style={styles.container}>
                      <Text style={styles.label}>{climbingFilterLabels[key]}</Text>
                      <View style={styles.row}>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`All ${climbingFilterLabels[key]}`}
                          accessibilityState={{ selected: value[key] === undefined }}
                          style={styles.chip}
                          onPress={() => remove(key)}
                        >
                          <Text style={styles.text}>All</Text>
                        </TouchableOpacity>
                        {climbingFilterOptions[key].map(([option, label]) => (
                          <TouchableOpacity
                            key={String(option)}
                            accessibilityRole="button"
                            accessibilityLabel={`${climbingFilterLabels[key]}: ${label}`}
                            accessibilityState={{ selected: value[key] === option }}
                            onPress={() =>
                              onChange(climbingFiltersSchema.parse({ ...value, [key]: option }))
                            }
                            style={[
                              styles.chip,
                              value[key] === option ? styles.selected : undefined,
                            ]}
                          >
                            <Text style={styles.text}>{label}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setVisible(false)}
                style={[styles.chip, styles.selected]}
              >
                <Text style={styles.text}>Done</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: "row", alignItems: "center", gap: 12 },
  overlay: { flex: 1, justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)", padding: 20 },
  dialog: { maxHeight: "85%", backgroundColor: colors.surface, borderRadius: 16, padding: 20 },
  container: { gap: 10, marginBottom: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  setting: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
  },
  selected: { borderColor: colors.accent, backgroundColor: colors.surfaceSecondary },
  text: { fontSize: 13, color: colors.text },
  label: { fontSize: 12, color: colors.textSecondary },
});
