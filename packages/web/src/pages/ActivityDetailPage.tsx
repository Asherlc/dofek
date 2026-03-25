import { formatActivityTypeLabel } from "@dofek/training/training";
import type { ActivityHrZone } from "@dofek/zones/zones";
import { HEART_RATE_ZONE_COLORS } from "@dofek/zones/zones";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { ActivityDetail, StreamPoint } from "../../../server/src/routers/activity.ts";
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
import { formatNumber } from "../lib/format.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import type { UnitConverter } from "../lib/units.ts";

const CHART_COLORS = {
  heartRate: "#ef4444",
  power: "#f59e0b",
  speed: "#3b82f6",
  cadence: "#8b5cf6",
  altitude: "#6b7280",
};

export function ActivityDetailPage() {
  const { id } = useParams({ from: "/activity/$id" });

  const units = useUnitConverter();
  const detail = trpc.activity.byId.useQuery({ id });
  const stream = trpc.activity.stream.useQuery({ id, maxPoints: 500 });
  const hrZones = trpc.activity.hrZones.useQuery({ id });

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
      <div className="flex items-center gap-2 text-xs text-subtle">
        <Link to="/dashboard" className="hover:text-foreground">
          Dashboard
        </Link>
        <span>/</span>
        <span className="text-foreground">{activity.name ?? activity.activityType}</span>
      </div>

      <ActivityHeader activity={activity} units={units} />

      {hasGps && (
        <Section
          title="Route Map"
          description="This map shows your recorded route, including start and finish locations."
        >
          <RouteMap points={points} />
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
          />
        </Section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {hasAltitude && (
          <Section
            title="Elevation Profile"
            description="This chart shows how your elevation changed over time during the activity."
          >
            <ElevationChart points={points} loading={stream.isLoading} units={units} />
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

function ActivityHeader({ activity, units }: { activity: ActivityDetail; units: UnitConverter }) {
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
  if (activity.calories != null)
    stats.push({ label: "Calories", value: `${Math.round(activity.calories)} kcal` });
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
      <p className="text-sm text-subtle mb-4">
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

function RouteMap({ points }: { points: StreamPoint[] }) {
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
        color: "#22c55e",
        weight: 3,
        opacity: 0.8,
      }).addTo(map);

      // Start and end markers
      const startLatLng = latLngs[0];
      const endLatLng = latLngs[latLngs.length - 1];
      if (startLatLng) {
        L.circleMarker(startLatLng, {
          radius: 6,
          color: "#22c55e",
          fillColor: "#22c55e",
          fillOpacity: 1,
        }).addTo(map);
      }
      if (endLatLng) {
        L.circleMarker(endLatLng, {
          radius: 6,
          color: "#ef4444",
          fillColor: "#ef4444",
          fillOpacity: 1,
        }).addTo(map);
      }

      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: [30, 30] });
    });

    return () => {
      cancelled = true;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [points]);

  return <div ref={mapRef} className="w-full h-[400px] rounded-lg" />;
}

function MetricsChart({
  points,
  hasHr,
  hasPower,
  hasSpeed,
  hasCadence,
  loading,
  units,
}: {
  points: StreamPoint[];
  hasHr: boolean;
  hasPower: boolean;
  hasSpeed: boolean;
  hasCadence: boolean;
  loading: boolean;
  units: UnitConverter;
}) {
  if (loading) return <ChartLoadingSkeleton height={300} />;
  if (points.length === 0) return null;

  const times = points.map((p) => p.recordedAt);
  const yAxes: Array<Record<string, unknown>> = [];
  const series: Array<Record<string, unknown>> = [];
  let axisIndex = 0;

  if (hasHr) {
    yAxes.push(
      dofekAxis.value({
        name: "Heart Rate (bpm)",
        position: "left",
        showSplitLine: axisIndex === 0,
        axisLabel: { color: CHART_COLORS.heartRate },
      }),
    );
    series.push({
      name: "Heart Rate",
      type: "line",
      yAxisIndex: axisIndex,
      data: points.map((p) => p.heartRate),
      showSymbol: false,
      lineStyle: { width: 1.5, color: CHART_COLORS.heartRate },
      itemStyle: { color: CHART_COLORS.heartRate },
    });
    axisIndex++;
  }

  if (hasPower) {
    yAxes.push(
      dofekAxis.value({
        name: "Power (W)",
        position: axisIndex === 0 ? "left" : "right",
        showSplitLine: axisIndex === 0,
        axisLabel: { color: CHART_COLORS.power },
      }),
    );
    series.push({
      name: "Power",
      type: "line",
      yAxisIndex: axisIndex,
      data: points.map((p) => p.power),
      showSymbol: false,
      lineStyle: { width: 1.5, color: CHART_COLORS.power },
      itemStyle: { color: CHART_COLORS.power },
    });
    axisIndex++;
  }

  if (hasSpeed) {
    yAxes.push({
      ...dofekAxis.value({
        name: `Speed (${units.speedLabel})`,
        position: axisIndex === 0 ? "left" : "right",
        showSplitLine: axisIndex === 0,
        axisLabel: { color: CHART_COLORS.speed },
      }),
      offset: axisIndex > 1 ? (axisIndex - 1) * 60 : 0,
    });
    series.push({
      name: "Speed",
      type: "line",
      yAxisIndex: axisIndex,
      data: points.map((p) =>
        p.speed != null ? +formatNumber(units.convertSpeed(p.speed * 3.6)) : null,
      ),
      showSymbol: false,
      lineStyle: { width: 1.5, color: CHART_COLORS.speed },
      itemStyle: { color: CHART_COLORS.speed },
    });
    axisIndex++;
  }

  if (hasCadence) {
    yAxes.push({
      ...dofekAxis.value({
        name: "Cadence (rpm)",
        position: axisIndex === 0 ? "left" : "right",
        showSplitLine: axisIndex === 0,
        axisLabel: { color: CHART_COLORS.cadence },
      }),
      offset: axisIndex > 1 ? (axisIndex - 1) * 60 : 0,
    });
    series.push({
      name: "Cadence",
      type: "line",
      yAxisIndex: axisIndex,
      data: points.map((p) => p.cadence),
      showSymbol: false,
      lineStyle: { width: 1.5, color: CHART_COLORS.cadence },
      itemStyle: { color: CHART_COLORS.cadence },
    });
    axisIndex++;
  }

  const rightAxisCount = yAxes.filter((_, i) => i > 0).length;

  const option = {
    grid: { top: 40, right: 60 + Math.max(0, rightAxisCount - 1) * 60, bottom: 60, left: 60 },
    tooltip: dofekTooltip(),
    legend: dofekLegend(true),
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
        fillerColor: "rgba(34,197,94,0.15)",
        handleStyle: { color: "#22c55e" },
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

  return <DofekChart option={option} height={350} />;
}

function ElevationChart({
  points,
  loading,
  units,
}: {
  points: StreamPoint[];
  loading: boolean;
  units: UnitConverter;
}) {
  if (loading) return <ChartLoadingSkeleton height={200} />;

  const elevPoints = points.filter((p) => p.altitude != null);
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

  return <DofekChart option={option} height={200} />;
}

function HrZonesChart({ zones, loading }: { zones: ActivityHrZone[]; loading: boolean }) {
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
