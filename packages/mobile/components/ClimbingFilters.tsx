import {
  type ClimbingFilterKey,
  climbingFilterOptions,
  type ClimbingFilters as Filters,
} from "@dofek/training/climbing-filters";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export function ClimbingFilters({
  value,
  onChange,
}: {
  value: Filters;
  onChange: (value: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const keys: ClimbingFilterKey[] = ["style", "protection", "setting"];
  function remove(key: ClimbingFilterKey) {
    const next = { ...value };
    delete next[key];
    onChange(next);
  }
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={styles.chip}
        >
          <Text style={styles.text}>
            {Object.keys(value).length ? "Filter climbing" : "All climbing"}
          </Text>
        </TouchableOpacity>
        {keys.map((key) => {
          const label = climbingFilterOptions[key].find(([option]) => option === value[key])?.[1];
          return label ? (
            <TouchableOpacity
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${label} filter`}
              style={styles.chip}
              onPress={() => remove(key)}
            >
              <Text style={styles.text}>{label} ×</Text>
            </TouchableOpacity>
          ) : null;
        })}
      </View>
      {open ? (
        <View style={styles.container}>
          {keys.map((key) => (
            <View key={key} style={styles.container}>
              <Text style={styles.label}>
                {key === "style" ? "Style" : key === "protection" ? "Protection" : "Setting"}
              </Text>
              <View style={styles.row}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`All ${key}`}
                  accessibilityState={{ selected: !value[key] }}
                  style={styles.chip}
                  onPress={() => remove(key)}
                >
                  <Text style={styles.text}>All</Text>
                </TouchableOpacity>
                {climbingFilterOptions[key].map(([option, label]) => (
                  <TouchableOpacity
                    key={option}
                    accessibilityRole="button"
                    accessibilityState={{ selected: value[key] === option }}
                    onPress={() => onChange({ ...value, [key]: option })}
                    style={[styles.chip, value[key] === option ? styles.selected : undefined]}
                  >
                    <Text style={styles.text}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
          <Text style={styles.label}>
            Setting uses recorded location context. Missing details remain unknown.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10, marginBottom: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
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
