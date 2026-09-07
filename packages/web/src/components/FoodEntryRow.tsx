import { formatCalories } from "@dofek/format/format";
import {
  type FoodEntryNutrientDetail,
  groupFoodEntryNutrientDetails,
} from "@dofek/nutrition/food-entry-nutrition";
import { useId, useState } from "react";

interface FoodEntryRowProps {
  foodName: string;
  servingDescription: string | null;
  calories: number;
  nutrients: FoodEntryNutrientDetail[];
}

export function FoodEntryRow({
  foodName,
  servingDescription,
  calories,
  nutrients,
}: FoodEntryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const groups = groupFoodEntryNutrientDetails(nutrients);
  const visibleSummary = [servingDescription, formatCalories(calories)].filter(
    (value): value is string => value !== null && value.trim().length > 0,
  );
  const toggleLabel = `${expanded ? "Hide" : "Show"} nutrition for ${foodName}, ${visibleSummary.join(", ")}`;

  return (
    <div className="rounded-md hover:bg-surface-hover transition-colors">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          aria-describedby={expanded ? detailsId : undefined}
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
        <span
          className="shrink-0 py-2 pr-3 text-sm text-foreground tabular-nums"
          aria-hidden="true"
        >
          {formatCalories(calories)}
        </span>
      </div>
      {expanded && (
        <div id={detailsId} className="px-8 pb-3">
          {groups.length > 0 ? (
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
