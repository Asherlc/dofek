import type { ActivityHrZone, ActivityPowerZone, ZoneDistributionDatum } from "@dofek/zones/zones";
import {
  createZoneDistributionRows,
  HEART_RATE_ZONE_COLORS,
  hasZoneDistributionData,
  POWER_ZONE_COLORS,
} from "@dofek/zones/zones";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Svg, { G, Rect, Text as SvgText } from "react-native-svg";
import { AccessibleChart } from "../../components/AccessibleChart";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { colors } from "../../theme";
import { ACTIVITY_CHART_WIDTH } from "./chartDimensions";

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

  if (!hasZoneDistributionData(zones)) {
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
  const labelWidth = 148;
  const pctWidth = 44;
  const barAreaWidth = ACTIVITY_CHART_WIDTH - labelWidth - pctWidth - 16;
  const chartTotalHeight = zones.length * (barHeight + gap) - gap;
  const rows = createZoneDistributionRows(zones, zoneColors, colors.textTertiary);
  const labelX = labelWidth - 8;
  const accessibleRows = rows.map((row) => ({
    label:
      row.subordinateLabel == null
        ? row.primaryLabel
        : `${row.primaryLabel} · ${row.subordinateLabel}`,
    value: `${row.zone.percent}% · ${row.zone.seconds} seconds`,
  }));

  return (
    <AccessibleChart
      title={title}
      summary={
        title === "Heart Rate Zones"
          ? "Time spent in each heart rate zone."
          : "Time spent in each power zone."
      }
      rows={accessibleRows}
    >
      <View style={zoneChartStyles.container}>
        <ChartTitleWithTooltip
          title={title}
          description={description}
          textStyle={zoneChartStyles.title}
        />
        <Svg width={ACTIVITY_CHART_WIDTH} height={chartTotalHeight + 8}>
          {rows.map((row, rowIndex) => {
            const zoneItem = row.zone;
            const rawBarWidth = (zoneItem.percent / 100) * barAreaWidth;
            const barWidth = zoneItem.percent > 0 ? Math.max(rawBarWidth, 2) : 0;
            const rowY = rowIndex * (barHeight + gap);

            return (
              <G key={row.key}>
                {row.subordinateLabel == null ? (
                  <SvgText
                    x={labelX}
                    y={rowY + barHeight / 2 + 4}
                    fill={colors.textSecondary}
                    fontSize={11}
                    fontWeight="600"
                    textAnchor="end"
                  >
                    {row.primaryLabel}
                  </SvgText>
                ) : (
                  <>
                    <SvgText
                      x={labelX}
                      y={rowY + 9}
                      fill={colors.textSecondary}
                      fontSize={11}
                      fontWeight="600"
                      textAnchor="end"
                    >
                      {row.primaryLabel}
                    </SvgText>
                    <SvgText
                      x={labelX}
                      y={rowY + 20}
                      fill={colors.textTertiary}
                      fontSize={10}
                      textAnchor="end"
                    >
                      {row.subordinateLabel}
                    </SvgText>
                  </>
                )}
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
                  fill={row.color}
                />
                <SvgText
                  x={labelWidth + barAreaWidth + 8}
                  y={rowY + barHeight / 2 + 4}
                  fill={colors.text}
                  fontSize={12}
                  fontWeight="600"
                >
                  {row.percentLabel}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      </View>
    </AccessibleChart>
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
