import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Svg, { Rect, Text as SvgText, Path } from "react-native-svg";
import { ChartTitleWithTooltip } from "../components/ChartTitleWithTooltip";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { useUnitConverter } from "../lib/units";
import { colors } from "../theme";
import { scoreColor, scoreLabel, WorkloadRatio, rampRateColor, FormZone, FORM_ZONE_COLORS } from "@dofek/scoring/scoring";
import { formatPace } from "@dofek/format/format";
import { formatNumber, formatSigned } from "@dofek/format/format";
import { statusColors } from "@dofek/scoring/colors";

// ── Types ──

type TabKey = "overview" | "endurance" | "cycling" | "running" | "strength" | "hiking" | "recovery";

interface TabDef {
  key: TabKey;
  label: string;
}

const TABS: TabDef[] = [
  { key: "overview", label: "Overview" },
  { key: "endurance", label: "Endurance" },
  { key: "cycling", label: "Cycling" },
  { key: "running", label: "Running" },
  { key: "strength", label: "Strength" },
  { key: "hiking", label: "Hiking" },
  { key: "recovery", label: "Recovery" },
];

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "14d", value: 14 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "1y", value: 365 },
];

// ── Helpers ──

function sparklinePath(data: number[], width: number, height: number): string {
  if (data.length < 2) return "";
  const min = Math.min(...data);
  const max = Math.max(...data) || 1;
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  return data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function formatNullable(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return "--";
  return formatNumber(value, decimals);
}

function Sparkline({ data, width, height, color }: { data: number[]; width: number; height: number; color: string }) {
  const path = sparklinePath(data, width, height);
  if (!path) return null;
  return (
    <Svg width={width} height={height}>
      <Path d={path} stroke={color} strokeWidth={2} fill="none" />
    </Svg>
  );
}

function BarChart({
  data,
  width,
  height,
  color,
  labels,
}: {
  data: number[];
  width: number;
  height: number;
  color: string;
  labels?: string[];
}) {
  if (data.length === 0) return null;
  const maxVal = Math.max(...data, 1);
  const barWidth = Math.max(4, (width - data.length * 4) / data.length);
  const labelHeight = labels ? 14 : 0;
  const chartHeight = height - labelHeight;

  return (
    <Svg width={width} height={height}>
      {data.map((v, i) => {
        const barH = (v / maxVal) * (chartHeight - 4);
        const x = i * (barWidth + 4) + 2;
        const y = chartHeight - barH;
        return (
          <Rect key={`bar-${i}`} x={x} y={y} width={barWidth} height={barH} rx={2} fill={color} />
        );
      })}
      {labels?.map((label, i) => {
        const x = i * (barWidth + 4) + 2 + barWidth / 2;
        return (
          <SvgText
            key={`label-${i}`}
            x={x}
            y={height - 1}
            fontSize={8}
            fill={colors.textTertiary}
            textAnchor="middle"
          >
            {label}
          </SvgText>
        );
      })}
    </Svg>
  );
}

function LoadingText() {
  return <Text style={styles.loadingText}>Loading...</Text>;
}

function EmptyText({ message }: { message: string }) {
  return <Text style={styles.emptyText}>{message}</Text>;
}

// ── Main Screen ──

export default function TrainingScreen() {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [days, setDays] = useState(30);
  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}>
      {/* Tab bar */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabBarContent}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Days selector */}
      <View style={styles.daysRow}>
        {DAY_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.dayButton, days === opt.value && styles.dayButtonActive]}
            onPress={() => setDays(opt.value)}
            activeOpacity={0.7}
          >
            <Text style={[styles.dayButtonText, days === opt.value && styles.dayButtonTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Tab content */}
      {activeTab === "overview" && <OverviewTab days={days} />}
      {activeTab === "endurance" && <EnduranceTab days={days} />}
      {activeTab === "cycling" && <CyclingTab days={days} />}
      {activeTab === "running" && <RunningTab days={days} />}
      {activeTab === "strength" && <StrengthTab days={days} />}
      {activeTab === "hiking" && <HikingTab days={days} />}
      {activeTab === "recovery" && <RecoveryTab days={days} />}
    </ScrollView>
  );
}

// ── Tab 1: Overview ──

function OverviewTab({ days }: { days: number }) {
  const pmc = trpc.pmc.chart.useQuery({ days });
  const calendar = trpc.calendar.calendarData.useQuery({ days });

  const pmcData = pmc.data?.data ?? [];
  const latest = pmcData[pmcData.length - 1];
  const model = pmc.data?.model;
  const calendarData = calendar.data ?? [];

  if (pmc.isLoading || calendar.isLoading) return <LoadingText />;

  return (
    <View>
      {/* PMC Summary */}
      <ChartTitleWithTooltip
        title="Performance Management"
        description="This section summarizes your current fitness, fatigue, and form from recent training load trends."
        textStyle={styles.sectionTitle}
      />
      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Fitness</Text>
          <Text style={[styles.summaryValue, { color: colors.blue }]}>{formatNullable(latest?.ctl, 1)}</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Fatigue</Text>
          <Text style={[styles.summaryValue, { color: colors.purple }]}>{formatNullable(latest?.atl, 1)}</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Form</Text>
          <Text
            style={[
              styles.summaryValue,
              { color: latest?.tsb != null ? new FormZone(latest.tsb).color : colors.textSecondary },
            ]}
          >
            {formatNullable(latest?.tsb, 1)}
          </Text>
        </View>
      </View>

      {/* Estimated FTP */}
      {model?.ftp != null && (
        <View style={styles.card}>
          <ChartTitleWithTooltip
            title="Estimated Functional Threshold Power"
            description="This card estimates the highest power you can sustain for about one hour, based on your recent best efforts."
            textStyle={styles.cardTitle}
          />
          <Text style={styles.bigValue}>{Math.round(model.ftp)} W</Text>
          {model.r2 != null && (
            <Text style={styles.cardSubtext}>
              Model fit: {formatNumber(model.r2 * 100, 0)}% (from {model.pairedActivities} samples)
            </Text>
          )}
        </View>
      )}

      {/* Activity Calendar */}
      {calendarData.length > 0 && (
        <View>
          <ChartTitleWithTooltip
            title="Activity Calendar"
            description="This chart shows your training frequency day by day, with darker squares indicating more sessions."
            textStyle={styles.sectionTitle}
          />
          <View style={styles.calendarGrid}>
            {calendarData.map((day) => {
              const intensity = Math.min(day.activityCount, 4);
              const bgColor =
                intensity === 0
                  ? colors.surfaceSecondary
                  : intensity === 1
                    ? colors.green
                    : intensity === 2
                      ? colors.teal
                      : intensity === 3
                        ? colors.blue
                        : colors.purple;
              return (
                <View
                  key={day.date}
                  style={[styles.calendarSquare, { backgroundColor: bgColor, opacity: intensity === 0 ? 0.3 : 0.7 + intensity * 0.075 }]}
                />
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

// ── Tab 2: Endurance ──

function EnduranceTab({ days }: { days: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = screenWidth - 64;
  const polarization = trpc.efficiency.polarizationTrend.useQuery({ days });
  const ramp = trpc.cyclingAdvanced.rampRate.useQuery({ days });
  const monotony = trpc.cyclingAdvanced.trainingMonotony.useQuery({ days });

  if (polarization.isLoading || ramp.isLoading) return <LoadingText />;

  const polarizationWeeks = polarization.data?.weeks ?? [];
  const currentRampRate = ramp.data?.currentRampRate;
  const missingZonesLabel = (week: { z1Seconds: number; z2Seconds: number; z3Seconds: number }) => {
    const missing: string[] = [];
    if (week.z1Seconds <= 0) missing.push("Zone 1");
    if (week.z2Seconds <= 0) missing.push("Zone 2");
    if (week.z3Seconds <= 0) missing.push("Zone 3");
    return missing.length > 0 ? `Missing ${missing.join(", ")}` : "Polarization score unavailable";
  };

  return (
    <View>
      {/* Polarization */}
      {polarizationWeeks.length > 0 && (
        <View>
          <ChartTitleWithTooltip
            title="Training Polarization"
            description="This chart shows how each week was split between low, medium, and high intensity training."
            textStyle={styles.sectionTitle}
          />
          {polarizationWeeks.slice(-6).map((week) => {
            const total = week.z1Seconds + week.z2Seconds + week.z3Seconds || 1;
            const hasPolarizationIndex = week.polarizationIndex !== null;
            const polarizationIndexText = week.polarizationIndex !== null
              ? `Polarization score ${formatNumber(week.polarizationIndex, 2)}`
              : missingZonesLabel(week);
            return (
              <View key={week.week} style={styles.polarizationRow}>
                <Text style={styles.polarizationLabel}>{week.week.slice(5)}</Text>
                <View style={styles.polarizationBar}>
                  <View style={[styles.polarizationSegment, { flex: week.z1Seconds / total, backgroundColor: statusColors.positive }]} />
                  <View style={[styles.polarizationSegment, { flex: (week.z2Seconds / total) || 0.01, backgroundColor: statusColors.warning }]} />
                  <View style={[styles.polarizationSegment, { flex: week.z3Seconds / total, backgroundColor: statusColors.danger }]} />
                </View>
                <Text
                  style={[
                    styles.polarizationMeta,
                    { color: hasPolarizationIndex ? statusColors.info : statusColors.warning },
                  ]}
                >
                  {polarizationIndexText}
                </Text>
              </View>
            );
          })}
          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: statusColors.positive }]} />
              <Text style={styles.legendText}>Low</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: statusColors.warning }]} />
              <Text style={styles.legendText}>Medium</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: statusColors.danger }]} />
              <Text style={styles.legendText}>High</Text>
            </View>
          </View>
        </View>
      )}

      {/* Ramp Rate */}
      <View style={styles.card}>
        <ChartTitleWithTooltip
          title="Ramp Rate"
          description="This card shows how quickly your weekly training load is increasing or decreasing."
          textStyle={styles.cardTitle}
        />
        <Text style={[styles.bigValue, { color: currentRampRate != null ? rampRateColor(Math.abs(currentRampRate)) : colors.text }]}>
          {currentRampRate != null ? `${formatSigned(currentRampRate)}%` : "--"}
        </Text>
        <Text style={styles.cardSubtext}>Weekly training load change rate</Text>
      </View>

      {/* Training Monotony & Strain */}
      {(() => {
        const monotonyData = monotony.data ?? [];
        if (monotonyData.length === 0) return null;
        const latest = monotonyData[monotonyData.length - 1];
        const monotonyColor = latest && latest.monotony > 2.0 ? statusColors.danger : latest && latest.monotony > 1.5 ? statusColors.warning : statusColors.positive;
        return (
          <View style={styles.card}>
            <ChartTitleWithTooltip
              title="Training Monotony & Strain"
              description="Monotony measures how repetitive your training load is. High monotony (>2.0) with high load increases overtraining risk."
              textStyle={styles.cardTitle}
            />
            <View style={styles.summaryRow}>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Monotony</Text>
                <Text style={[styles.summaryValue, { color: monotonyColor }]}>
                  {latest ? latest.monotony.toFixed(2) : "--"}
                </Text>
              </View>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Strain</Text>
                <Text style={[styles.summaryValue, { color: colors.purple }]}>
                  {latest ? Math.round(latest.strain) : "--"}
                </Text>
              </View>
            </View>
            {monotonyData.length > 1 && (
              <View style={styles.chartContainer}>
                <BarChart
                  data={monotonyData.map((w) => w.monotony)}
                  width={chartWidth}
                  height={60}
                  color={colors.teal}
                  labels={monotonyData.map((w) => w.week.slice(5))}
                />
              </View>
            )}
          </View>
        );
      })()}

      {polarizationWeeks.length === 0 && currentRampRate == null && (monotony.data ?? []).length === 0 && (
        <EmptyText message="No endurance data available for this period." />
      )}
    </View>
  );
}

// ── Cycling Tab ──

function CyclingTab({ days }: { days: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = screenWidth - 64;

  const eftp = trpc.power.eftpTrend.useQuery({ days });
  const powerCurve = trpc.power.powerCurve.useQuery({ days });
  const pmc = trpc.pmc.chart.useQuery({ days });

  if (eftp.isLoading || powerCurve.isLoading || pmc.isLoading) return <LoadingText />;

  const eftpData = eftp.data?.trend ?? [];
  const currentEftp = eftp.data?.currentEftp;
  const model = powerCurve.data?.model;
  const points = powerCurve.data?.points ?? [];
  const pmcData = pmc.data?.data ?? [];
  const latestPmc = pmcData[pmcData.length - 1];

  // Key durations for summary
  const powerAt = (seconds: number) => points.find((p) => p.durationSeconds === seconds)?.bestPower;
  const fiveSecond = powerAt(5);
  const oneMinute = powerAt(60);
  const fiveMinute = powerAt(300);
  const twentyMinute = powerAt(1200);

  return (
    <View>
      {/* eFTP */}
      <View style={styles.card}>
        <ChartTitleWithTooltip
          title="Estimated Threshold Power"
          description="This chart tracks changes in your estimated threshold power over time."
          textStyle={styles.cardTitle}
        />
        <Text style={styles.bigValue}>
          {currentEftp != null ? `${Math.round(currentEftp)} W` : "--"}
        </Text>
        {eftpData.length > 1 && (
          <View style={styles.sparklineContainer}>
            <Sparkline
              data={eftpData.map((d) => d.eftp)}
              width={chartWidth}
              height={60}
              color={colors.teal}
            />
          </View>
        )}
      </View>

      {/* Fitness / Fatigue / Form */}
      {latestPmc && (
        <View>
          <ChartTitleWithTooltip
            title="Fitness, Fatigue & Form"
            description="This section compares your long-term fitness, short-term fatigue, and current training form."
            textStyle={styles.sectionTitle}
          />
          <View style={styles.summaryRow}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Fitness</Text>
              <Text style={[styles.summaryValue, { color: colors.blue }]}>{formatNullable(latestPmc.ctl, 1)}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Fatigue</Text>
              <Text style={[styles.summaryValue, { color: colors.purple }]}>{formatNullable(latestPmc.atl, 1)}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Form</Text>
              <Text
                style={[
                  styles.summaryValue,
                  { color: new FormZone(latestPmc.tsb).color },
                ]}
              >
                {formatNullable(latestPmc.tsb, 1)}
              </Text>
            </View>
          </View>
          {pmcData.length > 1 && (
            <View style={styles.card}>
              <View style={styles.sparklineContainer}>
                <Sparkline
                  data={pmcData.map((d) => d.ctl)}
                  width={chartWidth}
                  height={40}
                  color={colors.blue}
                />
              </View>
            </View>
          )}
          {/* Form zone legend */}
          <View style={styles.legendRow}>
            <FormZoneTag label="Transition" color={FORM_ZONE_COLORS.transition} />
            <FormZoneTag label="Fresh" color={FORM_ZONE_COLORS.fresh} />
            <FormZoneTag label="Grey" color={FORM_ZONE_COLORS.grey} />
            <FormZoneTag label="Optimal" color={FORM_ZONE_COLORS.optimal} />
            <FormZoneTag label="High Risk" color={FORM_ZONE_COLORS.highRisk} />
          </View>
        </View>
      )}

      {/* Key Power Durations */}
      {points.length > 0 && (
        <View>
          <Text style={styles.sectionTitle}>Power Bests</Text>
          <View style={styles.summaryRow}>
            <PowerCard label="5s" watts={fiveSecond} />
            <PowerCard label="1m" watts={oneMinute} />
          </View>
          <View style={styles.summaryRow}>
            <PowerCard label="5m" watts={fiveMinute} />
            <PowerCard label="20m" watts={twentyMinute} />
          </View>
        </View>
      )}

      {/* CP Model */}
      {model && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Critical Power Model</Text>
          <View style={styles.summaryRow}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Critical Power</Text>
              <Text style={[styles.summaryValue, { color: colors.teal }]}>{model.cp} W</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Anaerobic Reserve</Text>
              <Text style={[styles.summaryValue, { color: colors.orange }]}>{Math.round(model.wPrime / 1000)} kJ</Text>
            </View>
          </View>
          <Text style={styles.cardSubtext}>Model fit: {formatNumber(model.r2 * 100, 0)}%</Text>
        </View>
      )}

      {points.length === 0 && (
        <EmptyText message="No cycling power data available for this period." />
      )}

      {/* Aerobic Efficiency */}
      <AerobicEfficiencySection days={days} chartWidth={chartWidth} />

      {/* Vertical Ascent Rate */}
      <VerticalAscentSection days={days} />

      {/* Activity Variability */}
      <ActivityVariabilitySection days={days} />
    </View>
  );
}

function AerobicEfficiencySection({ days, chartWidth }: { days: number; chartWidth: number }) {
  const query = trpc.efficiency.aerobicEfficiency.useQuery({ days });
  if (query.isLoading) return null;
  const activities = query.data?.activities ?? [];
  if (activities.length === 0) return null;

  const efValues = activities.map((a) => a.efficiencyFactor);
  const latest = activities[activities.length - 1];

  return (
    <View style={styles.card}>
      <ChartTitleWithTooltip
        title="Aerobic Efficiency"
        description="Efficiency factor: power output divided by heart rate during Zone 2 work. Higher means more aerobic fitness."
        textStyle={styles.cardTitle}
      />
      <Text style={[styles.bigValue, { color: colors.teal }]}>
        {latest ? latest.efficiencyFactor.toFixed(2) : "--"}
      </Text>
      <Text style={styles.cardSubtext}>
        {latest ? `${latest.name} — ${latest.date}` : ""}
      </Text>
      {efValues.length > 1 && (
        <View style={styles.sparklineContainer}>
          <Sparkline data={efValues} width={chartWidth} height={40} color={colors.teal} />
        </View>
      )}
    </View>
  );
}

function VerticalAscentSection({ days }: { days: number }) {
  const query = trpc.cyclingAdvanced.verticalAscentRate.useQuery({ days });
  if (query.isLoading) return null;
  const rows = query.data ?? [];
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];

  return (
    <View style={styles.card}>
      <ChartTitleWithTooltip
        title="Vertical Ascent Rate"
        description="Climbing speed on steep segments (grade > 3%). Measured in meters per hour of climbing."
        textStyle={styles.cardTitle}
      />
      <Text style={[styles.bigValue, { color: colors.orange }]}>
        {latest ? `${Math.round(latest.verticalAscentRate)} m/hr` : "--"}
      </Text>
      <Text style={styles.cardSubtext}>
        {latest ? `${latest.activityName} — ${Math.round(latest.elevationGainMeters)} m gained in ${latest.climbingMinutes} min` : ""}
      </Text>
      {rows.length > 2 && (
        <View style={{ marginTop: 8, gap: 4 }}>
          {rows.slice(-5).reverse().map((row, i) => (
            <View key={`${row.date}-${i}`} style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>{row.activityName}</Text>
              <Text style={{ fontSize: 12, color: colors.text, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                {Math.round(row.verticalAscentRate)} m/hr
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function ActivityVariabilitySection({ days }: { days: number }) {
  const query = trpc.cyclingAdvanced.activityVariability.useQuery({ days, limit: 10, offset: 0 });
  if (query.isLoading) return null;
  const rows = query.data?.rows ?? [];
  if (rows.length === 0) return null;

  return (
    <View style={styles.card}>
      <ChartTitleWithTooltip
        title="Activity Variability"
        description="Variability Index (VI) shows how variable your power was — higher means more surging. Intensity Factor (IF) shows how hard you rode relative to your Functional Threshold Power (FTP)."
        textStyle={styles.cardTitle}
      />
      <View style={{ gap: 6, marginTop: 4 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 11, color: colors.textTertiary, flex: 1 }}>Activity</Text>
          <Text style={{ fontSize: 11, color: colors.textTertiary, width: 50, textAlign: "right" }}>Norm. Power</Text>
          <Text style={{ fontSize: 11, color: colors.textTertiary, width: 50, textAlign: "right" }}>Var. Index</Text>
          <Text style={{ fontSize: 11, color: colors.textTertiary, width: 50, textAlign: "right" }}>Int. Factor</Text>
        </View>
        {rows.map((row, i) => (
          <View key={`${row.date}-${i}`} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 12, color: colors.textSecondary, flex: 1 }} numberOfLines={1}>
              {row.activityName}
            </Text>
            <Text style={{ fontSize: 12, color: colors.text, fontWeight: "600", fontVariant: ["tabular-nums"], width: 50, textAlign: "right" }}>
              {Math.round(row.normalizedPower)}
            </Text>
            <Text style={{ fontSize: 12, color: colors.text, fontWeight: "600", fontVariant: ["tabular-nums"], width: 50, textAlign: "right" }}>
              {row.variabilityIndex.toFixed(2)}
            </Text>
            <Text style={{ fontSize: 12, color: colors.text, fontWeight: "600", fontVariant: ["tabular-nums"], width: 50, textAlign: "right" }}>
              {row.intensityFactor.toFixed(2)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function FormZoneTag({ label, color }: { label: string; color: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={[styles.legendText, { color }]}>{label}</Text>
    </View>
  );
}

function PowerCard({ label, watts }: { label: string; watts: number | undefined }) {
  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, { color: colors.purple }]}>
        {watts != null ? `${watts} W` : "--"}
      </Text>
    </View>
  );
}

// ── Running Tab ──

function RunningTab({ days }: { days: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = screenWidth - 64;
  const units = useUnitConverter();

  const paceTrend = trpc.running.paceTrend.useQuery({ days });
  const dynamics = trpc.running.dynamics.useQuery({ days });
  const paceCurve = trpc.durationCurves.paceCurve.useQuery({ days });

  if (paceTrend.isLoading || dynamics.isLoading) return <LoadingText />;

  const paceData = paceTrend.data ?? [];
  const dynamicsData = dynamics.data ?? [];
  const paceCurvePoints = paceCurve.data?.points ?? [];

  // Pick key durations for pace bests cards
  const targetDurations = [300, 600, 1800, 3600]; // 5m, 10m, 30m, 60m
  const durationLabels = ["5 min", "10 min", "30 min", "60 min"];

  return (
    <View>
      {/* Pace Duration Curve - Best pace at key durations */}
      {paceCurvePoints.length > 0 && (
        <View>
          <ChartTitleWithTooltip
            title="Pace Bests"
            description="Your best sustained pace at key durations. Lower pace (faster speed) is better."
            textStyle={styles.sectionTitle}
          />
          <View style={styles.summaryRow}>
            {targetDurations.slice(0, 2).map((dur, i) => {
              const point = paceCurvePoints.find((p) => p.durationSeconds === dur);
              const pace = point ? units.convertPace(point.bestPaceSecondsPerKm) : null;
              return (
                <View key={dur} style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>{durationLabels[i]}</Text>
                  <Text style={[styles.summaryValue, { color: colors.green }]}>
                    {pace != null ? `${formatPace(pace)} ${units.paceLabel}` : "--"}
                  </Text>
                </View>
              );
            })}
          </View>
          <View style={styles.summaryRow}>
            {targetDurations.slice(2).map((dur, i) => {
              const point = paceCurvePoints.find((p) => p.durationSeconds === dur);
              const pace = point ? units.convertPace(point.bestPaceSecondsPerKm) : null;
              return (
                <View key={dur} style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>{durationLabels[i + 2]}</Text>
                  <Text style={[styles.summaryValue, { color: colors.green }]}>
                    {pace != null ? `${formatPace(pace)} ${units.paceLabel}` : "--"}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* Pace Trend */}
      {paceData.length > 0 && (
        <View>
          <Text style={styles.sectionTitle}>Recent Runs</Text>
          {paceData.slice(-10).reverse().map((run, index) => (
            <View key={`${run.date}-${index}`} style={styles.card}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{run.activityName}</Text>
                  <Text style={styles.cardSubtext}>{run.date}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[styles.bigValue, { fontSize: 20, color: colors.green }]}>
                    {formatPace(units.convertPace(run.paceSecondsPerKm))} {units.paceLabel}
                  </Text>
                  <Text style={styles.cardSubtext}>
                    {formatNumber(units.convertDistance(run.distanceKm))} {units.distanceLabel} · {run.durationMinutes} min
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Running Dynamics Summary */}
      {dynamicsData.length > 0 && (
        <View>
          <Text style={styles.sectionTitle}>Running Form</Text>
          {(() => {
            const latest = dynamicsData[dynamicsData.length - 1];
            if (!latest) return null;
            return (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Latest: {latest.activityName}</Text>
                <View style={{ gap: 8, marginTop: 8 }}>
                  <FormRow label="Cadence" value={`${latest.cadence} spm`} />
                  {latest.strideLengthMeters != null && (
                    <FormRow label="Stride Length" value={`${formatNumber(latest.strideLengthMeters, 2)} m`} />
                  )}
                  {latest.stanceTimeMs != null && (
                    <FormRow label="Ground Contact" value={`${Math.round(latest.stanceTimeMs)} ms`} />
                  )}
                  {latest.verticalOscillationMm != null && (
                    <FormRow label="Vertical Oscillation" value={`${formatNumber(latest.verticalOscillationMm)} mm`} />
                  )}
                </View>
              </View>
            );
          })()}
        </View>
      )}

      {/* Cadence Sparkline */}
      {dynamicsData.length > 1 && (
        <View style={styles.card}>
          <ChartTitleWithTooltip
            title="Cadence Trend"
            description="This chart shows how your running cadence has changed across recent sessions."
            textStyle={styles.cardTitle}
          />
          <View style={styles.sparklineContainer}>
            <Sparkline
              data={dynamicsData.map((d) => d.cadence)}
              width={chartWidth}
              height={50}
              color={colors.orange}
            />
          </View>
        </View>
      )}

      {paceData.length === 0 && dynamicsData.length === 0 && (
        <EmptyText message="No running data available for this period." />
      )}
    </View>
  );
}

function FormRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Text style={{ fontSize: 13, color: colors.textSecondary }}>{label}</Text>
      <Text style={{ fontSize: 13, color: colors.text, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

// ── Tab 3: Strength ──

function StrengthTab({ days }: { days: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = screenWidth - 64;
  const units = useUnitConverter();

  const volume = trpc.strength.volumeOverTime.useQuery({ days });
  const oneRepMax = trpc.strength.estimatedOneRepMax.useQuery({ days });
  const overload = trpc.strength.progressiveOverload.useQuery({ days });
  const muscleGroup = trpc.strength.muscleGroupVolume.useQuery({ days });

  if (volume.isLoading || oneRepMax.isLoading || overload.isLoading || muscleGroup.isLoading) return <LoadingText />;

  const volumeData = volume.data ?? [];
  const oneRepMaxData = oneRepMax.data ?? [];
  const overloadData = overload.data ?? [];

  return (
    <View>
      {/* Weekly Volume */}
      {volumeData.length > 0 && (
        <View style={styles.card}>
          <ChartTitleWithTooltip
            title="Weekly Volume"
            description="This chart shows your total strength training volume for each recent week."
            textStyle={styles.cardTitle}
          />
          <View style={styles.chartContainer}>
            <BarChart
              data={volumeData.map((w) => units.convertWeight(w.totalVolumeKg))}
              width={chartWidth}
              height={100}
              color={colors.purple}
              labels={volumeData.map((w) => w.week.slice(5))}
            />
          </View>
        </View>
      )}

      {/* Estimated 1RM */}
      {oneRepMaxData.length > 0 && (
        <View>
          <ChartTitleWithTooltip
            title="Estimated 1-Rep Max"
            description="These charts show how your estimated one-rep max has changed for each exercise."
            textStyle={styles.sectionTitle}
          />
          {oneRepMaxData.map((exercise) => {
            const latestEstimate = exercise.history[exercise.history.length - 1];
            return (
              <View key={exercise.exerciseName} style={styles.card}>
                <Text style={styles.cardTitle}>{exercise.exerciseName}</Text>
                <Text style={styles.bigValue}>
                  {latestEstimate ? `${Math.round(units.convertWeight(latestEstimate.estimatedMax))} ${units.weightLabel}` : "--"}
                </Text>
                {exercise.history.length > 1 && (
                  <View style={styles.sparklineContainer}>
                    <Sparkline
                      data={exercise.history.map((e) => e.estimatedMax)}
                      width={chartWidth}
                      height={40}
                      color={colors.purple}
                    />
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* Progressive Overload */}
      {overloadData.length > 0 && (
        <View>
          <Text style={styles.sectionTitle}>Progressive Overload</Text>
          {overloadData.map((exercise) => (
              <View key={exercise.exerciseName} style={styles.card}>
                <View style={styles.overloadRow}>
                  <View style={styles.overloadInfo}>
                    <Text style={styles.cardTitle}>{exercise.exerciseName}</Text>
                    <Text style={styles.cardSubtext}>
                      Slope: {formatSigned(units.convertWeight(exercise.slopeKgPerWeek))} {units.weightLabel}/week
                    </Text>
                  </View>
                  <View style={styles.overloadChange}>
                    <Text style={[styles.changeArrow, { color: exercise.isProgressing ? statusColors.positive : statusColors.danger }]}>
                      {exercise.isProgressing ? "\u2191" : "\u2193"}
                    </Text>
                    <Text style={[styles.changePercent, { color: exercise.isProgressing ? statusColors.positive : statusColors.danger }]}>
                      {exercise.isProgressing ? "Progressing" : "Declining"}
                    </Text>
                  </View>
                </View>
              </View>
          ))}
        </View>
      )}

      {/* Muscle Group Volume */}
      {(() => {
        const muscleGroups = muscleGroup.data ?? [];
        if (muscleGroups.length === 0) return null;

        // Aggregate total sets per muscle group across all weeks
        const totals = muscleGroups
          .map((mg) => ({
            name: mg.muscleGroup,
            totalSets: mg.weeklyData.reduce((sum, w) => sum + w.sets, 0),
          }))
          .sort((a, b) => b.totalSets - a.totalSets);

        const maxSets = totals[0]?.totalSets ?? 1;

        return (
          <View style={styles.card}>
            <ChartTitleWithTooltip
              title="Muscle Group Volume"
              description="Total sets per muscle group over the selected period. Helps identify imbalances in training."
              textStyle={styles.cardTitle}
            />
            <View style={{ gap: 8, marginTop: 4 }}>
              {totals.map((mg) => (
                <View key={mg.name} style={{ gap: 2 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontSize: 12, color: colors.textSecondary }}>{mg.name}</Text>
                    <Text style={{ fontSize: 12, color: colors.text, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                      {mg.totalSets} sets
                    </Text>
                  </View>
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.surfaceSecondary, overflow: "hidden" }}>
                    <View
                      style={{
                        height: "100%",
                        borderRadius: 3,
                        backgroundColor: colors.purple,
                        width: `${(mg.totalSets / maxSets) * 100}%`,
                      }}
                    />
                  </View>
                </View>
              ))}
            </View>
          </View>
        );
      })()}

      {volumeData.length === 0 && oneRepMaxData.length === 0 && overloadData.length === 0 && (muscleGroup.data ?? []).length === 0 && (
        <EmptyText message="No strength data available for this period." />
      )}
    </View>
  );
}

// ── Tab 4: Hiking ──

function HikingTab({ days }: { days: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = screenWidth - 64;
  const units = useUnitConverter();

  const gap = trpc.hiking.gradeAdjustedPace.useQuery({ days });
  const elevation = trpc.hiking.elevationProfile.useQuery({ days: Math.max(days, 365) });

  if (gap.isLoading || elevation.isLoading) return <LoadingText />;

  const gapData = gap.data ?? [];
  const elevationData = elevation.data ?? [];

  return (
    <View>
      {/* Grade-Adjusted Pace Table */}
      {gapData.length > 0 && (
        <View>
          <Text style={styles.sectionTitle}>Grade-Adjusted Pace</Text>
          {/* Header */}
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Hike</Text>
            <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Distance</Text>
            <Text style={[styles.tableHeaderCell, { flex: 1 }]}>GAP</Text>
            <Text style={[styles.tableHeaderCell, { flex: 1 }]}>Gain</Text>
          </View>
          {gapData.slice(0, 20).map((hike, index) => (
            <View key={`${hike.date}-${index}`} style={styles.tableRow}>
              <View style={{ flex: 2 }}>
                <Text style={styles.tableCellPrimary} numberOfLines={1}>{hike.activityName || hike.date}</Text>
                <Text style={styles.tableCellSecondary}>{hike.date}</Text>
              </View>
              <Text style={[styles.tableCell, { flex: 1 }]}>
                {formatNumber(units.convertDistance(hike.distanceKm))} {units.distanceLabel}
              </Text>
              <Text style={[styles.tableCell, { flex: 1 }]}>
                {formatNumber(units.convertPace(hike.gradeAdjustedPaceMinPerKm * 60) / 60)} min{units.paceLabel}
              </Text>
              <Text style={[styles.tableCell, { flex: 1 }]}>
                {Math.round(units.convertElevation(hike.elevationGainMeters))} {units.elevationLabel}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Weekly Elevation Gain */}
      {elevationData.length > 0 && (
        <View style={[styles.card, { marginTop: 16 }]}>
          <ChartTitleWithTooltip
            title="Weekly Elevation Gain"
            description="This chart shows how much climbing you accumulated each week from hiking and walking."
            textStyle={styles.cardTitle}
          />
          <View style={styles.chartContainer}>
            <BarChart
              data={elevationData.map((w) => units.convertElevation(w.elevationGainMeters))}
              width={chartWidth}
              height={100}
              color={colors.green}
              labels={elevationData.slice(-12).map((w) => w.week.slice(5))}
            />
          </View>
        </View>
      )}

      {gapData.length === 0 && elevationData.length === 0 && (
        <EmptyText message="No hiking data available for this period." />
      )}
    </View>
  );
}

// ── Tab 5: Recovery ──

function RecoveryTab({ days }: { days: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = screenWidth - 64;

  const readiness = trpc.recovery.readinessScore.useQuery({ days });
  const workload = trpc.recovery.workloadRatio.useQuery({ days });
  const hrv = trpc.recovery.hrvVariability.useQuery({ days });

  if (readiness.isLoading || workload.isLoading || hrv.isLoading) return <LoadingText />;

  const readinessData = readiness.data ?? [];
  const workloadData = workload.data?.timeSeries ?? [];
  const hrvData = hrv.data ?? [];

  const latestReadiness = readinessData[readinessData.length - 1];
  const latestWorkload = workloadData[workloadData.length - 1];

  return (
    <View>
      {/* Readiness Score */}
      {latestReadiness && (
        <View style={styles.card}>
          <ChartTitleWithTooltip
            title="Readiness"
            description="This score and bar breakdown summarize how prepared you are to train today."
            textStyle={styles.cardTitle}
          />
          <View style={styles.readinessHeader}>
            <Text style={[styles.bigValue, { color: scoreColor(latestReadiness.readinessScore) }]}>
              {Math.round(latestReadiness.readinessScore)}
            </Text>
            <View style={[styles.scoreBadge, { backgroundColor: scoreColor(latestReadiness.readinessScore) }]}>
              <Text style={styles.scoreBadgeText}>{scoreLabel(latestReadiness.readinessScore)}</Text>
            </View>
          </View>

          {/* Component scores */}
          <View style={styles.componentsContainer}>
            {[
              { label: "Heart Rate Variability", value: latestReadiness.components.hrvScore },
              { label: "Resting Heart Rate", value: latestReadiness.components.restingHrScore },
              { label: "Sleep", value: latestReadiness.components.sleepScore },
              { label: "Respiratory Rate", value: latestReadiness.components.respiratoryRateScore },
            ].map((comp) => (
              <View key={comp.label} style={styles.componentRow}>
                <Text style={styles.componentLabel}>{comp.label}</Text>
                <View style={styles.componentBarTrack}>
                  <View
                    style={[
                      styles.componentBarFill,
                      {
                        width: `${Math.min(comp.value, 100)}%`,
                        backgroundColor: scoreColor(comp.value),
                      },
                    ]}
                  />
                </View>
                <Text style={[styles.componentValue, { color: scoreColor(comp.value) }]}>
                  {Math.round(comp.value)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Workload Ratio */}
      {latestWorkload && latestWorkload.workloadRatio != null && (() => {
        const ratio = new WorkloadRatio(latestWorkload.workloadRatio);
        return (
          <View style={styles.card}>
            <ChartTitleWithTooltip
              title="Acute:Chronic Workload Ratio"
              description="This ratio compares short-term load against longer-term load to highlight undertraining or overload risk."
              textStyle={styles.cardTitle}
            />
            <Text style={[styles.bigValue, { color: ratio.color }]}>
              {formatNumber(latestWorkload.workloadRatio, 2)}
            </Text>
            <Text style={[styles.cardSubtext, { color: ratio.color }]}>
              {ratio.hint}
            </Text>
          </View>
        );
      })()}

      {/* HRV Trends */}
      {hrvData.length > 1 && (
        <View style={styles.card}>
          <ChartTitleWithTooltip
            title="Heart Rate Variability Trend"
            description="These charts show your rolling heart rate variability average and day-to-day variability over time."
            textStyle={styles.cardTitle}
          />
          <Text style={styles.cardSubtext}>Rolling Mean</Text>
          <View style={styles.sparklineContainer}>
            <Sparkline
              data={hrvData.filter((d) => d.rollingMean != null).map((d) => d.rollingMean as number)}
              width={chartWidth}
              height={50}
              color={colors.teal}
            />
          </View>
          <Text style={[styles.cardSubtext, { marginTop: 12 }]}>Coefficient of Variation</Text>
          <View style={styles.sparklineContainer}>
            <Sparkline
              data={hrvData.filter((d) => d.rollingCoefficientOfVariation != null).map((d) => d.rollingCoefficientOfVariation as number)}
              width={chartWidth}
              height={50}
              color={colors.orange}
            />
          </View>
        </View>
      )}

      {!latestReadiness && !latestWorkload && hrvData.length === 0 && (
        <EmptyText message="No recovery data available for this period." />
      )}
    </View>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },

  // ── Tab bar ──
  tabBar: {
    marginBottom: 8,
    flexGrow: 0,
  },
  tabBarContent: {
    gap: 8,
    paddingVertical: 4,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  tabActive: {
    backgroundColor: colors.accent,
  },
  tabText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  tabTextActive: {
    color: colors.text,
  },

  // ── Days selector ──
  daysRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  dayButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  dayButtonActive: {
    backgroundColor: colors.accent,
  },
  dayButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  dayButtonTextActive: {
    color: colors.text,
  },

  // ── Sections ──
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 12,
    marginTop: 16,
  },

  // ── Summary row ──
  summaryRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    marginBottom: 4,
    textAlign: "center",
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.text,
  },

  // ── Cards ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  cardSubtext: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },
  bigValue: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.text,
  },

  // ── Charts ──
  chartContainer: {
    marginTop: 12,
    alignItems: "center",
  },
  sparklineContainer: {
    marginTop: 8,
  },

  // ── Calendar grid ──
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 3,
  },
  calendarSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
  },

  // ── Polarization ──
  polarizationRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  polarizationLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    width: 40,
    fontVariant: ["tabular-nums"],
  },
  polarizationBar: {
    flex: 1,
    flexDirection: "row",
    height: 16,
    borderRadius: 4,
    overflow: "hidden",
    marginLeft: 8,
  },
  polarizationSegment: {
    height: "100%",
  },
  polarizationMeta: {
    width: 100,
    marginLeft: 8,
    fontSize: 10,
    textAlign: "right",
  },
  legendRow: {
    flexDirection: "row",
    gap: 16,
    marginTop: 8,
    marginBottom: 12,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 11,
    color: colors.textSecondary,
  },

  // ── Overload ──
  overloadRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  overloadInfo: {
    flex: 1,
  },
  overloadChange: {
    alignItems: "center",
    minWidth: 60,
  },
  changeArrow: {
    fontSize: 18,
    fontWeight: "700",
  },
  changePercent: {
    fontSize: 14,
    fontWeight: "700",
  },

  // ── Table ──
  tableHeader: {
    flexDirection: "row",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  tableHeaderCell: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  tableCell: {
    fontSize: 13,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  tableCellPrimary: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  tableCellSecondary: {
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 1,
  },

  // ── Readiness ──
  readinessHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  scoreBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  scoreBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.text,
  },
  componentsContainer: {
    marginTop: 16,
    gap: 10,
  },
  componentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  componentLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    width: 130,
  },
  componentBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  componentBarFill: {
    height: "100%",
    borderRadius: 4,
  },
  componentValue: {
    fontSize: 12,
    fontWeight: "700",
    width: 28,
    textAlign: "right",
  },

  // ── Status text ──
  loadingText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: 32,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 32,
  },
});
