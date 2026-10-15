import { getFilterInputType } from "@dofek/filter-columns";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { colors } from "../../theme";
import { formatColumnName } from "./provider-detail-record-format";

export function ProviderRecordFilters({
  columns,
  filters,
  options,
  onChange,
}: {
  columns: readonly string[];
  filters: Record<string, string>;
  options: Record<string, Array<{ value: string; label?: string }>> | undefined;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <View style={styles.container}>
      {columns.map((column) => {
        const label = formatColumnName(column);
        const choices = options?.[column];
        const inputType = getFilterInputType(column);
        return (
          <View key={column} style={styles.field}>
            <Text style={styles.label}>{label}</Text>
            {choices?.length ? (
              <View style={styles.choices}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`All ${label}`}
                  accessibilityState={{ selected: !filters[column] }}
                  onPress={() => onChange(column, "")}
                  style={styles.choice}
                >
                  <Text style={styles.text}>All</Text>
                </TouchableOpacity>
                {choices.map((option) => (
                  <TouchableOpacity
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityLabel={`${label}: ${option.label ?? formatColumnName(option.value)}`}
                    accessibilityState={{ selected: filters[column] === option.value }}
                    onPress={() => onChange(column, option.value)}
                    style={styles.choice}
                  >
                    <Text style={styles.text}>
                      {option.label ?? formatColumnName(option.value)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : inputType !== "text" ? (
              <View style={styles.choices}>
                {["from", "to"].map((bound) => (
                  <TextInput
                    key={bound}
                    accessibilityLabel={`Filter ${label} ${bound}`}
                    placeholder={`${bound} · ${inputType === "date" ? "YYYY-MM-DD" : "YYYY-MM-DDTHH:mm"}`}
                    placeholderTextColor={colors.textTertiary}
                    value={filters[`${column}_${bound}`] ?? ""}
                    onChangeText={(value) => onChange(`${column}_${bound}`, value)}
                    autoCapitalize="none"
                    style={styles.input}
                  />
                ))}
              </View>
            ) : (
              <TextInput
                accessibilityLabel={`Filter ${label}`}
                value={filters[column] ?? ""}
                placeholder={`Filter ${label}`}
                placeholderTextColor={colors.textTertiary}
                onChangeText={(value) => onChange(column, value)}
                style={styles.input}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: 12, marginBottom: 12 },
  field: { gap: 8 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  label: { color: colors.textSecondary, fontSize: 12 },
  text: { color: colors.text, fontSize: 12 },
  choice: { padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
  input: {
    minWidth: 140,
    flexGrow: 1,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    color: colors.text,
    fontSize: 12,
  },
});
