import {
  BOULDER_GRADE_SYSTEMS,
  type ClimbingGradePreference,
  gradeSystemLabel,
  ROUTE_GRADE_SYSTEMS,
} from "@dofek/training/climbing-grades";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { styles } from "../app/settings.styles";
import { colors } from "../theme";

interface ClimbingGradeSystemSettingsProps {
  errorMessage: string | null;
  onChange: (preference: ClimbingGradePreference) => void;
  preference: ClimbingGradePreference | null;
  saving: boolean;
}

export function ClimbingGradeSystemSettings({
  errorMessage,
  onChange,
  preference,
  saving,
}: ClimbingGradeSystemSettingsProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Climbing grades</Text>
      <Text style={styles.sectionDescription}>
        Choose the grade systems used for boulders and routes
      </Text>
      {errorMessage && !preference ? (
        <Text style={styles.unitErrorText}>{errorMessage}</Text>
      ) : null}
      {preference ? null : <ActivityIndicator color={colors.accent} size="small" />}
      {preference ? <Text style={styles.label}>Boulder grades</Text> : null}
      {preference ? (
        <View style={styles.gradeSystemList}>
          {BOULDER_GRADE_SYSTEMS.map((value) => {
            const selected = preference.boulder === value;
            return (
              <TouchableOpacity
                key={value}
                style={[styles.gradeSystemButton, selected && styles.unitButtonSelected]}
                onPress={() => onChange({ ...preference, boulder: value })}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel={gradeSystemLabel(value)}
                accessibilityState={{ selected, disabled: saving }}
              >
                <Text style={[styles.unitLabel, selected && styles.unitLabelSelected]}>
                  {gradeSystemLabel(value)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
      {preference ? <Text style={styles.label}>Route grades</Text> : null}
      {preference ? (
        <View style={styles.gradeSystemList}>
          {ROUTE_GRADE_SYSTEMS.map((value) => {
            const selected = preference.route === value;
            return (
              <TouchableOpacity
                key={value}
                style={[styles.gradeSystemButton, selected && styles.unitButtonSelected]}
                onPress={() => onChange({ ...preference, route: value })}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel={gradeSystemLabel(value)}
                accessibilityState={{ selected, disabled: saving }}
              >
                <Text style={[styles.unitLabel, selected && styles.unitLabelSelected]}>
                  {gradeSystemLabel(value)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
