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

function keyedItems(items: string[]): { key: string; text: string }[] {
  const occurrences = new Map<string, number>();
  return items.map((text) => {
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return { key: JSON.stringify([text, occurrence]), text };
  });
}

export function ReportDecisionSynthesis({ synthesis }: { synthesis: ReportDecisionSynthesisData }) {
  return (
    <Card title="Decision summary">
      {sections.map((section) => (
        <View key={section.key} style={styles.section}>
          <Text style={styles.heading}>{section.title}</Text>
          {keyedItems(synthesis[section.key]).map((item) => (
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
