import type { DayNutritionPreview } from "@dofek/mcp-contracts/day-nutrition";

const macroColors = {
  protein: "#2563eb",
  carbs: "#5E35B1",
  fat: "#0ea5e9",
} as const;

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function ProgressBar({
  label,
  valueLabel,
  percentage,
  color,
}: {
  label: string;
  valueLabel: string;
  percentage: number;
  color: string;
}) {
  const width = Math.min(Math.max(percentage, 0), 100);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          fontSize: 14,
        }}
      >
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: "#475569" }}>{valueLabel}</span>
      </div>
      <div
        aria-hidden="true"
        style={{
          height: 8,
          borderRadius: 999,
          background: "#e2e8f0",
          overflow: "hidden",
        }}
      >
        <div
          data-testid={`${label.toLowerCase()}-bar-fill`}
          style={{
            width: `${width}%`,
            height: "100%",
            borderRadius: 999,
            background: color,
          }}
        />
      </div>
    </div>
  );
}

export interface DayNutritionPreviewPanelProps {
  preview: DayNutritionPreview;
}

export function DayNutritionPreviewPanel({ preview }: DayNutritionPreviewPanelProps) {
  const calorieValueLabel =
    preview.calorie_goal.over > 0
      ? `${formatNumber(preview.total_calories)} cal · ${formatNumber(preview.calorie_goal.over)} over target`
      : `${formatNumber(preview.total_calories)} cal · ${formatNumber(preview.calorie_goal.remaining)} remaining`;

  return (
    <main
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        color: "#0f172a",
        padding: 16,
        display: "grid",
        gap: 20,
      }}
    >
      <header style={{ display: "grid", gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Today's nutrition</h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>{preview.date}</p>
      </header>

      <section aria-label="Calories" style={{ display: "grid", gap: 12 }}>
        <ProgressBar
          label="Calories"
          valueLabel={calorieValueLabel}
          percentage={preview.calorie_goal.progress_percentage}
          color="#16a34a"
        />
        <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>
          Target {formatNumber(preview.calorie_goal.target)} calories (
          {preview.calorie_goal.type === "configured" ? "your goal" : "default goal"})
        </p>
      </section>

      <section aria-label="Macros" style={{ display: "grid", gap: 14 }}>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "#64748b" }}>
          SHARE OF ENERGY
        </p>
        <ProgressBar
          label="Protein"
          valueLabel={`${formatNumber(preview.macros.protein.energy_share_percentage)}% · ${formatNumber(preview.macros.protein.grams)} g`}
          percentage={preview.macros.protein.energy_share_percentage}
          color={macroColors.protein}
        />
        <ProgressBar
          label="Carbs"
          valueLabel={`${formatNumber(preview.macros.carbs.energy_share_percentage)}% · ${formatNumber(preview.macros.carbs.grams)} g`}
          percentage={preview.macros.carbs.energy_share_percentage}
          color={macroColors.carbs}
        />
        <ProgressBar
          label="Fat"
          valueLabel={`${formatNumber(preview.macros.fat.energy_share_percentage)}% · ${formatNumber(preview.macros.fat.grams)} g`}
          percentage={preview.macros.fat.energy_share_percentage}
          color={macroColors.fat}
        />
      </section>
    </main>
  );
}
