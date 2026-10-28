import {
  formatDateMedium,
  formatDateShort,
  formatDateTime,
  formatDurationMinutes,
  formatPace,
  formatTimeOnly,
} from "@dofek/format/format";
import {
  type RouteComparison,
  resolveRouteComparisonSelection,
} from "@dofek/training/route-comparison";
import { useId, useState } from "react";
import {
  chartColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ActivityComparisonChartProps {
  data: RouteComparison[];
  loading?: boolean;
}

export function ActivityComparisonChart({ data, loading }: ActivityComparisonChartProps) {
  const units = useUnitConverter();
  const pickerId = useId();
  const [selectedRouteId, setSelectedRouteId] = useState(data[0]?.routeId);
  const selected = resolveRouteComparisonSelection(data, selectedRouteId);
  // Remember the surviving route so a removed selection cannot reappear on a later refresh.
  if (selectedRouteId !== selected?.routeId) setSelectedRouteId(selected?.routeId);

  if (!selected) {
    return (
      <div role={loading ? "status" : undefined}>
        {loading && <span className="sr-only">Loading routes</span>}
        <DofekChart
          option={{}}
          loading={loading}
          empty
          height={280}
          emptyMessage="No repeated GPS-matched routes in this period."
        />
      </div>
    );
  }

  const plottedAttempts = selected.instances.flatMap((attempt) =>
    attempt.averagePaceMinPerKm === null
      ? []
      : [{ ...attempt, pace: units.convertPace(attempt.averagePaceMinPerKm * 60) }],
  );
  const sameDay = selected.instances[0]?.date === selected.instances.at(-1)?.date;
  const paceText = (pace: number | null) =>
    pace === null
      ? "Pace unavailable"
      : `${formatPace(units.convertPace(pace * 60))} ${units.paceLabel}`;
  const distanceText = (distance: number | null) =>
    distance === null
      ? "Distance unavailable"
      : `${units.convertDistance(distance).toFixed(2)} ${units.distanceLabel}`;
  const routeLabel = (route: RouteComparison) => {
    const first = route.instances[0];
    const last = route.instances.at(-1);
    return [
      route.activityName,
      first ? distanceText(first.distanceKm) : null,
      `${route.attemptCount} attempts`,
      first && last ? `${formatDateMedium(first.date)} – ${formatDateMedium(last.date)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const option = {
    grid: dofekGrid("single", { top: 40, left: 8, right: 20, bottom: 8, containLabel: true }),
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { dataIndex: number }) => {
        const attempt = plottedAttempts[params.dataIndex];
        if (!attempt) return "";
        return [
          `<strong>${escapeTooltipHtml(attempt.activityName)}</strong>`,
          escapeTooltipHtml(formatDateTime(attempt.startedAt)),
          `Pace: ${escapeTooltipHtml(paceText(attempt.averagePaceMinPerKm))}`,
          `Distance: ${escapeTooltipHtml(distanceText(attempt.distanceKm))}`,
          `Duration: ${escapeTooltipHtml(formatDurationMinutes(attempt.durationMinutes))}`,
        ].join("<br/>");
      },
    }),
    xAxis: {
      ...dofekAxis.time({
        show: true,
        axisLabel: {
          hideOverlap: true,
          formatter: (value: number) =>
            sameDay
              ? `${formatTimeOnly(value)}\n${formatDateMedium(value)}`
              : `${formatDateShort(value)}\n${new Date(value).getFullYear()}`,
        },
      }),
      splitNumber: 3,
      boundaryGap: ["8%", "8%"],
    },
    yAxis: {
      ...dofekAxis.value(),
      inverse: true,
      scale: true,
      axisLabel: {
        ...dofekAxis.value().axisLabel,
        formatter: (value: number) => formatPace(value),
      },
    },
    series: [
      dofekSeries.scatter(
        selected.activityName,
        plottedAttempts.map((attempt) => ({
          id: attempt.activityId,
          value: [attempt.startedAt, attempt.pace],
        })),
        { color: chartColors.teal, symbolSize: 10 },
      ),
    ],
  };

  const attemptsDisclosure = (
    <details className="mt-3 text-xs text-subtle" key={selected.routeId}>
      <summary className="cursor-pointer font-medium text-foreground">
        View attempts ({selected.attemptCount})
      </summary>
      <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Attempts for {routeLabel(selected)}</caption>
          <thead className="sticky top-0 bg-surface">
            <tr>
              {["Started", "Activity", "Pace", "Distance", "Duration", "Heart rate", "Ascent"].map(
                (heading) => (
                  <th key={heading} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {selected.instances.map((attempt) => (
              <tr key={attempt.activityId} className="border-t border-border">
                <th scope="row" className="whitespace-nowrap px-3 py-2 font-normal">
                  <time dateTime={attempt.startedAt}>{formatDateTime(attempt.startedAt)}</time>
                </th>
                <td className="min-w-40 px-3 py-2">
                  <a
                    href={`/activity/${attempt.activityId}`}
                    className="text-accent underline underline-offset-2"
                    aria-label={`${attempt.activityName}, ${formatDateTime(attempt.startedAt)}`}
                  >
                    {attempt.activityName}
                  </a>
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {paceText(attempt.averagePaceMinPerKm)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {distanceText(attempt.distanceKm)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {formatDurationMinutes(attempt.durationMinutes)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {attempt.avgHeartRate === null
                    ? "Unavailable"
                    : `${Math.round(attempt.avgHeartRate)} bpm`}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {Math.round(units.convertElevation(attempt.elevationGainMeters))}{" "}
                  {units.elevationLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );

  return (
    <div className="min-w-0">
      <label htmlFor={pickerId} className="mb-1 block text-xs font-medium text-subtle">
        Route
      </label>
      <select
        id={pickerId}
        value={selected.routeId}
        title={routeLabel(selected)}
        onChange={(event) => setSelectedRouteId(event.currentTarget.value)}
        className="w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
      >
        {data.map((route) => (
          <option key={route.routeId} value={route.routeId}>
            {routeLabel(route)}
          </option>
        ))}
      </select>
      <p className="mt-2 text-xs text-dim">
        GPS-matched attempts · Pace (min{units.paceLabel}) · Faster pace is higher ↑
      </p>
      {plottedAttempts.length > 0 ? (
        <DofekChart
          option={option}
          height={280}
          timeRangeMode="data"
          dataDisclosure={attemptsDisclosure}
        />
      ) : (
        <>
          <p className="my-6 text-sm text-dim">
            No pace available for this route. View attempts for recorded details.
          </p>
          {attemptsDisclosure}
        </>
      )}
    </div>
  );
}
