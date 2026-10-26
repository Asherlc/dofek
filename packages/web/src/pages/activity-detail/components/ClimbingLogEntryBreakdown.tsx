import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";
import { type ClimbingLogAttachmentState, ClimbingLogEntryCard } from "./ClimbingLogEntryCard.tsx";

export function ClimbingLogEntryBreakdown({
  entries,
  locations,
  selectedEntryId,
  attachmentStates,
  onAttach,
  label = "Attached climbing logs",
}: {
  entries: readonly ClimbingLogEntryDetail[];
  locations?: Readonly<Record<string, ClimbingMapLocation>>;
  selectedEntryId?: string | null;
  attachmentStates?: Readonly<Record<string, ClimbingLogAttachmentState>>;
  onAttach?: (entryId: string) => void;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] items-start gap-3"
    >
      {groupClimbingLogEntriesByArea(entries).map(({ area, entries: groupEntries }) => (
        <div key={area?.id ?? "unlocated"} className="contents">
          <ul aria-label={area ? `${area.name} climbs` : "Climbing logs"} className="contents">
            {groupEntries.map(({ entry, entryNumber }, index) => (
              <ClimbingLogEntryCard
                key={entry.id}
                entry={entry}
                entryNumber={entryNumber}
                location={locations?.[entry.id]}
                selected={entry.id === selectedEntryId}
                attachmentState={attachmentStates?.[entry.id]}
                onAttach={onAttach}
                heading={
                  index === 0 && area ? (
                    <h3 className="text-sm font-medium text-foreground">{area.name}</h3>
                  ) : null
                }
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
