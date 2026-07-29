type FormatMeasuredValue = (value: number) => string;

function formatAvailableMeasurement(
  value: number | null,
  formatMeasured: FormatMeasuredValue,
  unavailableText: string,
): string {
  return value === null ? unavailableText : formatMeasured(value);
}

export function formatActivityOverviewDistance(
  distanceMeters: number | null,
  formatMeasured: FormatMeasuredValue,
): string {
  return formatAvailableMeasurement(distanceMeters, formatMeasured, "Distance not recorded");
}

export function formatActivityOverviewElevation(
  elevationMeters: number | null,
  formatMeasured: FormatMeasuredValue,
): string {
  return formatAvailableMeasurement(elevationMeters, formatMeasured, "Elevation unavailable");
}
