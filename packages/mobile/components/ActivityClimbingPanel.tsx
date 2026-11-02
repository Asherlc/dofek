import { climbingLogEntryName } from "@dofek/training/climbing-log";
import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import {
  type ComponentProps,
  type ComponentRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { type ClimbingLogAttachmentState, ClimbingLogEntryCard } from "./ClimbingLogEntryCard";
import { RouteMap } from "./RouteMap";

const NO_POINTS: ComponentProps<typeof RouteMap>["points"] = [];
const NO_ENTRIES: readonly ClimbingLogEntryDetail[] = [];

export function ActivityClimbingPanel({
  entries,
  suggestions = NO_ENTRIES,
  attachmentStates,
  onAttach,
  locations,
  points = NO_POINTS,
  hoveredPosition,
  onOpenEntry,
  onSelectEntry,
  selectedEntryId: controlledSelectedEntryId,
}: {
  entries: readonly ClimbingLogEntryDetail[];
  suggestions?: readonly ClimbingLogEntryDetail[];
  attachmentStates?: Readonly<Record<string, ClimbingLogAttachmentState>>;
  onAttach?: (entryId: string) => void;
  locations: Readonly<Record<string, ClimbingMapLocation>>;
  points?: ComponentProps<typeof RouteMap>["points"];
  hoveredPosition?: ComponentProps<typeof RouteMap>["hoveredPosition"];
  onOpenEntry?: (entryId: string) => void;
  onSelectEntry?: (entryId: string | null) => void;
  selectedEntryId?: string | null;
}) {
  const [localSelectedEntryId, selectEntry] = useState<string | null>(null);
  const selectedEntryId =
    controlledSelectedEntryId === undefined ? localSelectedEntryId : controlledSelectedEntryId;
  const selectedSection = entries.some((entry) => entry.id === selectedEntryId)
    ? "attached"
    : suggestions.some((entry) => entry.id === selectedEntryId)
      ? "unattached"
      : null;
  const listRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const rowPositions = useRef(new Map<string, { y: number; height: number; section: string }>());
  const pendingReveal = useRef<string | null>(null);
  const viewportHeight = useRef(0);
  const scrollOffset = useRef(0);
  const revealEntry = useCallback(
    (entryId: string | null) => {
      const row = entryId === null ? undefined : rowPositions.current.get(entryId);
      if (!row || viewportHeight.current === 0) return;
      if (entryId === selectedEntryId && row.section !== selectedSection) return;
      const visibleTop = scrollOffset.current;
      const visibleBottom = visibleTop + viewportHeight.current;
      if (row.y < visibleTop) listRef.current?.scrollTo({ y: row.y, animated: false });
      else if (row.y + row.height > visibleBottom)
        listRef.current?.scrollTo({
          y: Math.min(row.y, row.y + row.height - viewportHeight.current),
          animated: false,
        });
      pendingReveal.current = null;
    },
    [selectedEntryId, selectedSection],
  );
  useEffect(() => {
    pendingReveal.current = selectedEntryId;
    revealEntry(selectedEntryId);
  }, [selectedEntryId, revealEntry]);
  const handleSelectEntry = (entryId: string) => {
    selectEntry(entryId);
    onSelectEntry?.(entryId);
    pendingReveal.current = entryId;
    revealEntry(entryId);
  };
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
    <View style={styles.panel}>
      <RouteMap
        points={points}
        climbMarkers={markers}
        selectedEntryId={selectedEntryId}
        onSelectEntry={handleSelectEntry}
        hoveredPosition={hoveredPosition}
      />
      <ScrollView
        ref={listRef}
        accessibilityLabel="Climb list"
        nestedScrollEnabled
        style={styles.list}
        contentContainerStyle={styles.group}
        onLayout={({ nativeEvent: { layout } }) => {
          viewportHeight.current = layout.height;
          if (pendingReveal.current !== null) revealEntry(pendingReveal.current);
        }}
        onScroll={({ nativeEvent }) => {
          scrollOffset.current = nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
      >
        {sections
          .filter((section) => section.entries.length > 0)
          .flatMap((section) => [
            ...(section.key === "unattached"
              ? [
                  <Text key="unattached" accessibilityRole="header" style={styles.heading}>
                    Unattached
                  </Text>,
                ]
              : []),
            ...groupClimbingLogEntriesByArea(section.entries).flatMap(
              ({ area, entries: groupEntries }) => [
                <Text
                  key={`${section.key}-${area?.id ?? "unlocated"}`}
                  accessibilityRole="header"
                  style={styles.heading}
                >
                  {area?.name ?? "Other climbs"}
                </Text>,
                ...groupEntries.map(({ entry, entryNumber }) => (
                  <View
                    key={entry.id}
                    onLayout={({ nativeEvent: { layout } }) => {
                      rowPositions.current.set(entry.id, {
                        y: layout.y,
                        height: layout.height,
                        section: section.key,
                      });
                      if (entry.id === pendingReveal.current) revealEntry(entry.id);
                    }}
                  >
                    <ClimbingLogEntryCard
                      entry={entry}
                      entryNumber={entryNumber + section.offset}
                      location={locations[entry.id]}
                      attachmentState={attachmentStates?.[entry.id]}
                      onAttach={section.onAttach}
                      hideMap
                      selected={entry.id === selectedEntryId}
                      onSelect={() => handleSelectEntry(entry.id)}
                      onOpenEntry={onOpenEntry ? () => onOpenEntry(entry.id) : undefined}
                    />
                  </View>
                )),
              ],
            ),
          ])}
        {entries.length === 0 && suggestions.length === 0 && (
          <Text style={styles.heading}>No climbing logs attached to this activity.</Text>
        )}
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { gap: 16, minWidth: 0 },
  list: { maxHeight: 560 },
  group: { gap: 8 },
  heading: { fontSize: 14, fontWeight: "600", color: colors.text },
});
