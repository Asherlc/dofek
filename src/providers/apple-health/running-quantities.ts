interface RunningQuantityMapping {
  channel: string;
  field: string;
  unit: string;
  unitScales: Readonly<Record<string, number>>;
}

const metersPerUnit = {
  m: 1,
  mm: 0.001,
  cm: 0.01,
  km: 1000,
  ft: 0.3048,
  in: 0.0254,
  yd: 0.9144,
  mi: 1609.344,
};

/** Shared API/XML contract: factors convert reported units to each channel's canonical unit. */
export const RUNNING_QUANTITY_TYPES: Readonly<Record<string, RunningQuantityMapping>> = {
  HKQuantityTypeIdentifierRunningSpeed: {
    channel: "speed",
    field: "speed",
    unit: "m/s",
    unitScales: {
      "m/s": 1,
      "km/h": 1 / 3.6,
      "km/hr": 1 / 3.6,
      "mi/h": 0.44704,
      "mi/hr": 0.44704,
      mph: 0.44704,
      "ft/s": 0.3048,
      "cm/s": 0.01,
    },
  },
  HKQuantityTypeIdentifierRunningPower: {
    channel: "power",
    field: "power",
    unit: "W",
    unitScales: { W: 1, kW: 1000, mW: 0.001 },
  },
  HKQuantityTypeIdentifierRunningStrideLength: {
    channel: "stride_length",
    field: "strideLength",
    unit: "m",
    unitScales: metersPerUnit,
  },
  HKQuantityTypeIdentifierRunningGroundContactTime: {
    channel: "ground_contact_time",
    field: "groundContactTime",
    unit: "ms",
    unitScales: { ms: 1, s: 1000, min: 60000, h: 3600000 },
  },
  HKQuantityTypeIdentifierRunningVerticalOscillation: {
    channel: "vertical_oscillation",
    field: "verticalOscillation",
    unit: "mm",
    unitScales: Object.fromEntries(
      Object.entries(metersPerUnit).map(([unit, scale]) => [unit, scale * 1000]),
    ),
  },
};

/** Returns undefined for other quantities; running quantities must declare a compatible unit. */
export function normalizeRunningQuantity(
  type: string,
  value: number,
  unit: string | null,
): number | undefined {
  const mapping = RUNNING_QUANTITY_TYPES[type];
  if (!mapping) return undefined;
  const scale =
    unit !== null && Object.hasOwn(mapping.unitScales, unit) ? mapping.unitScales[unit] : undefined;
  if (scale === undefined) {
    throw new Error(
      `Unsupported unit "${unit ?? "missing"}" for ${type}. Expected ${Object.keys(mapping.unitScales).join(", ")} (stored as ${mapping.unit}).`,
    );
  }
  return value * scale;
}
