import {
  keyedDecisionSynthesisItems,
  reportDecisionSynthesisSections,
} from "@dofek/format/report-decision-synthesis";
import type { ReportDecisionSynthesis as ReportDecisionSynthesisData } from "dofek-server/types";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";
import { Card } from "./Card";

export function ReportDecisionSynthesis({ synthesis }: { synthesis: ReportDecisionSynthesisData }) {
  return (
    <Card title="Decision summary">
      {reportDecisionSynthesisSections.map((section) => (
        <View key={section.key} style={styles.section}>
          <Text style={styles.heading}>{section.title}</Text>
          {keyedDecisionSynthesisItems(synthesis[section.key]).map((item) => (
            <Text key={item.key} style={styles.body}>
              {item.text}
            </Text>
          ))}
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.xs,
  },
  heading: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  body: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
});
