import { formatDateMedium, formatDurationSeconds, formatNumber } from "@dofek/format/format";
import { providerLabel } from "@dofek/providers/providers";
import type { AppRouterOutputs } from "dofek-server/router";

type CyclingProgression = NonNullable<AppRouterOutputs["trainingProgression"]["cycling"]>;
type Ride = CyclingProgression["rides"][number];

function RideEvidence({ ride }: { ride: Ride }) {
  return (
    <li className="space-y-1">
      <p className="font-medium">
        {ride.role === "selected" ? "Selected ride" : "Comparison ride"} ·{" "}
        {formatDateMedium(ride.date, { timeZone: "UTC" })}
      </p>
      <p className="text-muted">Session effort: {ride.sessionEffort}/10</p>
      <ul className="ml-4 space-y-1">
        {ride.intervals.map((interval) => (
          <li key={interval.index}>
            Work {interval.index}:{" "}
            {formatDurationSeconds(interval.workDurationSeconds, { precision: "second" })} at{" "}
            {formatNumber(interval.meanPowerWatts, 0)} W
            {interval.sourceProvider ? ` · ${providerLabel(interval.sourceProvider)}` : ""}
          </li>
        ))}
      </ul>
      {ride.powerProvenance.providers.length > 0 ? (
        <p className="text-muted">
          Measured power: {ride.powerProvenance.providers.map(providerLabel).join(", ")}
        </p>
      ) : null}
    </li>
  );
}

/** Both comparable rides behind a native disclosure; whole-ride effort stays separate. */
export function CyclingProgressionEvidence({ result }: { result: CyclingProgression }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-accent">See interval evidence</summary>
      <ul className="mt-2 space-y-2 text-muted">
        {result.rides.map((ride) => (
          <RideEvidence key={ride.activityId} ride={ride} />
        ))}
      </ul>
    </details>
  );
}
