import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { type ClimbingLogAttachmentState, ClimbingLogEntryCard } from "./ClimbingLogEntryCard";

interface ClimbingLogEntryBreakdownProps {
  entries: readonly ClimbingLogEntryDetail[];
  locations?: Readonly<Record<string, ClimbingMapLocation>>;
  attachmentStates?: Readonly<Record<string, ClimbingLogAttachmentState>>;
  onAttach?: (entryId: string) => void;
  selectedEntryId?: string | null;
}

export function ClimbingLogEntryBreakdown({
  entries,
  locations,
  attachmentStates,
  onAttach,
  selectedEntryId,
}: ClimbingLogEntryBreakdownProps) {
  const [columns, setColumns] = useState(1);
  const groups = groupClimbingLogEntriesByArea(entries).map((group) => ({
    ...group,
    span: Math.min(group.entries.length, columns),
  }));
  const areaRows: Array<typeof groups> = [];
  let row: typeof groups = [];
  let usedColumns = 0;
  for (const group of groups) {
    if (usedColumns + group.span > columns) {
      areaRows.push(row);
      row = [];
      usedColumns = 0;
    }
    row.push(group);
    usedColumns += group.span;
  }
  if (row.length > 0) areaRows.push(row);

  return (
    <View
      style={styles.groups}
      onLayout={({ nativeEvent }) =>
        setColumns(Math.max(1, Math.floor((nativeEvent.layout.width + 12) / (280 + 12))))
      }
    >
      {areaRows.map((areaRow) => (
        <View key={areaRow[0]?.entries[0]?.entry.id} style={styles.row}>
          {areaRow.map(({ area, entries: groupEntries, span: groupColumns }) => (
            <View
              key={area?.id ?? "unlocated"}
              accessibilityLabel={area?.name}
              style={[styles.group, { flexGrow: groupColumns, flexBasis: (groupColumns - 1) * 12 }]}
            >
              {area && (
                <Text accessibilityRole="header" style={styles.heading}>
                  {area.name}
                </Text>
              )}
              <View style={styles.grid}>
                {Array.from(
                  { length: Math.ceil(groupEntries.length / groupColumns) },
                  (_, rowIndex) => {
                    const rowEntries = groupEntries.slice(
                      rowIndex * groupColumns,
                      (rowIndex + 1) * groupColumns,
                    );
                    return (
                      <View key={rowEntries[0]?.entry.id} style={styles.row}>
                        {Array.from({ length: groupColumns }, (_, columnIndex) => {
                          const item = rowEntries[columnIndex];
                          return (
                            <View
                              key={item?.entry.id ?? `empty-${columnIndex}`}
                              style={styles.cell}
                            >
                              {item && (
                                <ClimbingLogEntryCard
                                  entry={item.entry}
                                  location={locations?.[item.entry.id]}
                                  attachmentState={attachmentStates?.[item.entry.id]}
                                  onAttach={onAttach}
                                  entryNumber={item.entryNumber}
                                  selected={item.entry.id === selectedEntryId}
                                />
                              )}
                            </View>
                          );
                        })}
                      </View>
                    );
                  },
                )}
              </View>
            </View>
          ))}
          {Array.from({ length: columns }, (_, columnIndex) => columnIndex + 1)
            .slice(areaRow.reduce((sum, group) => sum + group.span, 0))
            .map((column) => (
              <View key={`empty-column-${column}`} style={styles.cell} />
            ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  groups: { gap: 12 },
  group: { gap: 8, flexShrink: 1, minWidth: 0 },
  heading: { color: colors.text, fontSize: 14, fontWeight: "600", lineHeight: 20 },
  grid: { gap: 12 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  cell: { flex: 1, minWidth: 0 },
});
