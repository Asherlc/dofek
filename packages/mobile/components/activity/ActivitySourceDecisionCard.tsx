import { Text, View } from "react-native";
import { styles } from "./styles";

export interface ActivitySourceDecision {
  sourceCount: number;
  primarySourceLabel: string;
  explanation: string;
}

/** Renders the source count and primary source for a multi-source activity. */
export function ActivitySourceDecisionCard({ decision }: { decision: ActivitySourceDecision }) {
  return (
    <View style={styles.sourceDecisionCard}>
      <Text style={styles.sourceDecisionTitle}>How sources were combined</Text>
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
    </View>
  );
}
