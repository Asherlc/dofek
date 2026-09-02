import { formatGrams, formatNutritionNumber } from "@dofek/format/format";
import { chartColors } from "@dofek/scoring/colors";

interface MacroBarProps {
  label: string;
  grams: number;
  energySharePercentage: number;
  color: "blue" | "purple" | "teal";
}

const colorMap = {
  blue: chartColors.blue,
  purple: chartColors.purple,
  teal: chartColors.teal,
} as const;

export function MacroBar({ label, grams, energySharePercentage, color }: MacroBarProps) {
  const formattedGrams = formatNutritionNumber(grams);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-muted">{label}</span>
        <span className="flex items-baseline gap-2 tabular-nums">
          <span className="font-medium text-foreground">
            {formatNutritionNumber(energySharePercentage)}% of energy
          </span>
          <span className="text-subtle">{formatGrams(grams)} logged</span>
        </span>
      </div>
      <meter
        className="sr-only"
        value={energySharePercentage}
        min={0}
        max={100}
        aria-label={`${label}: ${formatNutritionNumber(energySharePercentage)}% share of energy; ${formattedGrams} grams logged`}
      />
      <div className="h-2 rounded-full bg-accent/10 overflow-hidden" aria-hidden="true">
        <div
          className="h-full rounded-full transition-all duration-300"
          data-testid="macro-bar-fill"
          style={{ backgroundColor: colorMap[color], width: `${energySharePercentage}%` }}
        />
      </div>
    </div>
  );
}
