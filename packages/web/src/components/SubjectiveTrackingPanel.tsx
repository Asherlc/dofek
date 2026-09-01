import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export function SubjectiveTrackingPanel() {
  const injuries = trpc.subjective.injuries.useQuery();

  return (
    <div className="card p-4 space-y-3">
      <h3 className="font-medium">Injury and niggle timeline</h3>
      {injuries.isLoading && injuries.data === undefined ? (
        <QueryStatePanel variant="loading" contextLabel="Injury events" height={96} />
      ) : injuries.error && injuries.data === undefined ? (
        <QueryStatePanel error={injuries.error} contextLabel="Injury events" height={96} />
      ) : injuries.data?.length ? (
        <ul className="space-y-1 text-sm">
          {injuries.data.map((injury) => (
            <li key={injury.id}>
              {injury.kind} · {injury.description} ·{" "}
              {injury.severity == null ? "Severity not recorded" : `${injury.severity}/10`} ·{" "}
              {injury.onset_date}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-dim">No injury events logged.</p>
      )}
    </div>
  );
}
