import { formatDateShort, formatNumber } from "@dofek/format/format";
import {
  type SportVolumeMetric,
  sportVolumeMetricSchema,
  sportVolumeMetrics,
} from "@dofek/training/sport-volume";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { chartColors, dofekAxis, dofekGrid, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import type { TimeRangeDays } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { DofekChart } from "./DofekChart.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export function SportVolumeChart({ days, sport }: { days: TimeRangeDays; sport?: string }) {
  const [selectedSport, setSelectedSport] = useState<string>();
  const [metric, setMetric] = useState<SportVolumeMetric>("time");
  const units = useUnitConverter();
  const query = trpc.training.sportVolume.useQuery(
    { days, sport: sport ?? selectedSport, metric },
    { placeholderData: keepPreviousData },
  );
  const data = query.data;
  const currentSport = sport ?? selectedSport ?? data?.sport ?? "";
  const metrics = sportVolumeMetrics(currentSport);
  const unit =
    data?.unit === "km"
      ? units.distanceLabel
      : data?.unit === "m"
        ? units.elevationLabel
        : (data?.unit ?? "min");
  const points = (data?.weeks ?? []).map((row) => [
    row.week,
    row.value == null
      ? null
      : data?.unit === "km"
        ? units.convertDistance(row.value)
        : data?.unit === "m"
          ? units.convertElevation(row.value)
          : row.value,
  ]);
  const plotLabel =
    sportVolumeMetrics(data?.sport ?? currentSport).find((entry) => entry.key === data?.metric)
      ?.label ?? "Time";
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">
        {data?.sport ? `${formatActivityTypeLabel(data.sport)} Volume` : "Weekly Volume"}
      </h3>
      <div className="mb-3 flex flex-wrap gap-4">
        {sport === undefined && data?.sports.length ? (
          <label className="text-sm text-muted">
            Activity type{" "}
            <select
              aria-label="Volume activity type"
              className="rounded border border-border bg-surface px-2 py-2"
              value={currentSport}
              onChange={(event) => {
                setSelectedSport(event.target.value);
                setMetric("time");
              }}
            >
              {data.sports.map((entry) => (
                <option key={entry} value={entry}>
                  {formatActivityTypeLabel(entry)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div>
          <select
            aria-label="Volume metric"
            className="min-h-11 cursor-pointer rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            value={metric}
            onChange={(event) => {
              if (sport === undefined && selectedSport === undefined && data?.sport)
                setSelectedSport(data.sport);
              setMetric(sportVolumeMetricSchema.parse(event.target.value));
            }}
          >
            {metrics.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {query.isFetching && data ? (
        <p role="status" className="text-xs text-muted">
          Updating volume…
        </p>
      ) : null}
      {query.error ? <QueryStatePanel error={query.error} height={0} /> : null}
      {query.error && !data ? null : (
        <>
          {data?.weeks.some((row) => row.value === null) ? (
            <p className="text-xs text-muted">Weeks with incomplete records are not plotted.</p>
          ) : null}
          <DofekChart
            option={{
              grid: dofekGrid("single", { left: 65, top: 40 }),
              tooltip: dofekTooltip(),
              xAxis: dofekAxis.time({
                show: true,
                axisLabel: {
                  show: true,
                  formatter: (value: number) => formatDateShort(new Date(value).toISOString()),
                },
              }),
              yAxis: dofekAxis.value({
                name: `${plotLabel} (${unit})`,
                axisLabel: { formatter: (value: number) => formatNumber(value) },
              }),
              series: [
                dofekSeries.bar(`${plotLabel} (${unit})`, points, { color: chartColors.emerald }),
              ],
            }}
            loading={query.isLoading}
            empty={data?.weeks.length === 0}
            emptyMessage="No volume data for this period"
            height={280}
          />
        </>
      )}
    </section>
  );
}
