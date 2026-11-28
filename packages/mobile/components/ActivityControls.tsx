import { ACTIVITY_AGENDA_RANGES, type ActivityAgendaPreset } from "@dofek/format/activity-agenda";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, Text, TouchableOpacity, View } from "react-native";
import { styles } from "./activities.styles";

const ALL_ACTIVITY_TYPES = "all";

export interface ActivityControlsProps {
  activityTypes: string[];
  activityType: string;
  preset: ActivityAgendaPreset;
  searching: boolean;
  canSelect: boolean;
  selectMode: boolean;
  selectedCount: number;
  deletePending: boolean;
  mergePending: boolean;
  mergeEligible: boolean;
  mixedTypes: boolean;
  onActivityTypeChange: (activityType: string) => void;
  onPresetChange: (preset: ActivityAgendaPreset) => void;
  onSelect: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
  onMergeSelected: () => void;
}

export function ActivityControls({
  activityTypes,
  activityType,
  preset,
  searching,
  canSelect,
  selectMode,
  selectedCount,
  deletePending,
  mergePending,
  mergeEligible,
  mixedTypes,
  onActivityTypeChange,
  onPresetChange,
  onSelect,
  onCancelSelection,
  onDeleteSelected,
  onMergeSelected,
}: ActivityControlsProps) {
  const selectedCountLabel = `${selectedCount} ${
    selectedCount === 1 ? "activity" : "activities"
  } selected`;

  const [openFilter, setOpenFilter] = useState<"range" | "sport">();
  const selectedRange = ACTIVITY_AGENDA_RANGES.find((option) => option.preset === preset);
  const selectedSport =
    activityType === ALL_ACTIVITY_TYPES ? "All activities" : formatActivityTypeLabel(activityType);
  const toggleFilter = (filter: "range" | "sport") =>
    setOpenFilter((current) => (current === filter ? undefined : filter));

  useEffect(() => {
    if (selectMode && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(selectedCountLabel);
    }
  }, [selectMode, selectedCountLabel]);

  return (
    <View style={styles.controlsPanel}>
      {canSelect && !selectMode ? (
        <View style={styles.controlsHeader}>
          <TouchableOpacity
            style={styles.selectButton}
            onPress={onSelect}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Select activities"
            accessibilityHint="Choose activities to merge or delete"
          >
            <Text style={styles.selectButtonText}>Select activities</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {canSelect && selectMode ? (
        <Text style={styles.selectionGuidance}>Choose activities to merge or delete.</Text>
      ) : null}
      {selectMode ? (
        <View style={styles.bulkActionRow}>
          <Text style={styles.selectedCount} accessibilityLiveRegion="polite">
            {selectedCountLabel}
          </Text>
          <TouchableOpacity
            style={[
              styles.deleteSelectionButton,
              !mergeEligible || mergePending ? styles.disabledAction : null,
            ]}
            onPress={onMergeSelected}
            disabled={!mergeEligible || mergePending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Merge selected activities"
            accessibilityState={{ busy: mergePending, disabled: !mergeEligible || mergePending }}
          >
            <Text style={styles.deleteSelectionButtonText}>
              {mergePending ? "Merging..." : "Merge"}
            </Text>
          </TouchableOpacity>
          {mixedTypes ? (
            <Text style={styles.selectionGuidance}>Select activities of one type to merge.</Text>
          ) : null}
          <TouchableOpacity
            style={[
              styles.deleteSelectionButton,
              selectedCount === 0 ? styles.disabledAction : null,
            ]}
            onPress={onDeleteSelected}
            disabled={selectedCount === 0 || deletePending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Delete selected activities"
            accessibilityState={{
              busy: deletePending,
              disabled: selectedCount === 0 || deletePending,
            }}
          >
            <Text style={styles.deleteSelectionButtonText}>
              {deletePending ? "Deleting..." : "Delete"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cancelSelectionButton}
            onPress={onCancelSelection}
            disabled={deletePending || mergePending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cancel activity selection"
            accessibilityState={{
              busy: deletePending || mergePending,
              disabled: deletePending || mergePending,
            }}
          >
            <Text style={styles.cancelSelectionButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={styles.filterRow}>
        {!searching ? (
          <TouchableOpacity
            style={[styles.filterChip, styles.filterButton]}
            onPress={() => toggleFilter("range")}
            accessibilityRole="button"
            accessibilityLabel={`Date range, ${selectedRange?.label ?? preset}`}
            accessibilityState={{ expanded: openFilter === "range" }}
          >
            <Text style={styles.filterChipText}>{selectedRange?.label} ⌄</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.filterChip, styles.filterButton]}
          onPress={() => toggleFilter("sport")}
          accessibilityRole="button"
          accessibilityLabel={`Sport, ${selectedSport}`}
          accessibilityState={{ expanded: openFilter === "sport" }}
        >
          <Text style={styles.filterChipText}>{selectedSport} ⌄</Text>
        </TouchableOpacity>
      </View>
      {!searching && openFilter === "range" ? (
        <View style={styles.chipRow}>
          {ACTIVITY_AGENDA_RANGES.map(({ preset: value, label }) => (
            <TouchableOpacity
              key={value}
              style={styles.filterChip}
              accessibilityRole="button"
              accessibilityState={{ selected: preset === value }}
              onPress={() => {
                onPresetChange(value);
                setOpenFilter(undefined);
              }}
            >
              <Text style={[styles.filterChipText, preset === value && styles.filterCurrent]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {openFilter === "sport" ? (
        <View style={styles.chipRow}>
          {[ALL_ACTIVITY_TYPES, ...activityTypes].map((type) => (
            <TouchableOpacity
              key={type}
              style={styles.filterChip}
              accessibilityRole="button"
              accessibilityState={{ selected: activityType === type }}
              onPress={() => {
                onActivityTypeChange(type);
                setOpenFilter(undefined);
              }}
            >
              <Text style={[styles.filterChipText, activityType === type && styles.filterCurrent]}>
                {type === ALL_ACTIVITY_TYPES ? "All activities" : formatActivityTypeLabel(type)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}
