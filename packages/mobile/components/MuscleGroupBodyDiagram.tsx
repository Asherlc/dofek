import {
  BACK_PATHS,
  BODY_VIEWBOX,
  computeIntensities,
  computeRegionTotals,
  FRONT_PATHS,
  type MuscleGroupInput,
  muscleGroupFillColor,
  muscleGroupLabel,
  STRUCTURAL_COLOR,
  UNTRAINED_COLOR,
} from "@dofek/training/muscle-groups";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { colors } from "../theme";

interface MuscleGroupBodyDiagramProps {
  data: MuscleGroupInput[];
}

export function MuscleGroupBodyDiagram({ data }: MuscleGroupBodyDiagramProps) {
  const { width: screenWidth } = useWindowDimensions();
  const regionTotals = computeRegionTotals(data);
  const intensities = computeIntensities(regionTotals);

  // Each body view gets roughly half the available width (minus padding/gap)
  const diagramWidth = Math.min((screenWidth - 80) / 2, 140);
  const diagramHeight = diagramWidth * (BODY_VIEWBOX.height / BODY_VIEWBOX.width);

  return (
    <View>
      <View style={localStyles.bodyRow}>
        <BodyView
          label="Front"
          paths={FRONT_PATHS}
          intensities={intensities}
          width={diagramWidth}
          height={diagramHeight}
        />
        <BodyView
          label="Back"
          paths={BACK_PATHS}
          intensities={intensities}
          width={diagramWidth}
          height={diagramHeight}
        />
      </View>
      <ColorLegend />
      <SetsList regionTotals={regionTotals} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Flatten paths for stable keys
// ---------------------------------------------------------------------------

interface FlatPath {
  key: string;
  group: string;
  pathData: string;
  isStructural: boolean;
}

function flattenPaths(paths: Record<string, string[]>): FlatPath[] {
  const result: FlatPath[] = [];
  for (const [group, groupPaths] of Object.entries(paths)) {
    const isStructural = group.startsWith("_");
    for (const [index, pathData] of groupPaths.entries()) {
      const side = groupPaths.length > 1 ? (index === 0 ? "left" : "right") : "center";
      result.push({ key: `${group}-${side}`, group, pathData, isStructural });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Body SVG view (front or back)
// ---------------------------------------------------------------------------

function BodyView({
  label,
  paths,
  intensities,
  width,
  height,
}: {
  label: string;
  paths: Record<string, string[]>;
  intensities: Map<string, number>;
  width: number;
  height: number;
}) {
  const flatPaths = flattenPaths(paths);

  return (
    <View style={localStyles.bodyColumn}>
      <Text style={localStyles.viewLabel}>{label}</Text>
      <Svg
        viewBox={`0 0 ${BODY_VIEWBOX.width} ${BODY_VIEWBOX.height}`}
        width={width}
        height={height}
      >
        {flatPaths.map((flatPath) => {
          const intensity = flatPath.isStructural ? 0 : (intensities.get(flatPath.group) ?? 0);
          const fill = flatPath.isStructural
            ? STRUCTURAL_COLOR
            : intensity > 0
              ? muscleGroupFillColor(intensity)
              : UNTRAINED_COLOR;

          return (
            <Path
              key={flatPath.key}
              d={flatPath.pathData}
              fill={fill}
              stroke="#c0c8bf"
              strokeWidth={0.5}
            />
          );
        })}
      </Svg>
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
        {/* Approximate gradient with 5 stops */}
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

function SetsList({ regionTotals }: { regionTotals: Map<string, number> }) {
  const sorted = [...regionTotals.entries()]
    .filter(([, sets]) => sets > 0)
    .sort(([, setsA], [, setsB]) => setsB - setsA);

  if (sorted.length === 0) return null;

  return (
    <View style={localStyles.setsList}>
      {sorted.map(([group, sets]) => (
        <View key={group} style={localStyles.setsRow}>
          <View
            style={[
              localStyles.setsIndicator,
              {
                backgroundColor: muscleGroupFillColor(sets / (sorted[0]?.[1] ?? 1)),
              },
            ]}
          />
          <Text style={localStyles.setsName}>{muscleGroupLabel(group)}</Text>
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
