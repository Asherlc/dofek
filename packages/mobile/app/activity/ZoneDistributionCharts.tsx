import { HEART_RATE_ZONE_COLORS, POWER_ZONE_COLORS } from "@dofek/zones/zones";
import { StyleSheet, Text, View } from "react-native";
import Svg, { G, Rect, Text as SvgText } from "react-native-svg";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { colors } from "../../theme";

const CHART_WIDTH = 340;

interface HrZone {
  zone: number;
  label: string;
  minPct: number;
  maxPct: number;
  seconds: number;
}

interface PowerZone {
  zone: number;
  label: string;
  minPct: number;
  maxPct: number | null;
  seconds: number;
}

interface ZoneDistributionDatum {
  zone: number;
  seconds: number;
}

function ZoneDistributionChart<ZoneItem extends ZoneDistributionDatum>({
  zones,
  title,
  description,
  zoneColors,
  emptyMessage,
}: {
  zones: ZoneItem[];
  title: string;
  description: string;
  zoneColors: string[];
  emptyMessage: string;
}) {
  const totalSeconds = zones.reduce((sum, zoneItem) => sum + zoneItem.seconds, 0);
  if (totalSeconds === 0) {
    return (
      <View style={zoneChartStyles.container}>
        <ChartTitleWithTooltip
          title={title}
          description={description}
          textStyle={zoneChartStyles.title}
        />
        <View style={zoneChartStyles.emptyState}>
          <Text style={zoneChartStyles.emptyStateText}>{emptyMessage}</Text>
        </View>
      </View>
    );
  }

  const barHeight = 22;
  const gap = 6;
  const labelWidth = 64;
  const pctWidth = 44;
  const barAreaWidth = CHART_WIDTH - labelWidth - pctWidth - 16;
  const chartTotalHeight = zones.length * (barHeight + gap) - gap;

  return (
    <View style={zoneChartStyles.container}>
      <ChartTitleWithTooltip
        title={title}
        description={description}
        textStyle={zoneChartStyles.title}
      />
      <Svg width={CHART_WIDTH} height={chartTotalHeight + 8}>
        {zones.map((zoneItem, zoneIndex) => {
          const percentage = totalSeconds > 0 ? zoneItem.seconds / totalSeconds : 0;
          const barWidth = Math.max(percentage * barAreaWidth, 2);
          const rowY = zoneIndex * (barHeight + gap);
          const zoneColor = zoneColors[zoneIndex] ?? "#71717a";

          return (
            <G key={zoneItem.zone}>
              <SvgText x={0} y={rowY + barHeight / 2 + 4} fill={colors.textSecondary} fontSize={11}>
                {`Zone ${zoneItem.zone}`}
              </SvgText>
              <Rect
                x={labelWidth}
                y={rowY}
                width={barAreaWidth}
                height={barHeight}
                rx={4}
                fill={colors.surfaceSecondary}
              />
              <Rect
                x={labelWidth}
                y={rowY}
                width={barWidth}
                height={barHeight}
                rx={4}
                fill={zoneColor}
              />
              <SvgText
                x={labelWidth + barAreaWidth + 8}
                y={rowY + barHeight / 2 + 4}
                fill={colors.text}
                fontSize={12}
                fontWeight="600"
              >
                {`${Math.round(percentage * 100)}%`}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

export function HrZonesChart({ zones }: { zones: HrZone[] }) {
  return (
    <ZoneDistributionChart
      zones={zones}
      title="Heart Rate Zones"
      description="This chart shows how much time you spent in each heart rate zone during the activity."
      zoneColors={HEART_RATE_ZONE_COLORS}
      emptyMessage="No heart rate zone data"
    />
  );
}

export function PowerZonesChart({ zones }: { zones: PowerZone[] }) {
  return (
    <ZoneDistributionChart
      zones={zones}
      title="Power Zones"
      description="This chart shows how much time you spent in each power zone."
      zoneColors={POWER_ZONE_COLORS}
      emptyMessage="No power zone data"
    />
  );
}

const zoneChartStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  emptyState: {
    minHeight: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyStateText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
});
