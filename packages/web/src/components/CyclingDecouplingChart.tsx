import { formatDateMedium, formatDurationSeconds, formatSigned } from "@dofek/format/format";
import { surfaceColors } from "@dofek/scoring/colors";
import type { AppRouterOutputs } from "dofek-server/router";
import { useState } from "react";
import { chartThemeColors } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

type Decoupling = AppRouterOutputs["cycling"]["decoupling"];
type Half = Decoupling["rides"][number]["firstHalf"];
const title = "Power-to-heart-rate decoupling";
const sign = "Positive values mean power was lower relative to heart rate in the second half.";

function halfSummary(half: Half) {
  return `${half.meanWatts ?? "—"} W · ${half.meanBpm ?? "—"} bpm · ${half.coveragePct}% paired coverage`;
}

export function CyclingDecouplingChart({
  data,
  loading,
  error,
}: {
  data?: Decoupling;
  loading?: boolean;
  error?: unknown;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rides = data?.rides ?? [];
  const labelFor = (ride: Decoupling["rides"][number]) =>
    `${ride.name ?? data?.workoutName} · ${formatDateMedium(ride.date)} · ${formatSigned(ride.percent)}%`;
  const rowLabel = (ride: Decoupling["rides"][number], index: number) => {
    const label = labelFor(ride);
    const duplicate = rides.some(
      (other) => other.activityId !== ride.activityId && labelFor(other) === label,
    );
    return duplicate ? `${label} · Ride ${index + 1}` : label;
  };
  const selected = rides.find((ride) => ride.activityId === selectedId);
  const option = {
    useUTC: true,
    grid: { left: 48, right: 24, top: 16, bottom: 28 },
    xAxis: { type: "time", axisLabel: { color: chartThemeColors.axisLabel } },
    yAxis: {
      type: "value",
      axisLabel: { color: chartThemeColors.axisLabel, formatter: "{value}%" },
    },
    series: [
      {
        type: "scatter",
        name: data?.workoutName,
        itemStyle: { color: surfaceColors.accent, opacity: 1 },
        symbolSize: (_value: unknown, point: { dataIndex: number }) =>
          rides[point.dataIndex]?.activityId === selectedId ? 16 : 10,
        data: rides.map((ride) => [Date.parse(ride.date), ride.percent]),
      },
    ],
  };

  return (
    <section>
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wider text-muted">{title}</h2>
      <div className="card space-y-3 p-4">
        <p className="text-sm text-muted">
          How power relative to heart rate changed between halves of a ride.
        </p>
        {data && error ? <QueryStatePanel contextLabel={title} error={error} /> : null}
        {!data && error ? (
          <QueryStatePanel contextLabel={title} error={error} />
        ) : !data && loading ? (
          <QueryStatePanel contextLabel={title} variant="loading" />
        ) : rides.length === 0 ? (
          <QueryStatePanel variant="empty" message="No repeat rides in this date range" />
        ) : (
          <>
            <p className="text-sm">
              <strong>{data?.workoutName}</strong> · {rides.length} rides · Same workout template
            </p>
            <DofekChart
              option={option}
              timeRangeMode="data"
              onEvents={{
                click: (event) => {
                  if (typeof event?.dataIndex === "number") {
                    const ride = rides[event.dataIndex];
                    if (ride) setSelectedId(ride.activityId);
                  }
                },
              }}
              dataDisclosure={
                <details className="text-sm">
                  <summary className="cursor-pointer">View chart data</summary>
                  <ul className="mt-2 space-y-1">
                    {rides.map((ride, index) => (
                      <li key={ride.activityId}>
                        <button
                          type="button"
                          aria-pressed={selected?.activityId === ride.activityId}
                          className="rounded border border-border px-3 py-2 aria-pressed:border-teal-500"
                          onClick={() => setSelectedId(ride.activityId)}
                        >
                          {rowLabel(ride, index)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              }
            />
            <p className="text-xs text-muted">{sign}</p>
            {selected && (
              <section
                aria-label="Selected workout"
                aria-live="polite"
                className="space-y-2 rounded-lg border border-border p-3 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <a className="font-medium underline" href={`/activity/${selected.activityId}`}>
                    {selected.name ?? data?.workoutName}
                  </a>
                  <strong>{`${formatSigned(selected.percent)}%`}</strong>
                </div>
                <p>
                  {formatDateMedium(selected.date)} ·{" "}
                  {formatDurationSeconds(selected.elapsedSeconds)}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <p>First half · {halfSummary(selected.firstHalf)}</p>
                  <p>Second half · {halfSummary(selected.secondHalf)}</p>
                </div>
                <p className="text-xs text-muted">
                  Power ·{" "}
                  {selected.powerMeasurementKind === "direct"
                    ? "Direct measurement"
                    : "Measurement source unknown"}
                  . Heart rate ·{" "}
                  {selected.heartRateMeasurementKind === "direct"
                    ? "Direct measurement"
                    : "Measurement source unknown"}
                  .
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
