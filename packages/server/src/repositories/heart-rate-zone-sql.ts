import { HEART_RATE_ZONES } from "@dofek/zones/zones";

interface HeartRateZoneSqlExpressions {
  maxHr: string;
  restingHr: string;
}

const queryParamHeartRateExpressions: HeartRateZoneSqlExpressions = {
  maxHr: "{maxHr:Float64}",
  restingHr: "{restingHr:Float64}",
};

function boundaryExpression(paramName: string, expressions: HeartRateZoneSqlExpressions): string {
  return `${expressions.restingHr} + (${expressions.maxHr} - ${expressions.restingHr}) * {${paramName}:Float64}`;
}

function zoneParamName(zone: number, boundary: "min" | "max"): string {
  return `heartRateZone${zone}${boundary === "min" ? "Min" : "Max"}PctHrr`;
}

function heartRateZoneCondition(
  scalarExpression: string,
  minParamName: string,
  maxParamName: string,
  isFirstZone: boolean,
  isLastZone: boolean,
  expressions: HeartRateZoneSqlExpressions,
): string {
  if (isFirstZone) {
    return `${scalarExpression} < ${boundaryExpression(maxParamName, expressions)}`;
  }
  if (isLastZone) {
    return `${scalarExpression} >= ${boundaryExpression(minParamName, expressions)}`;
  }
  return `${scalarExpression} >= ${boundaryExpression(minParamName, expressions)}
                AND ${scalarExpression} < ${boundaryExpression(maxParamName, expressions)}`;
}

export function heartRateZoneSqlParams(): Record<string, number> {
  return Object.fromEntries(
    HEART_RATE_ZONES.flatMap((zone) => [
      [zoneParamName(zone.zone, "min"), zone.minPctHrr],
      [zoneParamName(zone.zone, "max"), zone.maxPctHrr],
    ]),
  );
}

export function heartRateZoneCountColumns(
  scalarExpression: string,
  expressions: HeartRateZoneSqlExpressions = queryParamHeartRateExpressions,
): string {
  return HEART_RATE_ZONES.map((zone, index) => {
    const isFirstZone = index === 0;
    const isLastZone = index === HEART_RATE_ZONES.length - 1;
    const condition = heartRateZoneCondition(
      scalarExpression,
      zoneParamName(zone.zone, "min"),
      zoneParamName(zone.zone, "max"),
      isFirstZone,
      isLastZone,
      expressions,
    );
    return `countIf(${condition}) AS zone${zone.zone}`;
  }).join(",\n          ");
}

export function heartRateZoneSumColumns(): string {
  return HEART_RATE_ZONES.map((zone) => `sum(zone${zone.zone}) AS zone${zone.zone}`).join(
    ",\n        ",
  );
}

export function heartRateZoneWeightedCountColumns(
  scalarExpression: string,
  weightExpression: string,
  expressions: HeartRateZoneSqlExpressions,
): string {
  return HEART_RATE_ZONES.map((zone, index) => {
    const condition = heartRateZoneCondition(
      scalarExpression,
      zoneParamName(zone.zone, "min"),
      zoneParamName(zone.zone, "max"),
      index === 0,
      index === HEART_RATE_ZONES.length - 1,
      expressions,
    );
    return `sumIf(${weightExpression}, ${condition}) AS zone${zone.zone}`;
  }).join(",\n          ");
}
