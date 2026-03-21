import { useState } from "react";
import { AdaptiveTdeeChart } from "../components/AdaptiveTdeeChart.tsx";
import { AppHeader } from "../components/AppHeader.tsx";
import { CaloricBalanceChart } from "../components/CaloricBalanceChart.tsx";
import { ChartDescriptionTooltip } from "../components/ChartDescriptionTooltip.tsx";
import { MicronutrientChart } from "../components/MicronutrientChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { trpc } from "../lib/trpc.ts";

export function NutritionAnalyticsPage() {
  const [days, setDays] = useState(30);

  const micronutrients = trpc.nutritionAnalytics.micronutrientAdequacy.useQuery({ days });
  const caloricBalance = trpc.nutritionAnalytics.caloricBalance.useQuery({ days });
  const adaptiveTdee = trpc.nutritionAnalytics.adaptiveTdee.useQuery({ days: Math.max(days, 90) });
  const macroRatios = trpc.nutritionAnalytics.macroRatios.useQuery({ days });

  // Compute average protein per kg from macro data
  const latestProteinPerKg = macroRatios.data?.length
    ? macroRatios.data[macroRatios.data.length - 1]?.proteinPerKg
    : null;

  return (
    <div className="min-h-screen bg-page text-foreground overflow-x-hidden">
      <AppHeader>
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        {/* Adaptive TDEE */}
        <Section
          title="Adaptive TDEE"
          subtitle="True daily energy expenditure estimated from calorie intake vs weight change"
        >
          <AdaptiveTdeeChart data={adaptiveTdee.data} loading={adaptiveTdee.isLoading} />
        </Section>

        {/* Caloric Balance */}
        <Section
          title="Caloric Balance"
          subtitle="Daily calories in vs estimated expenditure (active + basal energy)"
        >
          <CaloricBalanceChart
            data={caloricBalance.data ?? []}
            loading={caloricBalance.isLoading}
          />
        </Section>

        {/* Macro summary */}
        {latestProteinPerKg != null && (
          <div className="card p-4">
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold text-foreground">{latestProteinPerKg}</span>
              <span className="text-sm text-muted">g protein / kg bodyweight</span>
              <span className="text-xs text-dim">
                {latestProteinPerKg >= 1.6
                  ? "(meets muscle-building target)"
                  : latestProteinPerKg >= 1.2
                    ? "(adequate for general fitness)"
                    : "(below recommended for active individuals)"}
              </span>
            </div>
          </div>
        )}

        {/* Micronutrient Adequacy */}
        <Section
          title="Micronutrient Adequacy"
          subtitle={`Average daily intake as % of Recommended Dietary Allowance (${days} days)`}
        >
          <MicronutrientChart data={micronutrients.data ?? []} loading={micronutrients.isLoading} />
        </Section>
      </main>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const description = subtitle ?? `${title} chart.`;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
        <ChartDescriptionTooltip description={description} />
      </div>
      {subtitle && <p className="text-xs text-dim mb-4">{subtitle}</p>}
      <div className="card p-2 sm:p-4" title={description}>
        {children}
      </div>
    </section>
  );
}
