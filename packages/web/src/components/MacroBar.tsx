import { formatNutritionNumber } from "@dofek/format/format";
import { chartColors } from "@dofek/scoring/colors";

interface MacroBarProps {
  label: string;
  grams: string;
  percentage: number;
  color: "blue" | "purple" | "teal";
}

const colorMap = {
  blue: chartColors.blue,
  purple: chartColors.purple,
  teal: chartColors.teal,
} as const;

export function MacroBar({ label, grams, percentage, color }: MacroBarProps) {
  const visualPercentage = Math.min(100, Math.max(0, percentage));

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-muted">{label}</span>
        <span className="text-muted tabular-nums">
          {grams}
          <span className="ml-1.5 text-subtle">({formatNutritionNumber(percentage)}%)</span>
        </span>
      </div>
      <div className="h-2 rounded-full bg-accent/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          data-testid="macro-bar-fill"
          style={{ backgroundColor: colorMap[color], width: `${visualPercentage}%` }}
        />
      </div>
    </div>
  );
}
