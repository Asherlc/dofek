import { formatDateTime } from "@dofek/format/format";
import { formatDoseStatus, medicationDoseEventSchema } from "@dofek/format/medication-dose-events";
import { z } from "zod";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export function MedicationDoseEventsPanel() {
  const doseEvents = trpc.medicationDoseEvents.list.useQuery({ limit: 50 });

  if (doseEvents.isLoading) {
    return <QueryStatePanel variant="loading" height={96} />;
  }

  if (doseEvents.error) {
    return <QueryStatePanel error={doseEvents.error} height={96} />;
  }

  const events = z.array(medicationDoseEventSchema).parse(doseEvents.data?.events ?? []);
  if (events.length === 0) {
    return <QueryStatePanel variant="empty" height={96} message="No medication dose events yet." />;
  }

  return (
    <ul className="divide-y divide-border">
      {events.map((event) => (
        <li key={event.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{event.medicationName}</p>
              <p className="mt-1 text-xs text-muted">
                {formatDateTime(new Date(event.recordedAt))}
              </p>
            </div>
            <span className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-subtle">
              {formatDoseStatus(event.doseStatus)}
            </span>
          </div>
          {event.sourceName ? <p className="mt-2 text-xs text-muted">{event.sourceName}</p> : null}
        </li>
      ))}
    </ul>
  );
}
