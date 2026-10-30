import { climbingLogEntryName } from "@dofek/training/climbing-log";
import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { type ComponentProps, useMemo, useRef, useState } from "react";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";
import { ActivityRouteMap } from "../../../components/ActivityRouteMap.tsx";
import { type ClimbingLogAttachmentState, ClimbingLogEntryCard } from "./ClimbingLogEntryCard.tsx";

const NO_POINTS: { lat: number; lng: number }[] = [];

const NO_ENTRIES: readonly ClimbingLogEntryDetail[] = [];

export function ActivityClimbingPanel({
  entries,
  suggestions = NO_ENTRIES,
  attachmentStates,
  onAttach,
  locations,
  points = NO_POINTS,
  onRegisterHoverCallback,
  onOpenEntry,
}: {
  entries: readonly ClimbingLogEntryDetail[];
  suggestions?: readonly ClimbingLogEntryDetail[];
  attachmentStates?: Readonly<Record<string, ClimbingLogAttachmentState>>;
  onAttach?: (entryId: string) => void;
  locations: Readonly<Record<string, ClimbingMapLocation>>;
  points?: ComponentProps<typeof ActivityRouteMap>["points"];
  onRegisterHoverCallback?: ComponentProps<typeof ActivityRouteMap>["onRegisterHoverCallback"];
  onOpenEntry?: (entryId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedEntryId, selectEntry] = useState<string | null>(null);
  const [highlights, highlightEntry] = useState<{ pointer: string | null; focus: string | null }>({
    pointer: null,
    focus: null,
  });
  const markers = useMemo(
    () =>
      [...entries, ...suggestions].flatMap((entry, index) => {
        const location = locations[entry.id];
        return location
          ? [
              {
                entryId: entry.id,
                entryNumber: index + 1,
                label: climbingLogEntryName(entry),
                location,
              },
            ]
          : [];
      }),
    [entries, suggestions, locations],
  );

  const sections = [
    { key: "attached", label: "Attached climbing logs", entries, offset: 0, onAttach: undefined },
    {
      key: "unattached",
      label: "Unattached climbing logs",
      entries: suggestions,
      offset: entries.length,
      onAttach,
    },
  ];
  return (
    <div className="@container">
      <section
        aria-label="Activity climbs and locations"
        className="grid min-w-0 gap-4 @min-[760px]:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]"
      >
        <div
          ref={listRef}
          className="order-2 min-w-0 space-y-4 @min-[760px]:order-1 @min-[760px]:max-h-[560px] @min-[760px]:overflow-y-auto @min-[760px]:pr-2"
        >
          {sections
            .filter((section) => section.entries.length > 0)
            .map((section) => (
              <section key={section.key} aria-label={section.label} className="space-y-4">
                {section.key === "unattached" && (
                  <h3 className="text-sm font-semibold text-muted">Unattached</h3>
                )}
                {groupClimbingLogEntriesByArea(section.entries).map(
                  ({ area, entries: groupEntries }) => (
                    <div key={area?.id ?? "unlocated"} className="space-y-2">
                      <h3 className="text-sm font-semibold text-foreground">
                        {area?.name ?? "Other climbs"}
                      </h3>
                      <ul aria-label={`${area?.name ?? "Other"} climbs`} className="space-y-2">
                        {groupEntries.map(({ entry, entryNumber }) => (
                          <ClimbingLogEntryCard
                            key={entry.id}
                            entry={entry}
                            entryNumber={entryNumber + section.offset}
                            location={locations[entry.id]}
                            attachmentState={attachmentStates?.[entry.id]}
                            onAttach={section.onAttach}
                            hideMap
                            selected={entry.id === selectedEntryId}
                            onSelect={() => selectEntry(entry.id)}
                            onHighlight={(active, interaction) =>
                              highlightEntry((previous) => ({
                                ...previous,
                                [interaction]: active ? entry.id : null,
                              }))
                            }
                            onOpenEntry={onOpenEntry ? () => onOpenEntry(entry.id) : undefined}
                          />
                        ))}
                      </ul>
                    </div>
                  ),
                )}
              </section>
            ))}
          {entries.length === 0 && suggestions.length === 0 && (
            <p className="text-sm text-muted">No climbing logs attached to this activity.</p>
          )}
        </div>
        <div className="order-1 min-w-0 @min-[760px]:order-2">
          <ActivityRouteMap
            points={points}
            climbMarkers={markers}
            selectedEntryId={selectedEntryId}
            highlightedEntryId={highlights.pointer ?? highlights.focus}
            onSelectEntry={(entryId) => {
              selectEntry(entryId);
              const control = Array.from(
                listRef.current?.querySelectorAll<HTMLButtonElement>(
                  "button[data-climb-entry-id]",
                ) ?? [],
              ).find((button) => button.dataset.climbEntryId === entryId);
              control?.focus();
            }}
            onRegisterHoverCallback={onRegisterHoverCallback}
          />
        </div>
      </section>
    </div>
  );
}
