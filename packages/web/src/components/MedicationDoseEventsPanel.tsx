import { formatDateTime } from "@dofek/format/format";
import { z } from "zod";
import { trpc } from "../lib/trpc.ts";

const medicationDoseEventSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  medicationName: z.string(),
  medicationConceptId: z.string().nullable(),
  doseStatus: z.string(),
  recordedAt: z.string(),
  sourceName: z.string().nullable(),
});

function formatDoseStatus(status: string): string {
  const normalized = status.trim();
  if (normalized.length === 0) return "Unknown";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

export function MedicationDoseEventsPanel() {
  const doseEvents = trpc.medicationDoseEvents.list.useQuery({ limit: 50 });

  if (doseEvents.isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((index) => (
          <div key={index} className="h-12 rounded bg-skeleton animate-pulse" />
        ))}
      </div>
    );
  }

  if (doseEvents.error) {
    return <p className="text-sm text-red-400">{doseEvents.error.message}</p>;
  }

  const events = z.array(medicationDoseEventSchema).parse(doseEvents.data?.events ?? []);
  if (events.length === 0) {
    return <p className="text-sm text-subtle">No medication dose events yet.</p>;
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
