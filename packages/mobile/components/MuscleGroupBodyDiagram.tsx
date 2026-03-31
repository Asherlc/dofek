import {
  computeIntensities,
  computeSlugTotals,
  INTENSITY_COLORS,
  intensityToBucket,
  type MuscleGroupInput,
  muscleGroupFillColor,
  muscleGroupLabel,
} from "@dofek/training/muscle-groups";
import { StyleSheet, Text, View } from "react-native";
import Body from "react-native-body-highlighter";
import { colors } from "../theme";

interface MuscleGroupBodyDiagramProps {
  data: MuscleGroupInput[];
}

export function MuscleGroupBodyDiagram({ data }: MuscleGroupBodyDiagramProps) {
  const slugTotals = computeSlugTotals(data);
  const intensities = computeIntensities(slugTotals);

  // Build react-native-body-highlighter data format
  const bodyData = [...intensities.entries()]
    .filter(([, intensity]) => intensity > 0)
    .map(([slug, intensity]) => ({
      slug,
      intensity: intensityToBucket(intensity),
    }));

  return (
    <View>
      <View style={localStyles.bodyRow}>
        <View style={localStyles.bodyColumn}>
          <Text style={localStyles.viewLabel}>Front</Text>
          <Body
            data={bodyData}
            side="front"
            gender="male"
            scale={0.7}
            colors={INTENSITY_COLORS}
            border="#c0c8bf"
          />
        </View>
        <View style={localStyles.bodyColumn}>
          <Text style={localStyles.viewLabel}>Back</Text>
          <Body
            data={bodyData}
            side="back"
            gender="male"
            scale={0.7}
            colors={INTENSITY_COLORS}
            border="#c0c8bf"
          />
        </View>
      </View>
      <ColorLegend />
      <SetsList slugTotals={slugTotals} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function ColorLegend() {
  return (
    <View style={localStyles.legendRow}>
      <Text style={localStyles.legendLabel}>Less</Text>
      <View style={localStyles.legendGradient}>
        {[0.05, 0.25, 0.5, 0.75, 1].map((intensity) => (
          <View
            key={intensity}
            style={[localStyles.legendStop, { backgroundColor: muscleGroupFillColor(intensity) }]}
          />
        ))}
      </View>
      <Text style={localStyles.legendLabel}>More</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sets list (compact text summary below the diagram)
// ---------------------------------------------------------------------------

function SetsList({ slugTotals }: { slugTotals: Map<string, number> }) {
  const sorted = [...slugTotals.entries()]
    .filter(([, sets]) => sets > 0)
    .sort(([, setsA], [, setsB]) => setsB - setsA);

  if (sorted.length === 0) return null;

  return (
    <View style={localStyles.setsList}>
      {sorted.map(([slug, sets]) => (
        <View key={slug} style={localStyles.setsRow}>
          <View
            style={[
              localStyles.setsIndicator,
              {
                backgroundColor: muscleGroupFillColor(sets / (sorted[0]?.[1] ?? 1)),
              },
            ]}
          />
          <Text style={localStyles.setsName}>{muscleGroupLabel(slug)}</Text>
          <Text style={localStyles.setsValue}>{Math.round(sets)}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const localStyles = StyleSheet.create({
  bodyRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
  },
  bodyColumn: {
    alignItems: "center",
  },
  viewLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    marginBottom: 4,
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 12,
  },
  legendLabel: {
    fontSize: 10,
    color: colors.textSecondary,
  },
  legendGradient: {
    flexDirection: "row",
    borderRadius: 3,
    overflow: "hidden",
    height: 6,
    width: 80,
  },
  legendStop: {
    flex: 1,
  },
  setsList: {
    marginTop: 12,
    gap: 6,
  },
  setsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  setsIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  setsName: {
    fontSize: 12,
    color: colors.textSecondary,
    flex: 1,
  },
  setsValue: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
});
