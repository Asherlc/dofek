import {
  formatBodyCompositionNumber,
  formatHRV,
  formatNumber,
  formatSpO2,
} from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import type { HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";

export function formatHealthCardValue({ metric, value }: HealthStatusMetric, units: UnitConverter) {
  if (metric === "trend_weight") return formatMeasurementText(units.formatWeight(value));
  if (metric === "skin_temperature") return formatMeasurementText(units.formatTemperature(value));
  if (metric === "spo2") return formatSpO2(value);
  if (value == null) return "—";
  if (metric === "hrv") return formatHRV(value);
  if (metric === "steps") return formatNumber(value, 0);
  if (metric === "respiratory_rate") return `${formatNumber(value)} breaths/min`;
  if (metric === "sleep_efficiency") return `${formatNumber(value)}%`;
  if (metric === "body_fat_percentage") return `${formatBodyCompositionNumber(value)}%`;
  return `${formatNumber(value, 0)} bpm`;
}

export function formatHealthCardComparison(
  { metric }: HealthStatusMetric,
  value: number,
  units: UnitConverter,
) {
  if (metric === "skin_temperature") {
    return formatMeasurementText(units.formatTemperature(value));
  }
  if (metric === "spo2") return formatSpO2(value);
  if (metric === "hrv") return formatHRV(value);
  if (metric === "steps") return formatNumber(value, 0);
  return formatNumber(value);
}

export function formatHealthCardComparisonDelta(
  metric: HealthStatusMetric,
  value: number,
  units: UnitConverter,
) {
  return metric.metric === "skin_temperature"
    ? formatMeasurementText(units.formatTemperatureDelta(value))
    : formatHealthCardComparison(metric, value, units);
}
