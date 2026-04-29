import {
  type FoodEntryNutrientDetail,
  groupFoodEntryNutrientDetails,
} from "@dofek/nutrition/food-entry-nutrition";
import { useState } from "react";

interface FoodEntryRowProps {
  foodName: string;
  servingDescription: string | null;
  calories: number;
  nutrients: FoodEntryNutrientDetail[];
  onDelete: () => void;
  deleting?: boolean;
}

export function FoodEntryRow({
  foodName,
  servingDescription,
  calories,
  nutrients,
  onDelete,
  deleting,
}: FoodEntryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupFoodEntryNutrientDetails(nutrients);
  const hasNutrients = nutrients.length > 0;
  const toggleLabel = `${expanded ? "Hide" : "Show"} nutrition for ${foodName}`;

  return (
    <div className="rounded-md hover:bg-surface-hover group transition-colors">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          className="min-w-0 flex flex-1 items-center gap-2 px-3 py-2 text-left"
        >
          <span
            className={`text-xs text-subtle transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden="true"
          >
            ›
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{foodName}</span>
            {servingDescription && (
              <span className="block truncate text-xs text-subtle">{servingDescription}</span>
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-3 py-2 pr-3">
          <span className="text-sm text-foreground tabular-nums">{calories} kcal</span>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="text-dim hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
            aria-label={`Delete ${foodName}`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
            >
              <title>Delete</title>
              <path
                fillRule="evenodd"
                d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
      {expanded && (
        <div className="px-8 pb-3">
          {hasNutrients ? (
            <div className="space-y-3 rounded-md border border-border bg-page/50 p-3">
              {groups.map((group) => (
                <div key={group.label} className="space-y-1">
                  <div className="text-xs font-semibold text-muted">{group.label}</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {group.nutrients.map((nutrient) => (
                      <div
                        key={nutrient.id}
                        className="flex items-baseline justify-between gap-2 text-xs"
                      >
                        <span className="text-subtle">{nutrient.label}</span>
                        <span className="text-foreground tabular-nums">{nutrient.valueText}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-border bg-page/50 p-3 text-xs text-subtle">
              No nutrient details recorded
            </div>
          )}
        </div>
      )}
    </div>
  );
}
