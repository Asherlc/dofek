import { formatCalories } from "@dofek/format/format";
import type { SelectedDateNutritionIntakeContext } from "@dofek/nutrition/selected-date-summary";

interface NutritionIntakeContextProps {
  context: SelectedDateNutritionIntakeContext;
}

function meterLabel(context: SelectedDateNutritionIntakeContext): string {
  return `Logged intake: ${formatCalories(context.observedCalories)}. ${context.target.label}: ${formatCalories(context.target.calories)}. ${context.comparison.message}`;
}

export function NutritionIntakeContext({ context }: NutritionIntakeContextProps) {
  const label = meterLabel(context);

  return (
    <section
      className="rounded-xl border border-border bg-surface-solid p-5 space-y-3"
      aria-labelledby="nutrition-intake-context-title"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="nutrition-intake-context-title" className="text-sm font-medium text-foreground">
          Logged intake
        </h3>
        <span className="text-xl font-semibold text-foreground tabular-nums">
          {formatCalories(context.observedCalories)}
        </span>
      </div>
      <p className="text-sm text-muted tabular-nums">
        {context.target.label}: {formatCalories(context.target.calories)}
      </p>
      <meter
        className="sr-only"
        min={0}
        max={context.scale.maximumCalories}
        value={context.observedCalories}
        aria-label={label}
      />
      <div
        className="relative h-3 rounded-full bg-accent/10"
        aria-hidden="true"
        data-testid="calorie-scale"
      >
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          data-testid="calorie-scale-observed"
          style={{ width: `${context.scale.observedPercentage}%` }}
        />
        <div
          className="absolute -top-1 h-5 w-0.5 bg-foreground"
          data-testid="calorie-scale-target"
          style={{ left: `${context.scale.targetPercentage}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-subtle tabular-nums">
        <span>0 kcal</span>
        <span>{formatCalories(context.scale.maximumCalories)} scale</span>
      </div>
      <p className="text-sm text-muted" data-testid="calorie-comparison">
        {context.comparison.message}
      </p>
      <p className="text-xs text-subtle">{context.limitation}</p>
    </section>
  );
}
