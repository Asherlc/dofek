import { formatMeasurementText } from "@dofek/format/units";
import { useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";

export function GoalWeightInput() {
  const units = useUnitConverter();
  const utils = trpc.useUtils();

  const settingsQuery = trpc.settings.get.useQuery({ key: "goalWeight" });
  const rawGoalWeightValue = settingsQuery.data?.value;
  const parsedGoalKg = rawGoalWeightValue != null ? Number(rawGoalWeightValue) : null;
  const currentGoalKg = parsedGoalKg != null && Number.isFinite(parsedGoalKg) ? parsedGoalKg : null;

  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const mutation = trpc.bodyAnalytics.setGoalWeight.useMutation({
    onSuccess: () => {
      void utils.bodyAnalytics.weightOverview.invalidate();
      void utils.bodyAnalytics.weightPrediction.invalidate();
      void utils.settings.invalidate();
      setSaveError(null);
      setEditing(false);
    },
    onError: (error) => {
      setSaveError(error.message);
    },
  });

  const handleSave = () => {
    const parsed = Number.parseFloat(inputValue);
    if (Number.isNaN(parsed) || parsed <= 0) return;
    const weightKg = units.weightLabel === "lbs" ? parsed / 2.20462 : parsed;
    setSaveError(null);
    mutation.mutate({ weightKg });
  };

  const handleClear = () => {
    setSaveError(null);
    mutation.mutate({ weightKg: null });
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            type="number"
            step="0.1"
            className="w-20 rounded bg-surface border border-border px-2 py-1 text-sm"
            placeholder={units.weightLabel}
            value={inputValue}
            onChange={(event) => {
              setInputValue(event.target.value);
              if (saveError != null) setSaveError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSave();
              if (event.key === "Escape") {
                setSaveError(null);
                setEditing(false);
              }
            }}
            ref={inputRef}
          />
          <button
            type="button"
            className="text-xs text-primary hover:text-primary/80"
            onClick={handleSave}
            disabled={mutation.isPending}
          >
            Save
          </button>
          <button
            type="button"
            className="text-xs text-muted hover:text-subtle"
            onClick={() => {
              setSaveError(null);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
        {saveError != null && <p className="text-xs text-red-400">{saveError}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {currentGoalKg != null ? (
          <>
            <span className="text-xs text-muted">
              Goal: {formatMeasurementText(units.formatWeight(currentGoalKg))}
            </span>
            <button
              type="button"
              className="text-xs text-primary hover:text-primary/80"
              onClick={() => {
                setInputValue(String(Math.round(units.convertWeight(currentGoalKg) * 10) / 10));
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="text-xs text-muted hover:text-subtle"
              onClick={handleClear}
            >
              Clear
            </button>
          </>
        ) : (
          <button
            type="button"
            className="text-xs text-primary hover:text-primary/80"
            onClick={() => {
              setInputValue("");
              setEditing(true);
            }}
          >
            Set Goal Weight
          </button>
        )}
      </div>
      {saveError != null && <p className="text-xs text-red-400">{saveError}</p>}
    </div>
  );
}
