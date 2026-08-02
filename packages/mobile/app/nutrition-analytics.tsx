import { formatCalories, formatNumber, formatNutritionNumber } from "@dofek/format/format";
import {
  DAILY_VALUE_TARGET_LABEL,
  upperLimitIntakeScopeLabel,
  upperLimitStatusLabel,
} from "@dofek/nutrition/nutrient-safety";
import { operationalStatusColors, statusColors } from "@dofek/scoring/colors";
import { useRouter } from "expo-router";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import type {
  AdaptiveTdeeResult,
  MacroRatioRow,
  MicronutrientSafetyReviewResult,
} from "../../server/src/routers/nutrition-analytics";
import { ChartTitleWithTooltip } from "../components/ChartTitleWithTooltip";
import { DaySelector } from "../components/DaySelector";
import { NutritionDataQualityPanel } from "../components/NutritionDataQualityPanel";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useUnitConverter } from "../lib/units";
import { useRefresh } from "../lib/useRefresh";
import { useTimeRangePreference } from "../lib/useTimeRangePreference";
import { colors } from "../theme";

// ── Types ──

const DAY_OPTIONS = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "365d", value: 365 },
];

// ── Helpers ──

function nutrientBarColor(
  safetyStatus:
    | "at_or_above_upper_limit"
    | "upper_limit_not_evaluable"
    | "within_upper_limit"
    | "no_upper_limit_in_ruleset",
): string {
  if (safetyStatus === "at_or_above_upper_limit") {
    return operationalStatusColors.danger.indicator;
  }
  if (safetyStatus === "upper_limit_not_evaluable") {
    return operationalStatusColors.warning.indicator;
  }
  return operationalStatusColors.info.indicator;
}

function selectedWindowLabel(selectedWindowDays: number | null): string {
  return selectedWindowDays == null
    ? "all available days"
    : `a ${selectedWindowDays}-day selected window`;
}

function targetStatusLabel(status: "below_daily_value" | "at_or_above_daily_value"): string {
  return status === "at_or_above_daily_value" ? "Meets or exceeds target" : "Below target";
}

function targetSummary(nutrient: MicronutrientSafetyReviewResult["nutrients"][number]): string {
  if (nutrient.adequacy == null) {
    return "No FDA Daily Value target is available for this nutrient.";
  }
  if (nutrient.adequacy.status === "not_evaluable") {
    return "FDA Daily Value target not evaluable";
  }
  return `${formatNutritionNumber(nutrient.adequacy.percentDailyValue)}% of ${DAILY_VALUE_TARGET_LABEL} (${formatNutritionNumber(nutrient.adequacy.reference.amount)} ${nutrient.unit}/day)`;
}

function targetStatusSummary(
  nutrient: MicronutrientSafetyReviewResult["nutrients"][number],
): string {
  if (nutrient.adequacy?.status === "not_evaluable") return "Not evaluable";
  if (nutrient.adequacy == null) return "No target available";
  return targetStatusLabel(nutrient.adequacy.status);
}

function upperLimitSummary(nutrient: MicronutrientSafetyReviewResult["nutrients"][number]): string {
  const upperLimit = nutrient.upperLimit;
  if (upperLimit.status === "not_in_ruleset") {
    return upperLimitStatusLabel(upperLimit.status);
  }
  if (upperLimit.status === "not_evaluable") {
    return upperLimitStatusLabel(upperLimit.status);
  }
  return `Tolerable Upper Intake Level (UL): ${formatNutritionNumber(upperLimit.amount)} ${upperLimit.unit}/day for ${upperLimitIntakeScopeLabel(upperLimit.intakeScope)}`;
}

function nutrientContextCardStyle(
  safetyStatus: MicronutrientSafetyReviewResult["nutrients"][number]["safetyStatus"],
) {
  if (safetyStatus === "at_or_above_upper_limit") return styles.nutrientContextDanger;
  if (safetyStatus === "upper_limit_not_evaluable") return styles.nutrientContextWarning;
  return undefined;
}

function nutrientContextAccessibilityLabel(
  nutrient: MicronutrientSafetyReviewResult["nutrients"][number],
  selectedWindowDays: number | null,
): string {
  const parts = [
    nutrient.nutrient,
    `Target: ${targetSummary(nutrient)}`,
    nutrient.adequacy == null ? null : `Target status: ${targetStatusSummary(nutrient)}`,
    nutrient.adequacy == null ? null : `Target source: ${nutrient.adequacy.reference.source.title}`,
    nutrient.adequacy == null ? null : `Target guidance: ${nutrient.adequacy.message}`,
    upperLimitSummary(nutrient),
    nutrient.upperLimit.status === "not_in_ruleset"
      ? null
      : `UL status: ${upperLimitStatusLabel(nutrient.upperLimit.status)}`,
    nutrient.upperLimit.status === "not_in_ruleset"
      ? null
      : `UL source: ${nutrient.upperLimit.source.title}`,
    nutrient.upperLimit.status === "not_in_ruleset"
      ? null
      : `UL guidance: ${nutrient.upperLimit.message}`,
    `Average over ${nutrient.intake.daysTracked} recorded days in ${selectedWindowLabel(selectedWindowDays)}`,
  ];
  return `${parts
    .filter((part): part is string => part !== null)
    .map((part) => part.replace(/\.$/, ""))
    .join(". ")}.`;
}

function MicronutrientContextDetails({
  nutrients,
  selectedWindowDays,
}: {
  nutrients: MicronutrientSafetyReviewResult["nutrients"];
  selectedWindowDays: number | null;
}) {
  return (
    <View style={styles.nutrientContextDetails}>
      {nutrients.map((nutrient) => (
        <View
          key={nutrient.nutrientId}
          accessible
          accessibilityLabel={nutrientContextAccessibilityLabel(nutrient, selectedWindowDays)}
          style={[styles.nutrientContextCard, nutrientContextCardStyle(nutrient.safetyStatus)]}
        >
          <Text style={styles.nutrientContextTitle}>{nutrient.nutrient}</Text>
          <Text style={styles.nutrientContextText}>Target: {targetSummary(nutrient)}</Text>
          {nutrient.adequacy != null ? (
            <>
              <Text style={styles.nutrientContextText}>
                Target status: {targetStatusSummary(nutrient)}
              </Text>
              <Text style={styles.nutrientContextText}>
                Target source: {nutrient.adequacy.reference.source.title}
              </Text>
              <Text style={styles.nutrientContextText}>
                Target guidance: {nutrient.adequacy.message}
              </Text>
            </>
          ) : null}
          <Text style={styles.nutrientContextText}>{upperLimitSummary(nutrient)}</Text>
          {nutrient.upperLimit.status !== "not_in_ruleset" ? (
            <>
              <Text style={styles.nutrientContextText}>
                UL status: {upperLimitStatusLabel(nutrient.upperLimit.status)}
              </Text>
              <Text style={styles.nutrientContextText}>
                UL source: {nutrient.upperLimit.source.title}
              </Text>
              <Text style={styles.nutrientContextText}>
                UL guidance: {nutrient.upperLimit.message}
              </Text>
            </>
          ) : null}
          <Text style={styles.nutrientContextText}>
            {`Average over ${nutrient.intake.daysTracked} recorded days in ${selectedWindowLabel(selectedWindowDays)}.`}
          </Text>
        </View>
      ))}
    </View>
  );
}

function proteinPerKgColor(value: number): string {
  if (value >= 1.6) return statusColors.positive;
  if (value >= 1.2) return statusColors.warning;
  return statusColors.danger;
}

function proteinPerKgRecommendation(value: number): string {
  if (value >= 1.6) return "Meeting recommended intake for active individuals (1.6+ g/kg)";
  if (value >= 1.2)
    return "Adequate protein, but below optimal for active individuals. Target 1.6+ g/kg.";
  return "Protein intake is low. Aim for at least 1.6 g/kg bodyweight for muscle maintenance.";
}

function LoadingText() {
  return <Text style={styles.loadingText}>Loading...</Text>;
}

// ── Main Screen ──

export default function NutritionAnalyticsScreen() {
  const { days, description, setDays } = useTimeRangePreference("nutrition");
  const router = useRouter();
  const { refreshing, onRefresh } = useRefresh();
  const adaptiveTdee = trpc.nutritionAnalytics.adaptiveTdee.useQuery({
    days: Math.max(days, 90),
  });
  const macroRatios = trpc.nutritionAnalytics.macroRatios.useQuery({ days });
  const micronutrients = trpc.nutritionAnalytics.micronutrientAdequacyV2.useQuery({ days });
  const queryStates = [adaptiveTdee, macroRatios, micronutrients] as const;
  const firstError = queryStates.find((query) => query.error != null)?.error ?? null;
  const hasSuccessfulData = queryStates.some(
    (query) => query.isSuccess || query.data !== undefined,
  );
  const retrying = queryStates.some((query) => query.isFetching);
  const blockingError = firstError != null && !hasSuccessfulData;
  const adaptiveTdeeHasSuccessfulData = adaptiveTdee.isSuccess || adaptiveTdee.data !== undefined;
  const macroRatiosHaveSuccessfulData = macroRatios.isSuccess || macroRatios.data !== undefined;
  const micronutrientsHaveSuccessfulData =
    micronutrients.isSuccess || micronutrients.data !== undefined;

  function retryAnalytics() {
    void Promise.all([adaptiveTdee.refetch(), macroRatios.refetch(), micronutrients.refetch()]);
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      <DaySelector days={days} description={description} onChange={setDays} options={DAY_OPTIONS} />

      {firstError ? (
        <View style={styles.recovery}>
          <QueryStatePanel
            variant="error"
            title="Could not load nutrition analytics"
            message={getQueryErrorMessage(firstError)}
            minHeight={blockingError ? 180 : 96}
            onRetry={retryAnalytics}
            retryLabel="Retry nutrition analytics"
            retrying={retrying}
          />
          <TouchableOpacity
            accessibilityLabel="Review data sources"
            accessibilityRole="link"
            activeOpacity={0.7}
            onPress={() => router.push("/providers")}
            style={styles.dataSourcesLink}
          >
            <Text style={styles.dataSourcesLinkText}>Review data sources</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!blockingError ? (
        <>
          {micronutrients.error == null || micronutrientsHaveSuccessfulData ? (
            <NutritionDataQualityPanel
              dataQuality={micronutrients.data?.dataQuality}
              loading={micronutrients.isLoading && micronutrients.data === undefined}
            />
          ) : null}
          {adaptiveTdee.error == null || adaptiveTdeeHasSuccessfulData ? (
            <AdaptiveTdeeSection
              data={adaptiveTdee.data}
              loading={adaptiveTdee.isLoading && adaptiveTdee.data === undefined}
            />
          ) : null}
          {macroRatios.error == null || macroRatiosHaveSuccessfulData ? (
            <MacroSummarySection
              data={macroRatios.data}
              loading={macroRatios.isLoading && macroRatios.data === undefined}
            />
          ) : null}
          {micronutrients.error == null || micronutrientsHaveSuccessfulData ? (
            <MicronutrientAdequacySection
              data={micronutrients.data}
              loading={micronutrients.isLoading && micronutrients.data === undefined}
            />
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

// ── Section 1: Adaptive TDEE ──

function AdaptiveTdeeSection({
  data,
  loading,
}: {
  data: AdaptiveTdeeResult | undefined;
  loading: boolean;
}) {
  const units = useUnitConverter();

  if (loading) return <LoadingText />;

  return (
    <View style={styles.card}>
      <ChartTitleWithTooltip
        title="Adaptive Total Daily Energy Expenditure (TDEE) Estimate"
        description="Estimated from logged calorie intake and observed body-weight change."
        textStyle={styles.cardTitle}
      />
      {data == null ? (
        <Text style={styles.emptyText}>
          Not enough data to estimate Total Daily Energy Expenditure (TDEE)
        </Text>
      ) : (
        <>
          {data.estimatedTdee != null ? (
            <>
              <Text style={styles.bigValue}>{formatCalories(data.estimatedTdee)}/day</Text>
              {data.estimateRange ? (
                <Text style={styles.cardSubtext}>
                  Observed rolling range: {formatNutritionNumber(data.estimateRange.minimum)}–
                  {formatNutritionNumber(data.estimateRange.maximum)} {units.caloriesPerDayLabel}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.emptyText}>{data.unavailableReason}</Text>
          )}
          <AdaptiveTdeeEvidence data={data} />
        </>
      )}
    </View>
  );
}

function AdaptiveTdeeEvidence({ data }: { data: AdaptiveTdeeResult }) {
  const evidence = data.evidence;
  const exclusions = evidence.excludedDays;
  return (
    <View style={styles.tdeeDetails}>
      <Text style={styles.cardSubtext}>
        {evidence.selectedWindowDays}-day evaluation · {evidence.observedDays} accessible calendar
        days
      </Text>
      <Text style={styles.cardSubtext}>
        {evidence.fitWindowDays}-day fit · at least {evidence.minimumCalorieDays} usable calorie
        days
      </Text>
      <Text style={styles.cardSubtext}>
        {evidence.calorieDays} calorie days · {evidence.weightDays} weight days ·{" "}
        {evidence.acceptedWindows} accepted windows
      </Text>
      {exclusions.missingCalories > 0 ||
      exclusions.sourceConflict > 0 ||
      exclusions.lowerPrioritySources > 0 ? (
        <Text style={styles.cardSubtext}>
          Excluded: {exclusions.missingCalories} missing calorie days · {exclusions.sourceConflict}{" "}
          source-conflict days · {exclusions.lowerPrioritySources} days with lower-priority sources
        </Text>
      ) : null}
    </View>
  );
}

// ── Section 3: Macro Summary ──

function MacroSummarySection({
  data,
  loading,
}: {
  data: MacroRatioRow[] | undefined;
  loading: boolean;
}) {
  if (loading) return <LoadingText />;

  const rows = data ?? [];
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];
  const proteinPerKg = latest?.proteinPerKg;

  return (
    <View>
      <Text style={styles.sectionTitle}>Protein Intake</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Protein per kg Bodyweight</Text>
        {proteinPerKg != null ? (
          <>
            <Text style={[styles.bigValue, { color: proteinPerKgColor(proteinPerKg) }]}>
              {formatNumber(proteinPerKg, 1)} g/kg
            </Text>
            <Text style={styles.cardSubtext}>{proteinPerKgRecommendation(proteinPerKg)}</Text>
          </>
        ) : (
          <Text style={styles.emptyText}>No data available</Text>
        )}
      </View>
    </View>
  );
}

// ── Section 4: Micronutrient Adequacy ──

function MicronutrientAdequacySection({
  data,
  loading,
}: {
  data: MicronutrientSafetyReviewResult | undefined;
  loading: boolean;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const barMaxWidth = screenWidth - 160;

  if (loading) return <LoadingText />;

  const visibleNutrients = (data?.nutrients ?? []).filter(
    (nutrient) =>
      (nutrient.adequacy != null && nutrient.adequacy.status !== "not_evaluable") ||
      nutrient.upperLimit.status !== "not_in_ruleset",
  );
  const evaluableNutrients = visibleNutrients.filter(
    (nutrient) => nutrient.adequacy != null && nutrient.adequacy.status !== "not_evaluable",
  );
  if (visibleNutrients.length === 0) return null;

  const sorted = [...evaluableNutrients].sort((a, b) => {
    const first = a.adequacy?.status !== "not_evaluable" ? a.adequacy?.percentDailyValue : 0;
    const second = b.adequacy?.status !== "not_evaluable" ? b.adequacy?.percentDailyValue : 0;
    return (first ?? 0) - (second ?? 0);
  });

  return (
    <View>
      <ChartTitleWithTooltip
        title="Micronutrient Adequacy"
        description="This chart compares your average micronutrient intake against recommended daily targets."
        textStyle={styles.sectionTitle}
      />
      <Text style={styles.sectionSubtext}>
        Average over recorded days vs. U.S. Food and Drug Administration (FDA) Daily Value; not a
        personalized deficiency or safety assessment
      </Text>
      <Text style={styles.sectionSubtext}>
        The Daily Value target marker and any Tolerable Upper Intake Level (UL) are separate; see
        each nutrient&apos;s target, source, and safety details below.
      </Text>

      {sorted.map((nutrient) => {
        const percentDailyValue =
          nutrient.adequacy?.status !== "not_evaluable"
            ? (nutrient.adequacy?.percentDailyValue ?? 0)
            : 0;
        const percentage = Math.min(percentDailyValue, 150);
        const barFraction = percentage / 150;
        const barColor = nutrientBarColor(nutrient.safetyStatus);

        return (
          <View key={nutrient.nutrient} style={styles.nutrientGroup}>
            <View style={styles.nutrientRow}>
              <View style={styles.nutrientLabelContainer}>
                <Text style={styles.nutrientLabel} numberOfLines={1}>
                  {nutrient.nutrient}
                </Text>
              </View>
              <View style={styles.nutrientBarContainer}>
                <View style={[styles.nutrientBarTrack, { width: barMaxWidth }]}>
                  <View
                    style={[
                      styles.nutrientBarFill,
                      {
                        width: `${barFraction * 100}%`,
                        backgroundColor: barColor,
                      },
                    ]}
                  />
                  <View style={[styles.nutrientRdaMarker, { left: `${(100 / 150) * 100}%` }]} />
                </View>
                <Text style={[styles.nutrientPct, { color: barColor }]}>
                  {formatNutritionNumber(percentDailyValue)}%
                </Text>
              </View>
            </View>
            <View style={styles.nutrientSourceDetails}>
              <Text style={styles.nutrientSourceText}>
                Itemized food: {formatNutritionNumber(nutrient.intake.foodDailyAverage)}{" "}
                {nutrient.unit}/day
              </Text>
              <Text style={styles.nutrientSourceText}>
                Provider daily totals:{" "}
                {formatNutritionNumber(nutrient.intake.providerDailyTotalAverage)} {nutrient.unit}
                /day
              </Text>
              <Text style={styles.nutrientSourceText}>
                Supplements: {formatNutritionNumber(nutrient.intake.supplementDailyAverage)}{" "}
                {nutrient.unit}/day
              </Text>
              {nutrient.sourceBreakdown.map((source) => (
                <Text
                  key={`${source.providerId}:${source.sourceLabel}:${source.intakeType}`}
                  style={styles.nutrientSourceText}
                >
                  {source.sourceLabel} · {intakeTypeLabel(source.intakeType)} ·{" "}
                  {formatNutritionNumber(source.dailyAverageContribution)} {nutrient.unit}/day ·{" "}
                  {source.daysTracked} {source.daysTracked === 1 ? "day" : "days"}
                </Text>
              ))}
            </View>
          </View>
        );
      })}
      <MicronutrientContextDetails
        nutrients={visibleNutrients}
        selectedWindowDays={data?.dataQuality.selectedWindowDays ?? null}
      />
    </View>
  );
}

function intakeTypeLabel(
  intakeType: "itemized_food" | "provider_daily_total" | "supplement",
): string {
  switch (intakeType) {
    case "itemized_food":
      return "Itemized food";
    case "provider_daily_total":
      return "Provider daily total";
    case "supplement":
      return "Supplement";
  }
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  recovery: {
    gap: 8,
    marginBottom: 12,
  },
  dataSourcesLink: {
    alignSelf: "flex-start",
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  dataSourcesLinkText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  // ── Sections ──
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 12,
    marginTop: 16,
  },
  sectionSubtext: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: 12,
    marginTop: -8,
  },

  // ── Cards ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  cardSubtext: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },
  bigValue: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.text,
  },

  // ── TDEE ──
  tdeeDetails: {
    marginTop: 4,
    gap: 2,
  },

  // ── Nutrient bars ──
  nutrientGroup: {
    marginBottom: 14,
  },
  nutrientRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  nutrientLabelContainer: {
    width: 90,
  },
  nutrientLabel: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  nutrientBarContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  nutrientBarTrack: {
    height: 12,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 6,
    overflow: "hidden",
    position: "relative",
  },
  nutrientBarFill: {
    height: "100%",
    borderRadius: 6,
  },
  nutrientRdaMarker: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: colors.text,
    opacity: 0.4,
  },
  nutrientPct: {
    fontSize: 12,
    fontWeight: "700",
    width: 40,
    textAlign: "right",
  },
  nutrientSourceDetails: {
    gap: 2,
    marginLeft: 90,
    marginTop: 4,
  },
  nutrientSourceText: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  nutrientContextDetails: {
    gap: 8,
    marginTop: 4,
  },
  nutrientContextCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    padding: 10,
    gap: 2,
  },
  nutrientContextDanger: {
    borderColor: operationalStatusColors.danger.border,
    borderWidth: 1,
  },
  nutrientContextWarning: {
    borderColor: operationalStatusColors.warning.border,
    borderWidth: 1,
  },
  nutrientContextTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 2,
  },
  nutrientContextText: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 15,
  },

  // ── Status text ──
  loadingText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: 32,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 16,
  },
});
