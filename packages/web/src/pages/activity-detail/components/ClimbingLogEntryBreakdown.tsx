import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { useLayoutEffect, useRef, useState } from "react";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";
import { type ClimbingLogAttachmentState, ClimbingLogEntryCard } from "./ClimbingLogEntryCard.tsx";

const MIN_CLIMB_WIDTH = 260;
const CLIMB_GAP = 12;

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
  const containerRef = useRef<HTMLElement>(null);
  const [columnCount, setColumnCount] = useState(1);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateColumns = (width: number) =>
      setColumnCount(Math.max(1, Math.floor((width + CLIMB_GAP) / (MIN_CLIMB_WIDTH + CLIMB_GAP))));
    updateColumns(container.getBoundingClientRect().width);
    const observer = new ResizeObserver((observations) => {
      for (const observation of observations) updateColumns(observation.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={containerRef}
      aria-label={label}
      className="grid items-start"
      style={{
        gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
        gap: CLIMB_GAP,
      }}
    >
      {groupClimbingLogEntriesByArea(entries).map(({ area, areaPath, entries: groupEntries }) => {
        const span = Math.min(groupEntries.length, columnCount);
        const areaNames = areaPath.map((node) => node.name);
        return (
          <div
            key={area?.id ?? "unlocated"}
            className="min-w-0 space-y-2"
            style={{ gridColumn: `span ${span}` }}
          >
            {area && (
              <section
                className="overflow-x-auto whitespace-nowrap text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                tabIndex={0}
                aria-label={`Area: ${areaNames.join(" › ")}`}
              >
                <h3 aria-label={`Area: ${areaNames.join(" › ")}`}>
                  {areaNames.length > 1 && (
                    <span className="text-muted">{areaNames.slice(0, -1).join(" › ")} › </span>
                  )}
                  <span className="font-semibold text-foreground">{area.name}</span>
                </h3>
              </section>
            )}
            <ul
              aria-label={area ? `${area.name} climbs` : "Climbing logs"}
              className="grid"
              style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))`, gap: CLIMB_GAP }}
            >
              {groupEntries.map(({ entry, entryNumber }) => (
                <ClimbingLogEntryCard
                  key={entry.id}
                  entry={entry}
                  entryNumber={entryNumber}
                  location={locations?.[entry.id]}
                  selected={entry.id === selectedEntryId}
                  attachmentState={attachmentStates?.[entry.id]}
                  onAttach={onAttach}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
