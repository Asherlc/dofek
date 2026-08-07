import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export interface OperationProgressBarProps {
  fillTestID?: string;
  message?: string;
  percentage?: number;
}

export interface OperationProgressItem extends OperationProgressBarProps {
  id: string;
  label: string;
}

function clampPercentage(percentage: number): number {
  return Math.max(0, Math.min(100, percentage));
}

export function OperationProgressBar({
  fillTestID,
  message,
  percentage,
}: OperationProgressBarProps) {
  const boundedPercentage = percentage === undefined ? undefined : clampPercentage(percentage);

  return (
    <View style={styles.container}>
      <View
        accessibilityLabel={message ?? "Operation progress"}
        accessibilityRole="progressbar"
        accessibilityValue={
          boundedPercentage === undefined ? undefined : { min: 0, max: 100, now: boundedPercentage }
        }
        style={styles.track}
        testID="operation-progress-bar"
      >
        <View
          testID={fillTestID}
          style={[
            styles.fill,
            {
              width: `${boundedPercentage ?? 35}%`,
              opacity: boundedPercentage === undefined ? 0.6 : 1,
            },
          ]}
        />
      </View>
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

export function OperationProgressBars({
  operations,
}: {
  operations: readonly OperationProgressItem[];
}) {
  return (
    <View style={styles.operations}>
      {operations.map((operation) => (
        <View key={operation.id} style={styles.operation}>
          <Text style={styles.label}>{operation.label}</Text>
          <OperationProgressBar message={operation.message} percentage={operation.percentage} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  operations: {
    gap: 12,
  },
  operation: {
    gap: 4,
  },
  label: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  container: {
    gap: 4,
  },
  track: {
    width: "100%",
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: colors.positive,
  },
  message: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
