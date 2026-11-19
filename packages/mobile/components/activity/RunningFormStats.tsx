import {
  formatRunningFormMeasurements,
  type RunningFormMeasurements,
} from "@dofek/format/running-form";
import { Text, View } from "react-native";
import { chartStyles } from "./ActivityDetailCharts";
import { statsStyles } from "./styles";

/** Compact Running Form readout for the selected run's Performance section. */
export function RunningFormStats({ form }: { form: RunningFormMeasurements }) {
  const readings = formatRunningFormMeasurements(form);
  return (
    <View>
      <Text accessibilityRole="header" style={chartStyles.title}>
        Running Form
      </Text>
      <View accessibilityLabel="Running Form readings" style={statsStyles.grid}>
        {readings.map(({ label, value, qualifier }) => (
          <View key={label} style={statsStyles.card}>
            <Text style={statsStyles.label}>{label}</Text>
            <Text style={statsStyles.value}>{value}</Text>
            {qualifier ? <Text style={statsStyles.secondary}>{qualifier}</Text> : null}
          </View>
        ))}
      </View>
    </View>
  );
}
