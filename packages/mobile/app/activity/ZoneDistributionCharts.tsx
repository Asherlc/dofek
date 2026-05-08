import type { ActivityHrZone, ActivityPowerZone } from "@dofek/zones/zones";
import { HEART_RATE_ZONE_COLORS, POWER_ZONE_COLORS } from "@dofek/zones/zones";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Svg, { G, Rect, Text as SvgText } from "react-native-svg";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { colors } from "../../theme";
import { ACTIVITY_CHART_WIDTH } from "./chartDimensions";

interface ZoneDistributionDatum {
  zone: number;
  seconds: number;
  percent: number;
}

function ZoneDistributionChart<ZoneItem extends ZoneDistributionDatum>({
  zones,
  title,
  description,
  zoneColors,
  emptyMessage,
  loading = false,
  errorMessage,
}: {
  zones: ZoneItem[];
  title: string;
  description: string;
  zoneColors: string[];
  emptyMessage: string;
  loading?: boolean;
  errorMessage?: string;
}) {
  if (loading) {
    return (
      <View style={zoneChartStyles.container}>
        <ChartTitleWithTooltip
          title={title}
          description={description}
          textStyle={zoneChartStyles.title}
        />
        <View style={zoneChartStyles.emptyState}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={zoneChartStyles.container}>
        <ChartTitleWithTooltip
          title={title}
          description={description}
          textStyle={zoneChartStyles.title}
        />
        <View style={zoneChartStyles.emptyState}>
          <Text style={zoneChartStyles.errorStateText}>{errorMessage}</Text>
        </View>
      </View>
    );
  }

  if (!zones.some((zoneItem) => zoneItem.percent > 0)) {
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
  const barAreaWidth = ACTIVITY_CHART_WIDTH - labelWidth - pctWidth - 16;
  const chartTotalHeight = zones.length * (barHeight + gap) - gap;

  return (
    <View style={zoneChartStyles.container}>
      <ChartTitleWithTooltip
        title={title}
        description={description}
        textStyle={zoneChartStyles.title}
      />
      <Svg width={ACTIVITY_CHART_WIDTH} height={chartTotalHeight + 8}>
        {zones.map((zoneItem, zoneIndex) => {
          const rawBarWidth = (zoneItem.percent / 100) * barAreaWidth;
          const barWidth = zoneItem.percent > 0 ? Math.max(rawBarWidth, 2) : 0;
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
                {`${Math.round(zoneItem.percent)}%`}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

export function HrZonesChart({
  zones,
  loading,
  errorMessage,
}: {
  zones: ActivityHrZone[];
  loading?: boolean;
  errorMessage?: string;
}) {
  return (
    <ZoneDistributionChart
      zones={zones}
      title="Heart Rate Zones"
      description="This chart shows how much time you spent in each heart rate zone during the activity."
      zoneColors={HEART_RATE_ZONE_COLORS}
      emptyMessage="No heart rate zone data"
      loading={loading}
      errorMessage={errorMessage}
    />
  );
}

export function PowerZonesChart({ zones }: { zones: ActivityPowerZone[] }) {
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
  errorStateText: {
    fontSize: 13,
    color: colors.danger,
    textAlign: "center",
  },
});
