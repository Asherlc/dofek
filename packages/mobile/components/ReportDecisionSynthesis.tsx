import type { ReportDecisionSynthesis as ReportDecisionSynthesisData } from "dofek-server/types";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";
import { Card } from "./Card";

const sections: {
  key: keyof ReportDecisionSynthesisData;
  title: string;
}[] = [
  { key: "whatChanged", title: "What changed" },
  { key: "likelyAssociations", title: "Likely associations" },
  { key: "whatWorked", title: "What worked" },
  { key: "whatToTryNext", title: "What to try next" },
  { key: "confidenceAndMissingData", title: "Confidence and missing data" },
];

export function ReportDecisionSynthesis({ synthesis }: { synthesis: ReportDecisionSynthesisData }) {
  return (
    <Card title="Decision summary">
      {sections.map((section) => (
        <View key={section.key} style={styles.section}>
          <Text style={styles.heading}>{section.title}</Text>
          {synthesis[section.key].map((item) => (
            <Text key={item} style={styles.body}>
              {item}
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
