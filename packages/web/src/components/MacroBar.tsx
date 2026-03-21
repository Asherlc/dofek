interface MacroBarProps {
  label: string;
  grams: number;
  caloriesFromMacro: number;
  totalCalories: number;
  color: "blue" | "amber" | "red";
}

const colorMap = {
  blue: { bar: "bg-blue-500", text: "text-blue-400" },
  amber: { bar: "bg-amber-500", text: "text-amber-400" },
  red: { bar: "bg-red-500", text: "text-red-400" },
} as const;

export function MacroBar({ label, grams, caloriesFromMacro, totalCalories, color }: MacroBarProps) {
  const percentage = totalCalories > 0 ? Math.round((caloriesFromMacro / totalCalories) * 100) : 0;
  const { bar, text } = colorMap[color];

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className={`font-medium ${text}`}>{label}</span>
        <span className="text-muted tabular-nums">
          {grams}g<span className="ml-1.5 text-subtle">({percentage}%)</span>
        </span>
      </div>
      <div className="h-2 rounded-full bg-accent/10 overflow-hidden">
        <div
          className={`h-full rounded-full ${bar} transition-all duration-300`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  );
}
