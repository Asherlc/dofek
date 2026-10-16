import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { styles } from "./styles";

export interface ActivitySourceDecision {
  sourceCount: number;
  primarySourceLabel: string;
  explanation: string;
}

/** Discloses the source count and primary source for a multi-source activity. */
export function ActivitySourceDecisionCard({ decision }: { decision: ActivitySourceDecision }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.sourceDecisionCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="How sources were combined"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.sourceDecisionToggle}
      >
        <Text accessible={false} style={styles.sourceDecisionTitle}>
          {expanded ? "▾" : "▸"} How sources were combined
        </Text>
      </Pressable>
      {expanded && (
        <View style={styles.sourceDecisionDetails}>
          <View style={styles.sourceDecisionDetail}>
            <Text style={styles.sourceDecisionLabel}>Sources</Text>
            <Text style={styles.sourceDecisionValue}>{decision.sourceCount}</Text>
          </View>
          <View style={styles.sourceDecisionDetail}>
            <Text style={styles.sourceDecisionLabel}>Primary</Text>
            <Text style={styles.sourceDecisionValue}>{decision.primarySourceLabel}</Text>
          </View>
        </View>
      )}
    </View>
  );
}
