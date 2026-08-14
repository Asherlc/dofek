interface FoodEntryRowProps {
  foodName: string;
  servingDescription: string | null;
  calories: number;
}

export function FoodEntryRow({ foodName, servingDescription, calories }: FoodEntryRowProps) {
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-surface-hover group transition-colors">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground truncate">{foodName}</div>
        {servingDescription && (
          <div className="text-xs text-subtle truncate">{servingDescription}</div>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0 ml-3">
        <span className="text-sm text-foreground tabular-nums">{calories} kcal</span>
      </div>
    </div>
  );
}
