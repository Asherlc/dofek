export interface AccessibleChartRow {
  series: string;
  category: string;
  value: string;
}

export interface AccessibleChartTable {
  categoryHeader: string;
  rows: AccessibleChartRow[];
}

export function buildChartSummary(option: Record<string, unknown>): string {
  const explicitDescription = getExplicitDescription(option);
  if (explicitDescription !== null) return explicitDescription;

  const seriesNames = getSeries(option).flatMap((seriesItem) =>
    typeof seriesItem.name === "string" && seriesItem.name.trim().length > 0
      ? [seriesItem.name.trim()]
      : [],
  );
  const uniqueSeriesNames = [...new Set(seriesNames)];
  const tableHint = hasChartTableData(option) ? " Use the chart data table for exact values." : "";
  if (uniqueSeriesNames.length > 0) {
    return `Chart showing ${formatList(uniqueSeriesNames)}.${tableHint}`;
  }

  const axisNames = getAxes(option).flatMap((axis) =>
    typeof axis.name === "string" && axis.name.trim().length > 0 ? [axis.name.trim()] : [],
  );
  const uniqueAxisNames = [...new Set(axisNames)];
  if (uniqueAxisNames.length > 0) {
    return `Chart comparing ${formatList(uniqueAxisNames)}.${tableHint}`;
  }

  const seriesTypes = getSeries(option).flatMap((seriesItem) =>
    typeof seriesItem.type === "string" && seriesItem.type.trim().length > 0
      ? [seriesItem.type.trim()]
      : [],
  );
  const firstSeriesType = seriesTypes[0];
  if (firstSeriesType !== undefined) {
    return `${formatChartType(firstSeriesType)} chart.${tableHint}`;
  }

  return `Chart.${tableHint}`;
}

export function addChartAria(
  option: Record<string, unknown>,
  description: string,
): Record<string, unknown> {
  const aria = isRecord(option.aria) ? option.aria : {};
  const label = isRecord(aria.label) ? aria.label : {};

  return {
    ...option,
    aria: {
      ...aria,
      enabled: true,
      label: {
        ...label,
        description,
      },
    },
  };
}

export function hasChartTableData(option: Record<string, unknown>): boolean {
  return getSeries(option).some(
    (seriesItem) => Array.isArray(seriesItem.data) && seriesItem.data.length > 0,
  );
}

export function buildChartTable(option: Record<string, unknown>): AccessibleChartTable {
  const categoryAxis = getAxes(option).find((axis) => Array.isArray(axis.data));
  const categoryValues = Array.isArray(categoryAxis?.data) ? categoryAxis.data : [];
  const namedXAxis = toRecords(option.xAxis).find(
    (axis) => typeof axis.name === "string" && axis.name.trim().length > 0,
  );
  const categoryHeader =
    categoryAxis !== undefined
      ? typeof categoryAxis.name === "string" && categoryAxis.name.trim().length > 0
        ? categoryAxis.name.trim()
        : "Category"
      : typeof namedXAxis?.name === "string"
        ? namedXAxis.name.trim()
        : "Category";

  const rows = getSeries(option).flatMap((seriesItem, seriesIndex) => {
    if (!Array.isArray(seriesItem.data)) return [];
    const series =
      typeof seriesItem.name === "string" && seriesItem.name.trim().length > 0
        ? seriesItem.name.trim()
        : `Series ${seriesIndex + 1}`;

    return seriesItem.data.map((datum, datumIndex) =>
      buildRow(datum, datumIndex, series, categoryValues),
    );
  });

  return { categoryHeader, rows };
}

function getExplicitDescription(option: Record<string, unknown>): string | null {
  if (!isRecord(option.aria) || !isRecord(option.aria.label)) return null;
  const description = option.aria.label.description;
  return typeof description === "string" && description.trim().length > 0
    ? description.trim()
    : null;
}

function getSeries(option: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(option.series)) return option.series.filter(isRecord);
  return isRecord(option.series) ? [option.series] : [];
}

function getAxes(option: Record<string, unknown>): Record<string, unknown>[] {
  return [...toRecords(option.xAxis), ...toRecords(option.yAxis)];
}

function toRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function buildRow(
  datum: unknown,
  datumIndex: number,
  series: string,
  categoryValues: unknown[],
): AccessibleChartRow {
  const datumName = isRecord(datum) && typeof datum.name === "string" ? datum.name : null;
  const rawValue = isRecord(datum) && "value" in datum ? datum.value : datum;
  const tuple = Array.isArray(rawValue) ? rawValue : null;
  const tupleCategory = tuple !== null && tuple.length > 1 ? tuple[0] : undefined;
  const categorySource = datumName ?? tupleCategory ?? categoryValues[datumIndex] ?? datumIndex + 1;
  const valueSource =
    tuple !== null && tuple.length > 1
      ? tuple.length === 2
        ? tuple[1]
        : tuple.slice(1)
      : rawValue;

  return {
    series,
    category: formatCellValue(categorySource),
    value: formatCellValue(valueSource),
  };
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "No value";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(formatCellValue).join(", ");
  if (isRecord(value)) {
    if ("value" in value) return formatCellValue(value.value);
    if (typeof value.name === "string") return value.name;
  }
  return "Value unavailable";
}

function formatList(values: string[]): string {
  if (values.length === 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function formatChartType(seriesType: string): string {
  if (seriesType === "heatmap") return "Heat map";
  return `${seriesType.charAt(0).toUpperCase()}${seriesType.slice(1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
