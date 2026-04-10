import { formatNumber } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import { activityMetricColors, statusColors } from "@dofek/scoring/colors";
import {
  computeIntensities,
  expandMuscleGroup,
  INTENSITY_COLORS,
  intensityToBucket,
  muscleGroupFillColor,
  muscleGroupLabel,
} from "@dofek/training/muscle-groups";
import { formatActivityTypeLabel } from "@dofek/training/training";
import type { ActivityHrZone } from "@dofek/zones/zones";
import { HEART_RATE_ZONE_COLORS } from "@dofek/zones/zones";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import type { StreamPoint, StrengthExerciseDetail } from "../../../server/src/routers/activity.ts";
import { ChartDescriptionTooltip } from "../components/ChartDescriptionTooltip.tsx";
import { DofekChart } from "../components/DofekChart.tsx";
import { ChartLoadingSkeleton } from "../components/LoadingSkeleton.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

const CHART_COLORS = {
  heartRate: activityMetricColors.heartRate,
  power: activityMetricColors.power,
  speed: activityMetricColors.speed,
  cadence: activityMetricColors.cadence,
  altitude: "#6b7280",
};

/**
 * Builds ECharts event handlers that translate axis pointer hover into a GPS position callback.
 * Used by MetricsChart and ElevationChart to sync hover with the RouteMap.
 */
function buildAxisPointerEvents(
  dataPoints: StreamPoint[],
  onHoverPosition?: (position: { lat: number; lng: number } | null) => void,
) {
  if (!onHoverPosition) return undefined;
  return {
    updateAxisPointer: (params: Record<string, unknown>) => {
      const axesInfo = params.axesInfo;
      if (Array.isArray(axesInfo) && axesInfo.length > 0) {
        const rawValue: unknown = axesInfo[0]?.value;
        if (typeof rawValue === "number" && rawValue >= 0 && rawValue < dataPoints.length) {
          const point = dataPoints[Math.round(rawValue)];
          if (point?.lat != null && point?.lng != null) {
            onHoverPosition({ lat: point.lat, lng: point.lng });
            return;
          }
        }
      }
      onHoverPosition(null);
    },
    globalout: () => onHoverPosition(null),
  };
}

const STRENGTH_ACTIVITY_TYPES = new Set(["strength", "strength_training", "functional_strength"]);

function isStrengthActivityType(activityType: string): boolean {
  return STRENGTH_ACTIVITY_TYPES.has(activityType);
}

export function ActivityDetailPage() {
  const { id } = useParams({ from: "/activity/$id" });

  const units = useUnitConverter();
  const detail = trpc.activity.byId.useQuery({ id });
  const stream = trpc.activity.stream.useQuery({ id, maxPoints: 500 });
  const hrZones = trpc.activity.hrZones.useQuery({ id });
  const isStrengthActivity =
    detail.data != null && isStrengthActivityType(detail.data.activityType);
  const strengthExercises = trpc.activity.strengthExercises.useQuery(
    { id },
    { enabled: isStrengthActivity },
  );

  // Ref-based hover callback avoids re-rendering the entire page on every mouse move.
  // RouteMap registers its marker-update function here; charts call it directly.
  const mapHoverRef = useRef<(position: { lat: number; lng: number } | null) => void>(() => {});
  const handleChartHover = useCallback((position: { lat: number; lng: number } | null) => {
    mapHoverRef.current(position);
  }, []);

  if (detail.isLoading) {
    return (
      <PageLayout>
        <ChartLoadingSkeleton height={400} />
      </PageLayout>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <PageLayout>
        <div className="py-8 text-center">
          <p className="text-muted mb-4">Activity not found</p>
          <Link to="/dashboard" className="text-accent hover:text-accent-secondary text-sm">
            Back to dashboard
          </Link>
        </div>
      </PageLayout>
    );
  }

  const activity = detail.data;
  const points = stream.data ?? [];
  const zones = hrZones.data ?? [];
  const hasGps = points.some((p) => p.lat != null && p.lng != null);
  const hasHr = points.some((p) => p.heartRate != null);
  const hasPower = points.some((p) => p.power != null);
  const hasSpeed = points.some((p) => p.speed != null);
  const hasCadence = points.some((p) => p.cadence != null);
  const hasAltitude = points.some((p) => p.altitude != null);

  return (
    <PageLayout>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-subtle">
          <Link to="/dashboard" className="hover:text-foreground">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">{activity.name ?? activity.activityType}</span>
        </div>
        <DeleteActivityButton activityId={id} />
      </div>

      <ActivityHeader activity={activity} units={units} />

      {hasGps && (
        <Section
          title="Route Map"
          description="This map shows your recorded route, including start and finish locations."
        >
          <RouteMap points={points} onRegisterHoverCallback={mapHoverRef} />
        </Section>
      )}

      {(hasHr || hasPower || hasSpeed || hasCadence) && (
        <Section
          title="Performance"
          description="This chart overlays heart rate, power, speed, and cadence so you can see how effort changed during the workout."
        >
          <MetricsChart
            points={points}
            hasHr={hasHr}
            hasPower={hasPower}
            hasSpeed={hasSpeed}
            hasCadence={hasCadence}
            loading={stream.isLoading}
            units={units}
            onHoverPosition={hasGps ? handleChartHover : undefined}
          />
        </Section>
      )}

      {(strengthExercises.data?.length ?? 0) > 0 && (
        <Section
          title="Exercises"
          description="Exercises performed during this strength workout, with details for each set."
        >
          <WorkoutMuscleMap exercises={strengthExercises.data ?? []} />
          <StrengthExerciseBreakdown exercises={strengthExercises.data ?? []} units={units} />
        </Section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {hasAltitude && (
          <Section
            title="Elevation Profile"
            description="This chart shows how your elevation changed over time during the activity."
          >
            <ElevationChart
              points={points}
              loading={stream.isLoading}
              units={units}
              onHoverPosition={hasGps ? handleChartHover : undefined}
            />
          </Section>
        )}

        {zones.length > 0 && (
          <Section
            title="Heart Rate Zones"
            description="This chart shows how much time you spent in each heart rate zone."
          >
            <HrZonesChart zones={zones} loading={hrZones.isLoading} />
          </Section>
        )}
      </div>
    </PageLayout>
  );
}

function DeleteActivityButton({ activityId }: { activityId: string }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const navigate = useNavigate();
  const trpcUtils = trpc.useUtils();
  const deleteMutation = trpc.activity.delete.useMutation({
    onSuccess: async () => {
      await trpcUtils.activity.list.invalidate();
      navigate({ to: "/dashboard" });
    },
  });

  if (showConfirm) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Delete this activity? This cannot be undone.</span>
        <button
          type="button"
          onClick={() => deleteMutation.mutate({ id: activityId })}
          disabled={deleteMutation.isPending}
          className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors cursor-pointer"
        >
          {deleteMutation.isPending ? "Deleting..." : "Confirm Delete"}
        </button>
        <button
          type="button"
          onClick={() => setShowConfirm(false)}
          disabled={deleteMutation.isPending}
          className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setShowConfirm(true)}
      className="px-3 py-1.5 text-xs rounded bg-accent/10 text-red-400 hover:bg-surface-hover transition-colors cursor-pointer"
    >
      Delete Activity
    </button>
  );
}

export function ActivityHeader({
  activity,
  units,
}: {
  activity: ActivityDetail;
  units: UnitConverter;
}) {
  const durationMin =
    activity.startedAt && activity.endedAt
      ? Math.round(
          (new Date(activity.endedAt).getTime() - new Date(activity.startedAt).getTime()) / 60000,
        )
      : null;

  const formatDuration = (mins: number) => {
    const hours = Math.floor(mins / 60);
    const remainingMinutes = mins % 60;
    return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
  };

  const stats: Array<{ label: string; value: string }> = [];

  if (durationMin != null) stats.push({ label: "Duration", value: formatDuration(durationMin) });
  if (activity.totalDistance != null)
    stats.push({
      label: "Distance",
      value: `${formatNumber(units.convertDistance(activity.totalDistance / 1000))} ${units.distanceLabel}`,
    });
  if (activity.elevationGain != null)
    stats.push({
      label: "Elevation Gain",
      value: `${Math.round(units.convertElevation(activity.elevationGain))} ${units.elevationLabel}`,
    });
  if (activity.avgHr != null)
    stats.push({ label: "Avg Heart Rate", value: `${Math.round(activity.avgHr)} bpm` });
  if (activity.maxHr != null)
    stats.push({ label: "Max Heart Rate", value: `${Math.round(activity.maxHr)} bpm` });
  if (activity.avgPower != null)
    stats.push({ label: "Avg Power", value: `${Math.round(activity.avgPower)} W` });
  if (activity.maxPower != null)
    stats.push({ label: "Max Power", value: `${Math.round(activity.maxPower)} W` });
  if (activity.avgSpeed != null)
    stats.push({
      label: "Avg Speed",
      value: `${formatNumber(units.convertSpeed(activity.avgSpeed * 3.6))} ${units.speedLabel}`,
    });
  if (activity.avgCadence != null)
    stats.push({ label: "Avg Cadence", value: `${Math.round(activity.avgCadence)} rpm` });

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-1">
        <h1 className="text-xl font-semibold text-foreground">
          {activity.name ?? activity.activityType}
        </h1>
        <span className="text-xs text-subtle">
          {formatActivityTypeLabel(activity.activityType)}
        </span>
      </div>
      <p className="text-sm text-subtle">
        {new Date(activity.startedAt).toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })}
        {" at "}
        {new Date(activity.startedAt).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>
      {(activity.sourceLinks.length > 0 || activity.sourceProviders.length > 0) && (
        <p className="text-xs text-subtle mb-4">
          Source: <SourceLinks activity={activity} />
        </p>
      )}

      {stats.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {stats.map((s) => (
            <div key={s.label} className="card px-4 py-3">
              <div className="text-xs text-subtle mb-0.5">{s.label}</div>
              <div className="text-lg font-medium tabular-nums">{s.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceLinks({ activity }: { activity: ActivityDetail }) {
  const linkMap = new Map(activity.sourceLinks.map((link) => [link.providerId, link]));

  return (
    <>
      {activity.sourceProviders.map((providerId, index) => {
        const link = linkMap.get(providerId);
        return (
          <span key={providerId}>
            {index > 0 && ", "}
            {link ? (
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-secondary underline"
              >
                {link.label}
              </a>
            ) : (
              providerLabel(providerId)
            )}
          </span>
        );
      })}
    </>
  );
}

function RouteMap({
  points,
  onRegisterHoverCallback,
}: {
  points: StreamPoint[];
  onRegisterHoverCallback?: React.MutableRefObject<
    (position: { lat: number; lng: number } | null) => void
  >;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<ReturnType<typeof import("leaflet")["map"]> | null>(null);

  useEffect(() => {
    const container = mapRef.current;
    if (!container) return;

    const gpsPoints = points.filter(
      (p): p is StreamPoint & { lat: number; lng: number } => p.lat != null && p.lng != null,
    );
    if (gpsPoints.length === 0) return;

    let cancelled = false;

    import("leaflet").then((L) => {
      if (cancelled || !container) return;

      // Clean up any existing map instance
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }

      const map = L.map(container, { zoomControl: true, attributionControl: false });
      mapInstanceRef.current = map;

      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
      }).addTo(map);

      const latLngs = gpsPoints.map((p) => L.latLng(p.lat, p.lng));

      L.polyline(latLngs, {
        color: statusColors.positive,
        weight: 3,
        opacity: 0.8,
      }).addTo(map);

      // Start and end markers
      const startLatLng = latLngs[0];
      const endLatLng = latLngs[latLngs.length - 1];
      if (startLatLng) {
        L.circleMarker(startLatLng, {
          radius: 6,
          color: statusColors.positive,
          fillColor: statusColors.positive,
          fillOpacity: 1,
        }).addTo(map);
      }
      if (endLatLng) {
        L.circleMarker(endLatLng, {
          radius: 6,
          color: statusColors.danger,
          fillColor: statusColors.danger,
          fillOpacity: 1,
        }).addTo(map);
      }

      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: [30, 30] });

      // Register hover marker callback so charts can update the map without React re-renders
      if (onRegisterHoverCallback) {
        let hoverMarker: ReturnType<typeof L.circleMarker> | null = null;

        onRegisterHoverCallback.current = (position) => {
          if (position) {
            if (hoverMarker) {
              hoverMarker.setLatLng([position.lat, position.lng]);
            } else {
              hoverMarker = L.circleMarker([position.lat, position.lng], {
                radius: 7,
                color: statusColors.positive,
                fillColor: "#ffffff",
                fillOpacity: 1,
                weight: 3,
              }).addTo(map);
            }
          } else {
            if (hoverMarker) {
              hoverMarker.remove();
              hoverMarker = null;
            }
          }
        };
      }
    });

    return () => {
      cancelled = true;
      if (onRegisterHoverCallback) {
        onRegisterHoverCallback.current = () => {};
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [points, onRegisterHoverCallback]);

  return <div ref={mapRef} className="w-full h-[400px] rounded-lg" />;
}

interface MetricDefinition {
  name: string;
  axisName: string;
  color: string;
  data: Array<number | null>;
}

function MetricsChart({
  points,
  hasHr,
  hasPower,
  hasSpeed,
  hasCadence,
  loading,
  units,
  onHoverPosition,
}: {
  points: StreamPoint[];
  hasHr: boolean;
  hasPower: boolean;
  hasSpeed: boolean;
  hasCadence: boolean;
  loading: boolean;
  units: UnitConverter;
  onHoverPosition?: (position: { lat: number; lng: number } | null) => void;
}) {
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean>>({});

  const handleLegendChange = useCallback((params: Record<string, unknown>) => {
    const raw = params.selected;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const selected: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "boolean") {
          selected[key] = value;
        }
      }
      setLegendSelected(selected);
    }
  }, []);

  const chartEvents = useMemo(
    () => ({
      ...(buildAxisPointerEvents(points, onHoverPosition) ?? {}),
      legendselectchanged: handleLegendChange,
    }),
    [points, onHoverPosition, handleLegendChange],
  );

  if (loading) return <ChartLoadingSkeleton height={300} />;
  if (points.length === 0) return null;

  const metrics: MetricDefinition[] = [];
  if (hasHr)
    metrics.push({
      name: "Heart Rate",
      axisName: "Heart Rate (bpm)",
      color: CHART_COLORS.heartRate,
      data: points.map((p) => p.heartRate),
    });
  if (hasPower)
    metrics.push({
      name: "Power",
      axisName: "Power (W)",
      color: CHART_COLORS.power,
      data: points.map((p) => p.power),
    });
  if (hasSpeed)
    metrics.push({
      name: "Speed",
      axisName: `Speed (${units.speedLabel})`,
      color: CHART_COLORS.speed,
      data: points.map((p) =>
        p.speed != null ? +formatNumber(units.convertSpeed(p.speed * 3.6)) : null,
      ),
    });
  if (hasCadence)
    metrics.push({
      name: "Cadence",
      axisName: "Cadence (rpm)",
      color: CHART_COLORS.cadence,
      data: points.map((p) => p.cadence),
    });

  const isVisible = (name: string) => legendSelected[name] !== false;

  const times = points.map((p) => p.recordedAt);
  const yAxes = metrics.map((metric, index) => {
    const visible = isVisible(metric.name);
    const isFirst = index === 0;
    const position = isFirst ? "left" : "right";
    const visibleRightBefore = metrics.slice(1, index).filter((m) => isVisible(m.name)).length;
    const firstVisibleIndex = metrics.findIndex((m) => isVisible(m.name));
    const showSplitLine = visible && index === firstVisibleIndex;

    return {
      ...dofekAxis.value({
        name: metric.axisName,
        min: "dataMin",
        max: "dataMax",
        position,
        showSplitLine,
        axisLabel: { color: metric.color },
      }),
      show: visible,
      offset: !isFirst && visibleRightBefore > 0 ? visibleRightBefore * 60 : 0,
    };
  });

  const series = metrics.map((metric, index) => ({
    name: metric.name,
    type: "line" as const,
    yAxisIndex: index,
    data: metric.data,
    showSymbol: false,
    lineStyle: { width: 1.5, color: metric.color },
    itemStyle: { color: metric.color },
  }));

  const visibleRightAxisCount = metrics.slice(1).filter((m) => isVisible(m.name)).length;

  const option = {
    grid: {
      top: 40,
      right: 60 + Math.max(0, visibleRightAxisCount - 1) * 60,
      bottom: 60,
      left: 60,
    },
    tooltip: dofekTooltip(),
    legend: { ...dofekLegend(true), selected: legendSelected },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, start: 0, end: 100 },
      {
        type: "slider",
        xAxisIndex: 0,
        start: 0,
        end: 100,
        height: 20,
        bottom: 10,
        borderColor: chartThemeColors.tooltipBorder,
        backgroundColor: chartThemeColors.tooltipBackground,
        fillerColor: `${statusColors.positive}26`,
        handleStyle: { color: statusColors.positive },
        textStyle: { color: chartThemeColors.axisLabel },
      },
    ],
    xAxis: dofekAxis.category({
      data: times,
      axisLabel: {
        formatter: (v: string) => {
          const date = new Date(v);
          return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
        },
      },
    }),
    yAxis: yAxes,
    series,
  };

  return <DofekChart option={option} height={350} onEvents={chartEvents} />;
}

function ElevationChart({
  points,
  loading,
  units,
  onHoverPosition,
}: {
  points: StreamPoint[];
  loading: boolean;
  units: UnitConverter;
  onHoverPosition?: (position: { lat: number; lng: number } | null) => void;
}) {
  const elevPoints = points.filter((p) => p.altitude != null);
  const chartEvents = useMemo(
    () => buildAxisPointerEvents(elevPoints, onHoverPosition),
    [elevPoints, onHoverPosition],
  );

  if (loading) return <ChartLoadingSkeleton height={200} />;
  if (elevPoints.length === 0) return null;

  const option = {
    grid: dofekGrid("single", { top: 10, right: 20, bottom: 30, left: 50 }),
    tooltip: dofekTooltip({
      formatter: (params: Array<{ value: number; dataIndex: number }>) => {
        const firstParam = params[0];
        if (!firstParam) return "";
        return `Elevation: ${Math.round(units.convertElevation(firstParam.value))} ${units.elevationLabel}`;
      },
    }),
    xAxis: dofekAxis.category({
      data: elevPoints.map((p) => p.recordedAt),
      axisLabel: {
        formatter: (v: string) => {
          const date = new Date(v);
          return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
        },
      },
    }),
    yAxis: dofekAxis.value({ name: `Elevation (${units.elevationLabel})` }),
    series: [
      {
        type: "line",
        data: elevPoints.map((p) =>
          p.altitude != null ? Math.round(units.convertElevation(p.altitude)) : null,
        ),
        showSymbol: false,
        lineStyle: { width: 1.5, color: CHART_COLORS.altitude },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(107,114,128,0.3)" },
              { offset: 1, color: "rgba(107,114,128,0.05)" },
            ],
          },
        },
      },
    ],
  };

  return <DofekChart option={option} height={200} onEvents={chartEvents} />;
}

export function HrZonesChart({ zones, loading }: { zones: ActivityHrZone[]; loading: boolean }) {
  if (loading) return <ChartLoadingSkeleton height={200} />;

  const totalSeconds = zones.reduce((sum, z) => sum + z.seconds, 0);
  if (totalSeconds === 0) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-dim text-sm">No heart rate zone data</span>
      </div>
    );
  }

  const formatTime = (secs: number) => {
    const minutes = Math.floor(secs / 60);
    const seconds = secs % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  };

  const option = {
    grid: dofekGrid("single", { top: 10, right: 80, bottom: 30, left: 100 }),
    tooltip: dofekTooltip({
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ name: string; value: number; dataIndex: number }>) => {
        const firstParam = params[0];
        if (!firstParam) return "";
        const zone = zones[firstParam.dataIndex];
        if (!zone) return "";
        const percentage =
          totalSeconds > 0 ? formatNumber((zone.seconds / totalSeconds) * 100) : "0";
        return `<b>${zone.label}</b> (${zone.minPct}–${zone.maxPct}% HRR)<br/>
          ${formatTime(zone.seconds)} (${percentage}%)`;
      },
    }),
    xAxis: dofekAxis.value({
      axisLabel: { formatter: (v: number) => formatTime(v) },
    }),
    yAxis: dofekAxis.category({
      data: zones.map((z) => `Z${z.zone} ${z.label}`),
    }),
    series: [
      {
        type: "bar",
        data: zones.map((z, i) => ({
          value: z.seconds,
          itemStyle: { color: HEART_RATE_ZONE_COLORS[i] ?? chartThemeColors.axisLabel },
        })),
        barWidth: "60%",
        label: {
          show: true,
          position: "right",
          color: chartThemeColors.axisLabel,
          fontSize: 11,
          formatter: (p: { value: number }) => {
            const percentage =
              totalSeconds > 0 ? formatNumber((p.value / totalSeconds) * 100, 0) : "0";
            return `${percentage}%`;
          },
        },
      },
    ],
  };

  return <DofekChart option={option} height={200} />;
}

function WorkoutMuscleMap({ exercises }: { exercises: StrengthExerciseDetail[] }) {
  // Lazy-load react-body-highlighter
  const [Model, setModel] = useState<typeof import("react-body-highlighter").default | null>(null);
  const [MuscleType, setMuscleType] = useState<
    typeof import("react-body-highlighter").MuscleType | null
  >(null);

  useEffect(() => {
    import("react-body-highlighter").then((mod) => {
      setModel(() => mod.default);
      setMuscleType(() => mod.MuscleType);
    });
  }, []);

  // Count sets per muscle group from this workout's exercises
  const slugTotals = new Map<string, number>();
  for (const exercise of exercises) {
    if (!exercise.muscleGroups) continue;
    for (const group of exercise.muscleGroups) {
      const slugs = expandMuscleGroup(group);
      const setsPerSlug = exercise.sets.length / slugs.length;
      for (const slug of slugs) {
        slugTotals.set(slug, (slugTotals.get(slug) ?? 0) + setsPerSlug);
      }
    }
  }

  const intensities = computeIntensities(slugTotals);
  if (intensities.size === 0 || !Model || !MuscleType) return null;

  type IExerciseData = import("react-body-highlighter").IExerciseData;
  type Muscle = import("react-body-highlighter").Muscle;
  const VALID_MUSCLES = new Set<string>(Object.values(MuscleType));
  const DELTOID_MUSCLES: Muscle[] = [MuscleType.FRONT_DELTOIDS, MuscleType.BACK_DELTOIDS];

  function isMuscle(value: string): value is Muscle {
    return VALID_MUSCLES.has(value);
  }

  const exerciseData: IExerciseData[] = [...intensities.entries()].flatMap(
    ([slug, intensity]): IExerciseData[] => {
      const bucket = intensityToBucket(intensity);
      if (bucket === 0) return [];
      if (slug === "deltoids") {
        return DELTOID_MUSCLES.map((muscle) => ({
          name: slug,
          muscles: [muscle],
          frequency: bucket,
        }));
      }
      if (!isMuscle(slug)) return [];
      return [{ name: slug, muscles: [slug], frequency: bucket }];
    },
  );

  // Build label list sorted by set count
  const labelList = [...slugTotals.entries()]
    .sort(([, countA], [, countB]) => countB - countA)
    .map(([slug, count]) => ({
      label: muscleGroupLabel(slug),
      sets: Math.round(count),
      intensity: intensities.get(slug) ?? 0,
    }));

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4 mb-4">
      <div className="flex gap-4">
        <div className="flex flex-col items-center">
          <span className="text-xs text-dim mb-1">Front</span>
          <Model
            data={exerciseData}
            style={{ width: "120px" }}
            type="anterior"
            highlightedColors={INTENSITY_COLORS}
            bodyColor="#e8ede7"
          />
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-dim mb-1">Back</span>
          <Model
            data={exerciseData}
            style={{ width: "120px" }}
            type="posterior"
            highlightedColors={INTENSITY_COLORS}
            bodyColor="#e8ede7"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {labelList.map(({ label, sets, intensity }) => (
          <span
            key={label}
            className="text-xs px-2 py-1 rounded"
            style={{
              backgroundColor: muscleGroupFillColor(intensity),
              color: intensity > 0.5 ? "#fff" : "#1a1a1a",
            }}
          >
            {label} ({sets})
          </span>
        ))}
      </div>
    </div>
  );
}

function StrengthExerciseBreakdown({
  exercises,
  units,
}: {
  exercises: StrengthExerciseDetail[];
  units: UnitConverter;
}) {
  return (
    <div className="space-y-4">
      {exercises.map((exercise) => {
        const hasWeight = exercise.sets.some((set) => set.weightKg != null);
        const hasReps = exercise.sets.some((set) => set.reps != null);
        const hasDuration = exercise.sets.some((set) => set.durationSeconds != null);
        const hasRpe = exercise.sets.some((set) => set.rpe != null);

        return (
          <div key={exercise.exerciseIndex}>
            <div className="flex items-baseline gap-2 mb-2">
              <h3 className="text-sm font-medium text-foreground">{exercise.exerciseName}</h3>
              {exercise.equipment && (
                <span className="text-xs text-subtle bg-accent/10 px-1.5 py-0.5 rounded">
                  {exercise.equipment.toLowerCase().replace(/_/g, " ")}
                </span>
              )}
              {exercise.muscleGroups?.map((group) => (
                <span
                  key={group}
                  className="text-xs text-subtle bg-surface-hover px-1.5 py-0.5 rounded"
                >
                  {group.toLowerCase()}
                </span>
              ))}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-subtle border-b border-surface-hover">
                  <th className="text-left py-1 pr-4 font-medium">Set</th>
                  {hasWeight && (
                    <th className="text-right py-1 px-4 font-medium">
                      Weight ({units.weightLabel})
                    </th>
                  )}
                  {hasReps && <th className="text-right py-1 px-4 font-medium">Reps</th>}
                  {hasDuration && <th className="text-right py-1 px-4 font-medium">Duration</th>}
                  {hasRpe && (
                    <th className="text-right py-1 pl-4 font-medium">Perceived Exertion (RPE)</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {exercise.sets.map((set) => (
                  <tr key={set.setIndex} className="border-b border-surface-hover/50">
                    <td className="py-1.5 pr-4 tabular-nums text-muted">{set.setIndex + 1}</td>
                    {hasWeight && (
                      <td className="text-right py-1.5 px-4 tabular-nums">
                        {set.weightKg != null
                          ? formatNumber(units.convertWeight(set.weightKg))
                          : "—"}
                      </td>
                    )}
                    {hasReps && (
                      <td className="text-right py-1.5 px-4 tabular-nums">{set.reps ?? "—"}</td>
                    )}
                    {hasDuration && (
                      <td className="text-right py-1.5 px-4 tabular-nums">
                        {set.durationSeconds != null ? `${set.durationSeconds}s` : "—"}
                      </td>
                    )}
                    {hasRpe && (
                      <td className="text-right py-1.5 pl-4 tabular-nums">{set.rpe ?? "—"}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
        <ChartDescriptionTooltip description={description} />
      </div>
      <div className="card p-4" title={description}>
        {children}
      </div>
    </section>
  );
}
