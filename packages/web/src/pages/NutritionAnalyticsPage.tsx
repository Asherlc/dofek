import { Link } from "@tanstack/react-router";
import { AdaptiveTdeeChart } from "../components/AdaptiveTdeeChart.tsx";
import { ChartDescriptionTooltip } from "../components/ChartDescriptionTooltip.tsx";
import { ChartRangeProvider } from "../components/DofekChart.tsx";
import { MicronutrientChart } from "../components/MicronutrientChart.tsx";
import { NutritionDataQualityPanel } from "../components/NutritionDataQualityPanel.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { useTimeRangePreference } from "../hooks/useTimeRangePreference.ts";
import {
  formatTimeRangeLabel,
  minimumSelectedRangeQueryInput,
  selectedRangeQueryInput,
} from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";

export function NutritionAnalyticsPage() {
  const { days, description, setDays } = useTimeRangePreference("nutrition");

  const micronutrients = trpc.nutritionAnalytics.micronutrientAdequacyV2.useQuery(
    selectedRangeQueryInput(days),
  );
  const adaptiveTdee = trpc.nutritionAnalytics.adaptiveTdee.useQuery(
    minimumSelectedRangeQueryInput(days, 90),
  );
  const macroRatios = trpc.nutritionAnalytics.macroRatios.useQuery(selectedRangeQueryInput(days));
  const queryStates = [adaptiveTdee, macroRatios, micronutrients] as const;
  const firstError = queryStates.find((query) => query.error != null)?.error ?? null;
  const hasSuccessfulData = queryStates.some(
    (query) => query.isSuccess || query.data !== undefined,
  );
  const retrying = queryStates.some((query) => query.isFetching);
  const blockingError = firstError != null && !hasSuccessfulData;
  const adaptiveTdeeHasSuccessfulData = adaptiveTdee.isSuccess || adaptiveTdee.data !== undefined;
  const micronutrientsHaveSuccessfulData =
    micronutrients.isSuccess || micronutrients.data !== undefined;

  function retryAnalytics() {
    void Promise.all([adaptiveTdee.refetch(), macroRatios.refetch(), micronutrients.refetch()]);
  }

  // Compute average protein per kg from macro data
  const latestProteinPerKg = macroRatios.data?.length
    ? macroRatios.data[macroRatios.data.length - 1]?.proteinPerKg
    : null;

  return (
    <ChartRangeProvider days={days}>
      <div className="space-y-6 sm:space-y-8">
        <div className="flex justify-end">
          <TimeRangeSelector days={days} description={description} onChange={setDays} />
        </div>
        {firstError ? (
          <div className="space-y-2">
            <QueryStatePanel
              contextLabel="Nutrition analytics"
              error={firstError}
              height={blockingError ? 180 : 72}
              onRetry={retryAnalytics}
              retryLabel="Retry nutrition analytics"
              retrying={retrying}
            />
            <Link
              className="inline-flex text-sm font-medium text-accent hover:underline"
              search={{ tab: "data-sources" }}
              to="/settings"
            >
              Review data sources
            </Link>
          </div>
        ) : null}

        {!blockingError ? (
          <>
            {micronutrients.error == null || micronutrientsHaveSuccessfulData ? (
              <NutritionDataQualityPanel
                dataQuality={micronutrients.data?.dataQuality}
                loading={micronutrients.isLoading && micronutrients.data === undefined}
              />
            ) : null}
            {/* Adaptive TDEE */}
            {adaptiveTdee.error == null || adaptiveTdeeHasSuccessfulData ? (
              <Section
                title="Adaptive Total Daily Energy Expenditure (TDEE)"
                subtitle="Estimated from logged calorie intake and observed body-weight change"
              >
                <AdaptiveTdeeChart
                  data={adaptiveTdee.data}
                  loading={adaptiveTdee.isLoading && adaptiveTdee.data === undefined}
                />
              </Section>
            ) : null}

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
            {micronutrients.error == null || micronutrientsHaveSuccessfulData ? (
              <Section
                title="Micronutrient Adequacy"
                subtitle={`Average over recorded days as % of the U.S. Food and Drug Administration (FDA) Daily Value (${formatTimeRangeLabel(days)}); this generic label reference is not a personalized deficiency or safety assessment`}
              >
                <MicronutrientChart
                  data={micronutrients.data?.nutrients ?? []}
                  loading={micronutrients.isLoading && micronutrients.data === undefined}
                />
              </Section>
            ) : null}
          </>
        ) : null}
      </div>
    </ChartRangeProvider>
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
