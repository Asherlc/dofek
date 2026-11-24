import {
  ACTIVITY_AGENDA_RANGES,
  type ActivityAgendaPreset,
  isActivityAgendaPreset,
} from "@dofek/format/activity-agenda";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { useId } from "react";

const ALL_ACTIVITY_TYPES = "all";

export interface ActivityControlsProps {
  activityTypes: string[];
  activityType: string;
  preset: ActivityAgendaPreset;
  showHidden: boolean;
  searching: boolean;
  canSelect: boolean;
  selectMode: boolean;
  confirmDelete: boolean;
  confirmMerge: boolean;
  confirmRestore: boolean;
  selectedCount: number;
  selectedHiddenCount: number;
  selectedVisibleCount: number;
  mergeEligible: boolean;
  mergePending: boolean;
  mixedTypes: boolean;
  deletePending: boolean;
  restorePending: boolean;
  onActivityTypeChange: (activityType: string) => void;
  onPresetChange: (preset: ActivityAgendaPreset) => void;
  onShowHiddenChange: (showHidden: boolean) => void;
  onSelect: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
  onMergeSelected: () => void;
  onRestoreSelected: () => void;
  onConfirmDelete: () => void;
  onConfirmMerge: () => void;
  onConfirmRestore: () => void;
}

export function ActivityControls({
  activityTypes,
  activityType,
  preset,
  showHidden,
  searching,
  canSelect,
  selectMode,
  confirmDelete,
  confirmMerge,
  confirmRestore,
  selectedCount,
  selectedHiddenCount,
  selectedVisibleCount,
  mergeEligible,
  mergePending,
  mixedTypes,
  deletePending,
  restorePending,
  onActivityTypeChange,
  onPresetChange,
  onShowHiddenChange,
  onSelect,
  onCancelSelection,
  onDeleteSelected,
  onMergeSelected,
  onRestoreSelected,
  onConfirmDelete,
  onConfirmMerge,
  onConfirmRestore,
}: ActivityControlsProps) {
  const selectionGuidanceId = useId();
  const selectionGuidance = showHidden
    ? "Choose visible activities to merge or delete, or hidden activities to restore."
    : "Choose activities to merge or delete.";
  const selectedCountLabel = `${selectedCount} ${
    selectedCount === 1 ? "activity" : "activities"
  } selected`;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-solid p-3">
      {canSelect ? (
        <p id={selectionGuidanceId} className={selectMode ? "text-xs text-muted" : "sr-only"}>
          {selectionGuidance}
        </p>
      ) : null}
      {selectMode ? (
        <div className="flex flex-wrap items-center gap-2">
          <output
            aria-live="polite"
            aria-atomic="true"
            className="text-xs text-subtle tabular-nums"
          >
            {selectedCountLabel}
          </output>
          {confirmDelete ? (
            <>
              <span className="text-xs text-muted">
                Delete selected activities? This cannot be undone.
              </span>
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={deletePending || selectedVisibleCount === 0}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {deletePending ? "Deleting..." : "Confirm Delete"}
              </button>
            </>
          ) : confirmRestore ? (
            <>
              <span className="text-xs text-muted">
                Restore selected hidden activities? They will reappear in your activity log.
              </span>
              <button
                type="button"
                onClick={onConfirmRestore}
                disabled={restorePending || selectedHiddenCount === 0}
                className="px-3 py-1.5 text-xs rounded bg-accent text-on-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {restorePending ? "Restoring..." : "Confirm Restore"}
              </button>
            </>
          ) : confirmMerge ? (
            <>
              <span className="text-xs text-muted">
                Merge selected activities into one activity spanning their times? Original provider
                records remain.
              </span>
              <button
                type="button"
                onClick={onConfirmMerge}
                disabled={mergePending || !mergeEligible}
                className="px-3 py-1.5 text-xs rounded bg-accent text-on-accent disabled:opacity-50"
              >
                {mergePending ? "Merging..." : "Confirm Merge"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onMergeSelected}
                disabled={!mergeEligible || mergePending}
                title={mixedTypes ? "Selected activities must have the same type" : undefined}
                className="px-3 py-1.5 text-xs rounded bg-accent text-on-accent disabled:opacity-50"
              >
                Merge
              </button>
              {mixedTypes ? (
                <span className="text-xs text-muted">Select activities of one type to merge.</span>
              ) : null}
              {showHidden ? (
                <button
                  type="button"
                  onClick={onRestoreSelected}
                  disabled={restorePending || selectedHiddenCount === 0}
                  className="px-3 py-1.5 text-xs rounded bg-accent text-on-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  Restore
                </button>
              ) : null}
              <button
                type="button"
                onClick={onDeleteSelected}
                disabled={deletePending || selectedVisibleCount === 0}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                Delete
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onCancelSelection}
            disabled={deletePending || restorePending || mergePending}
            className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        {canSelect && !selectMode ? (
          <button
            type="button"
            onClick={onSelect}
            aria-describedby={selectionGuidanceId}
            className="sm:mr-auto px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover transition-colors cursor-pointer"
          >
            Select activities
          </button>
        ) : null}
        {!searching ? (
          <>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(event) => onShowHiddenChange(event.target.checked)}
                className="h-4 w-4 accent-accent cursor-pointer"
              />
              Show hidden activities
            </label>
            <label className="flex items-center gap-2 text-xs text-muted">
              Date range
              <select
                value={preset}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isActivityAgendaPreset(value)) onPresetChange(value);
                }}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
              >
                {ACTIVITY_AGENDA_RANGES.map((option) => (
                  <option key={option.preset} value={option.preset}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label className="flex items-center gap-2 text-xs text-muted">
          Activity type
          <select
            value={activityType}
            onChange={(event) => onActivityTypeChange(event.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
          >
            <option value={ALL_ACTIVITY_TYPES}>All activities</option>
            {activityTypes.map((type) => (
              <option key={type} value={type}>
                {formatActivityTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
