import { UnitConverter } from "@dofek/format/units";
import { activityMetricColors } from "@dofek/scoring/colors";
import { activityChartTimingPoints } from "@dofek/training/fixtures/activity-chart-timing";
import {
  type ActivityPreviewMetric,
  activityMetricSourcePreview,
  activityPreviewPoints,
  activityPreviewSource,
  defaultActivityMetricSources,
} from "@dofek/training/fixtures/activity-metric-sources";
import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { colors } from "../../theme";
import { AreaChart, CHART_COLORS, LineChart, MetricSourcePicker } from "./ActivityDetailCharts";

const meta = {
  title: "Activity/ActivityDetailCharts",
  component: LineChart,
  args: {
    data: [
      { recordedAt: "2026-10-04T16:52:51.440Z", value: 112 },
      { recordedAt: "2026-10-04T16:53:51.440Z", value: 125 },
      { recordedAt: "2026-10-04T16:54:51.440Z", value: 138 },
      { recordedAt: "2026-10-04T16:55:51.440Z", value: 129 },
    ],
    color: CHART_COLORS.heartRate,
    label: "Heart rate",
    unit: "bpm",
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof LineChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { data: [] } };
export const SparseReadings: Story = {
  args: {
    data: [null, 130, null, 145, null, 155, null].map((value, index) => ({
      recordedAt: new Date(Date.UTC(2026, 9, 20, 16, index)).toISOString(),
      value,
    })),
  },
};
export const MissingSamples: Story = {
  args: {
    data: meta.args.data.map((sample, index) => ({
      ...sample,
      value: index === 1 ? null : sample.value,
    })),
  },
};
export const IndependentMetricTimelines: Story = {
  render: () => (
    <View style={{ gap: 16 }}>
      <LineChart
        data={activityChartTimingPoints.map((point) => ({
          recordedAt: point.recordedAt,
          value: point.heartRate,
        }))}
        color={CHART_COLORS.heartRate}
        label="Heart Rate"
        unit="bpm"
      />
      <LineChart
        data={activityChartTimingPoints.map((point) => ({
          recordedAt: point.recordedAt,
          value: point.power,
        }))}
        color={CHART_COLORS.power}
        label="Power"
        unit="W"
      />
    </View>
  ),
};
export const Area: Story = { render: (args) => <AreaChart {...args} /> };
export const HighElevation: Story = {
  render: (args) => <AreaChart {...args} />,
  args: {
    data: [8000, 8050, 8000, 8200, 8350, 8150, 7900, 7600, 7450, 7550, 7400].map(
      (value, index) => ({
        recordedAt: new Date(Date.UTC(2026, 9, 4, 16, index * 5)).toISOString(),
        value,
      }),
    ),
    color: CHART_COLORS.altitude,
    label: "Elevation Profile",
    unit: "ft",
  },
};

function MetricSourcePreview() {
  const [selection, setSelection] = useState(defaultActivityMetricSources);
  const [visibility, setVisibility] = useState<Partial<Record<ActivityPreviewMetric, boolean>>>({});
  const [activeMetric, setActiveMetric] = useState<
    (typeof activityMetricSourcePreview)[number] | null
  >(null);
  const points = activityPreviewPoints(selection);
  const units = new UnitConverter("metric");

  return (
    <View style={{ width: 372, alignSelf: "center", gap: 20, marginHorizontal: -16 }}>
      <View style={{ gap: 6, paddingHorizontal: 4 }}>
        <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Preview · Demo recordings</Text>
        <Text style={{ color: colors.text, fontSize: 24, fontWeight: "600" }}>
          Activity metrics
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
          Sample ride · Strava · October 18
        </Text>
      </View>

      <View
        accessibilityRole="group"
        accessibilityLabel="Chart controls"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 4 }}
      >
        {activityMetricSourcePreview.map((metric) => {
          const source = activityPreviewSource(metric, selection[metric.key]);
          const visible = visibility[metric.key] !== false;
          const color =
            metric.key === "altitude" ? CHART_COLORS.altitude : activityMetricColors[metric.key];
          return (
            <View
              key={metric.key}
              style={{
                flexDirection: "row",
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Toggle ${metric.label}`}
                accessibilityState={{ selected: visible }}
                aria-pressed={visible}
                onPress={() =>
                  setVisibility((previous) => ({ ...previous, [metric.key]: !visible }))
                }
                style={{
                  minHeight: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 8,
                }}
              >
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: color,
                    opacity: visible ? 1 : 0.35,
                  }}
                />
                <Text
                  style={{
                    color: visible ? colors.text : colors.textSecondary,
                    fontSize: 12,
                    fontWeight: "500",
                    textDecorationLine: visible ? "none" : "line-through",
                  }}
                >
                  {metric.key === "heartRate" ? "HR" : metric.label}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${metric.label} source: ${source.sourceLabel}`}
                aria-haspopup="dialog"
                aria-expanded={activeMetric?.key === metric.key}
                onPress={() => setActiveMetric(metric)}
                style={{
                  minHeight: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 8,
                  borderLeftWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{ maxWidth: 90, color: colors.textSecondary, fontSize: 12 }}
                >
                  {source.sourceLabel}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>⌄</Text>
              </Pressable>
            </View>
          );
        })}
      </View>

      {activityMetricSourcePreview
        .filter((metric) => visibility[metric.key] !== false)
        .map((metric) => {
          const color =
            metric.key === "altitude" ? CHART_COLORS.altitude : activityMetricColors[metric.key];
          const Chart = metric.key === "altitude" ? AreaChart : LineChart;
          const data = points.map((point) => {
            const value = point[metric.key];
            return {
              recordedAt: point.recordedAt,
              value:
                metric.key === "speed" && value !== null
                  ? Number(units.convertSpeed(value * 3.6).toFixed(1))
                  : value,
            };
          });
          return (
            <Chart
              key={metric.key}
              data={data}
              color={color}
              label={metric.label}
              unit={metric.unit}
            />
          );
        })}

      <Modal
        visible={activeMetric !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setActiveMetric(null)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.3)" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close source picker"
            onPress={() => setActiveMetric(null)}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
          {activeMetric && (
            <View
              role="dialog"
              aria-modal
              accessibilityLabel={`${activeMetric.label} source`}
              accessibilityViewIsModal
              style={{
                backgroundColor: colors.surface,
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                padding: 20,
                gap: 12,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>
                  {activeMetric.label} source
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Done choosing source"
                  onPress={() => setActiveMetric(null)}
                  style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
                >
                  <Text style={{ color: colors.accent, fontWeight: "600" }}>Done</Text>
                </Pressable>
              </View>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={`${activeMetric.label} source`}
              >
                {activeMetric.sources.map((item) => {
                  const selected = item.id === selection[activeMetric.key];
                  return (
                    <Pressable
                      key={item.id}
                      accessibilityRole="radio"
                      accessibilityLabel={item.label}
                      aria-checked={selected}
                      onPress={() => {
                        setSelection((previous) => ({ ...previous, [activeMetric.key]: item.id }));
                        setActiveMetric(null);
                      }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        minHeight: 48,
                        paddingHorizontal: 12,
                        borderRadius: 10,
                        backgroundColor: selected ? colors.surfaceSecondary : undefined,
                      }}
                    >
                      <Text style={{ color: colors.text, fontSize: 14 }}>{item.label}</Text>
                      {selected && <Text style={{ color: colors.accent }}>✓</Text>}
                    </Pressable>
                  );
                })}
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                {activityPreviewSource(activeMetric, selection[activeMetric.key]).attribution}
              </Text>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

export const MetricSources = {
  name: "Metric source switchers",
  parameters: { layout: "fullscreen" },
  render: () => <MetricSourcePreview />,
} satisfies Story;

export const HeartRateSources = {
  render: function HeartRateSourcesStory() {
    const [selectedId, setSelectedId] = useState("whoop");
    return (
      <MetricSourcePicker
        label="Heart Rate"
        sources={[
          { id: "whoop", label: "WHOOP" },
          { id: "garmin", label: "Garmin" },
        ]}
        selectedId={selectedId}
        onChange={setSelectedId}
      />
    );
  },
};
