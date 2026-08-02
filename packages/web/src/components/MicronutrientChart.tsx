import { formatNutritionNumber } from "@dofek/format/format";
import {
  DAILY_VALUE_TARGET_LABEL,
  upperLimitIntakeScopeLabel,
  upperLimitStatusLabel,
} from "@dofek/nutrition/nutrient-safety";
import { operationalStatusColors } from "@dofek/scoring/colors";
import type { MicronutrientSafetyReviewRow } from "../../../server/src/routers/nutrition-analytics.ts";
import { chartThemeColors, dofekAxis, dofekTooltip, escapeTooltipHtml } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface MicronutrientChartProps {
  data: MicronutrientSafetyReviewRow[];
  loading?: boolean;
  selectedWindowDays?: number | null;
}

function selectedWindowLabel(selectedWindowDays: number | null | undefined): string {
  return selectedWindowDays == null
    ? "all available days"
    : `a ${selectedWindowDays}-day selected window`;
}

function targetStatusLabel(status: "below_daily_value" | "at_or_above_daily_value"): string {
  return status === "at_or_above_daily_value" ? "Meets or exceeds target" : "Below target";
}

function targetSummary(row: MicronutrientSafetyReviewRow): string {
  if (row.adequacy == null) {
    return `No ${DAILY_VALUE_TARGET_LABEL} target is available for this nutrient.`;
  }
  if (row.adequacy.status === "not_evaluable") {
    return `${DAILY_VALUE_TARGET_LABEL} target not evaluable`;
  }
  return `${formatNutritionNumber(row.adequacy.percentDailyValue)}% of ${DAILY_VALUE_TARGET_LABEL} (${formatNutritionNumber(row.adequacy.reference.amount)} ${row.unit}/day)`;
}

function targetStatusSummary(row: MicronutrientSafetyReviewRow): string {
  if (row.adequacy?.status === "not_evaluable") return "Not evaluable";
  if (row.adequacy == null) return "No target available";
  return targetStatusLabel(row.adequacy.status);
}

function upperLimitSummary(row: MicronutrientSafetyReviewRow): string {
  const upperLimit = row.upperLimit;
  if (upperLimit.status === "not_in_ruleset") {
    return upperLimitStatusLabel(upperLimit.status);
  }
  if (upperLimit.status === "not_evaluable") {
    return upperLimitStatusLabel(upperLimit.status);
  }
  return `Tolerable Upper Intake Level (UL): ${formatNutritionNumber(upperLimit.amount)} ${upperLimit.unit}/day for ${upperLimitIntakeScopeLabel(upperLimit.intakeScope)}`;
}

function tooltipTargetContext(row: MicronutrientSafetyReviewRow): string {
  if (row.adequacy == null) {
    return `Target: No ${DAILY_VALUE_TARGET_LABEL} target is available for this nutrient.`;
  }
  if (row.adequacy.status === "not_evaluable") {
    return `Target: ${DAILY_VALUE_TARGET_LABEL} target not evaluable<br/>
          Target status: Not evaluable<br/>
          Target source: ${escapeTooltipHtml(row.adequacy.reference.source.title)}<br/>
          Target guidance: ${escapeTooltipHtml(row.adequacy.message)}`;
  }
  return `Target: ${row.adequacy.percentDailyValue}% of ${DAILY_VALUE_TARGET_LABEL} (${row.adequacy.reference.amount} ${escapeTooltipHtml(row.unit)}/day)<br/>
          Target status: ${targetStatusLabel(row.adequacy.status)}<br/>
          Target source: ${escapeTooltipHtml(row.adequacy.reference.source.title)}<br/>
          Target guidance: ${escapeTooltipHtml(row.adequacy.message)}`;
}

function tooltipUpperLimitContext(row: MicronutrientSafetyReviewRow): string {
  const upperLimit = row.upperLimit;
  if (upperLimit.status === "not_in_ruleset") {
    return `<b>${escapeTooltipHtml(upperLimitSummary(row))}</b><br/>`;
  }
  if (upperLimit.status === "not_evaluable") {
    return `<b>${escapeTooltipHtml(upperLimitStatusLabel(upperLimit.status))}</b><br/>
          UL guidance: ${escapeTooltipHtml(upperLimit.message)}<br/>
          UL source: ${escapeTooltipHtml(upperLimit.source.title)}`;
  }
  return `<b>Tolerable Upper Intake Level (UL): ${upperLimit.amount} ${escapeTooltipHtml(upperLimit.unit)}/day for ${escapeTooltipHtml(upperLimitIntakeScopeLabel(upperLimit.intakeScope))}</b><br/>
          UL status: ${escapeTooltipHtml(upperLimitStatusLabel(upperLimit.status))}<br/>
          UL source: ${escapeTooltipHtml(upperLimit.source.title)}<br/>
          UL guidance: ${escapeTooltipHtml(upperLimit.message)}`;
}

function statusDetailClass(row: MicronutrientSafetyReviewRow): string {
  if (row.safetyStatus === "at_or_above_upper_limit") {
    return "border-red-300 bg-red-50";
  }
  if (row.safetyStatus === "upper_limit_not_evaluable") {
    return "border-amber-300 bg-amber-50";
  }
  return "border-border bg-surface-secondary";
}

function renderMicronutrientContextDetails({
  rows,
  selectedWindowDays,
}: {
  rows: MicronutrientSafetyReviewRow[];
  selectedWindowDays: number | null | undefined;
}) {
  return (
    <section
      aria-label="Micronutrient target and safety details"
      className="mt-4 space-y-2 text-xs text-muted"
    >
      {rows.map((row) => (
        <article
          key={row.nutrientId}
          aria-label={`${row.nutrient} target and upper-limit context`}
          className={`rounded-md border p-3 ${statusDetailClass(row)}`}
        >
          <h3 className="font-medium text-foreground">{row.nutrient}</h3>
          <dl className="mt-1 space-y-1">
            <div>
              <dt className="inline font-medium">Target: </dt>
              <dd className="inline">{targetSummary(row)}</dd>
            </div>
            {row.adequacy != null ? (
              <>
                <div>
                  <dt className="inline font-medium">Target status: </dt>
                  <dd className="inline">{targetStatusSummary(row)}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Target source: </dt>
                  <dd className="inline">
                    <a
                      className="underline"
                      href={row.adequacy.reference.source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.adequacy.reference.source.title}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">Target guidance: </dt>
                  <dd className="inline">{row.adequacy.message}</dd>
                </div>
              </>
            ) : null}
            <div>
              <dt className="inline font-medium">Safety limit: </dt>
              <dd className="inline">{upperLimitSummary(row)}</dd>
            </div>
            {row.upperLimit.status !== "not_in_ruleset" ? (
              <>
                <div>
                  <dt className="inline font-medium">UL status: </dt>
                  <dd className="inline">{upperLimitStatusLabel(row.upperLimit.status)}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">UL source: </dt>
                  <dd className="inline">
                    <a
                      className="underline"
                      href={row.upperLimit.source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.upperLimit.source.title}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">UL guidance: </dt>
                  <dd className="inline">{row.upperLimit.message}</dd>
                </div>
              </>
            ) : null}
            <div>
              <dt className="inline font-medium">Averaging period: </dt>
              <dd className="inline">
                Average over {row.intake.daysTracked} recorded days in{" "}
                {selectedWindowLabel(selectedWindowDays)}.
              </dd>
            </div>
          </dl>
        </article>
      ))}
    </section>
  );
}

export function MicronutrientChart({ data, loading, selectedWindowDays }: MicronutrientChartProps) {
  const visibleRows = data.filter(
    (row) => row.adequacy != null || row.upperLimit.status !== "not_in_ruleset",
  );
  const comparable = visibleRows.filter(
    (row) => row.adequacy?.status !== "not_evaluable" && row.adequacy != null,
  );
  const sorted = [...comparable].sort((a, b) => {
    const first = a.adequacy?.status !== "not_evaluable" ? a.adequacy?.percentDailyValue : 0;
    const second = b.adequacy?.status !== "not_evaluable" ? b.adequacy?.percentDailyValue : 0;
    return (first ?? 0) - (second ?? 0);
  });

  const option = {
    grid: { top: 10, right: 60, bottom: 30, left: 120 },
    tooltip: dofekTooltip({
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ name: string; value: number; dataIndex: number }>) => {
        const firstParam = params[0];
        if (!firstParam) return "";
        const row = sorted[firstParam.dataIndex];
        if (!row) return "";
        const adequacy = row.adequacy;
        if (adequacy == null || adequacy.status === "not_evaluable") return "";
        const nutrient = escapeTooltipHtml(row.nutrient);
        const unit = escapeTooltipHtml(row.unit);
        const sourceBreakdown = row.sourceBreakdown
          .map((source) => {
            const sourceLabel = escapeTooltipHtml(source.sourceLabel);
            const intakeType =
              source.intakeType === "itemized_food"
                ? "Itemized food"
                : source.intakeType === "provider_daily_total"
                  ? "Provider daily total"
                  : "Supplement";
            return `${sourceLabel} · ${intakeType}: ${source.dailyAverageContribution} ${unit}/day`;
          })
          .join("<br/>");
        return `<b>${nutrient}</b><br/>
          ${row.intake.totalDailyAverage} ${unit} / ${adequacy.reference.amount} ${unit}<br/>
          Itemized food: ${row.intake.foodDailyAverage} ${unit}/day<br/>
          Provider daily totals: ${row.intake.providerDailyTotalAverage} ${unit}/day<br/>
          Supplements: ${row.intake.supplementDailyAverage} ${unit}/day<br/>
          ${sourceBreakdown ? `<br/><b>Sources</b><br/>${sourceBreakdown}<br/>` : ""}
          <b>${adequacy.percentDailyValue}% of ${DAILY_VALUE_TARGET_LABEL} (adequacy reference, not a safety rating)</b><br/>
          ${tooltipTargetContext(row)}<br/>
          ${tooltipUpperLimitContext(row)}
          <span style="color:${chartThemeColors.axisLabel}">(average over ${row.intake.daysTracked} recorded days in ${selectedWindowLabel(selectedWindowDays)})</span>`;
      },
    }),
    xAxis: {
      ...dofekAxis.value({
        axisLabel: { formatter: (value: number) => `${value}%` },
      }),
      max: (value: { max: number }) => Math.max(value.max, 150),
    },
    yAxis: dofekAxis.category({
      data: sorted.map((row) => row.nutrient),
      axisLabel: { color: chartThemeColors.legendText, fontSize: 11 },
    }),
    series: [
      {
        type: "bar",
        data: sorted.map((row) => ({
          value:
            row.adequacy?.status !== "not_evaluable" ? (row.adequacy?.percentDailyValue ?? 0) : 0,
          itemStyle: {
            color:
              row.safetyStatus === "at_or_above_upper_limit"
                ? operationalStatusColors.danger.indicator
                : row.safetyStatus === "upper_limit_not_evaluable"
                  ? operationalStatusColors.warning.indicator
                  : operationalStatusColors.info.indicator,
          },
        })),
        barWidth: "60%",
        label: {
          show: true,
          position: "right" as const,
          color: chartThemeColors.legendText,
          fontSize: 11,
          formatter: (point: { value: number }) => `${point.value}%`,
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: chartThemeColors.tooltipBorder, type: "dashed" as const },
          data: [{ xAxis: 100 }],
          label: {
            show: true,
            position: "end" as const,
            formatter: `100% ${DAILY_VALUE_TARGET_LABEL}`,
            color: chartThemeColors.axisLabel,
          },
          tooltip: { show: false },
        },
      },
    ],
  };

  return (
    <>
      <DofekChart
        option={option}
        loading={loading}
        empty={comparable.length === 0}
        emptyMessage="No micronutrient target data available"
        height={Math.max(300, sorted.length * 28)}
      />
      {visibleRows.length > 0
        ? renderMicronutrientContextDetails({ rows: visibleRows, selectedWindowDays })
        : null}
    </>
  );
}
