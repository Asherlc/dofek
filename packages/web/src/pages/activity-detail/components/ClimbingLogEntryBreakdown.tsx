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
    <ul
      aria-label={label}
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3"
    >
      {entries.map((entry, index) => (
        <ClimbingLogEntryCard
          key={entry.id}
          entry={entry}
          entryNumber={index + 1}
          location={locations?.[entry.id]}
          selected={entry.id === selectedEntryId}
          attachmentState={attachmentStates?.[entry.id]}
          onAttach={onAttach}
        />
      ))}
    </ul>
  );
}
