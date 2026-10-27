import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { openExternalUrl } from "../lib/open-external-url";
import { colors } from "../theme";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip";

interface TrainingMethodDetailsProps {
  title: string;
  technicalName: string;
  lines: readonly string[];
  source?: {
    title: string;
    url: string;
  };
  sourceActionId: string;
}

export function TrainingMethodDetails({
  title,
  technicalName,
  lines,
  source,
  sourceActionId,
}: TrainingMethodDetailsProps) {
  const description = [`Technical name: ${technicalName}`, ...lines].join("\n\n");

  return (
    <View style={styles.container}>
      <ChartDescriptionTooltip
        title={`How this is calculated for ${title}`}
        description={description}
      />
      {source ? (
        <TouchableOpacity
          accessibilityRole="link"
          onPress={() => {
            void openExternalUrl(source.url, sourceActionId);
          }}
        >
          <Text style={styles.sourceLink}>{source.title}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "flex-start",
    gap: 8,
  },
  sourceLink: {
    color: colors.accent,
    fontSize: 12,
    lineHeight: 18,
    textDecorationLine: "underline",
  },
});
