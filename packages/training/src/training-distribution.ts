import { HEART_RATE_ZONES } from "@dofek/zones/zones";

export interface KarvonenZoneWeek {
  zone0: number;
  zone1: number;
  zone2: number;
  zone3: number;
  zone4: number;
  zone5: number;
}

export interface IntensityDistributionZone {
  zone: number;
  label: string;
  seconds: number;
  percent: number;
}

export interface IntensityDistribution {
  model: "karvonen-five-zone";
  activityScope: "endurance";
  totalSeconds: number;
  zones: IntensityDistributionZone[];
  explanation: string;
}

export type PolarizationStatus = "polarized" | "not_polarized" | "insufficient_data";

export interface TreffPolarizationWeekInput {
  week: string;
  z1Seconds: number;
  z2Seconds: number;
  z3Seconds: number;
  polarizationIndex: number | null;
}

export interface TreffPolarizationWeek extends TreffPolarizationWeekInput {
  totalSeconds: number;
  zonePercentages: {
    z1: number;
    z2: number;
    z3: number;
  };
  status: PolarizationStatus;
  statusLabel: string;
  explanation: string;
}

const INTENSITY_EXPLANATION =
  "A descriptive view of endurance training time across the Karvonen five-zone heart-rate model. It does not classify training polarization.";

function roundedPercent(seconds: number, totalSeconds: number): number {
  return totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 1000) / 10 : 0;
}

export function buildKarvonenIntensityDistribution(
  weeks: KarvonenZoneWeek[],
): IntensityDistribution {
  const zoneSeconds = [
    weeks.reduce((sum, week) => sum + week.zone0, 0),
    weeks.reduce((sum, week) => sum + week.zone1, 0),
    weeks.reduce((sum, week) => sum + week.zone2, 0),
    weeks.reduce((sum, week) => sum + week.zone3, 0),
    weeks.reduce((sum, week) => sum + week.zone4, 0),
    weeks.reduce((sum, week) => sum + week.zone5, 0),
  ];
  const totalSeconds = zoneSeconds.reduce((sum, seconds) => sum + seconds, 0);

  return {
    model: "karvonen-five-zone",
    activityScope: "endurance",
    totalSeconds,
    zones: HEART_RATE_ZONES.map((zoneDefinition) => {
      const seconds = zoneSeconds[zoneDefinition.zone] ?? 0;
      return {
        zone: zoneDefinition.zone,
        label: zoneDefinition.label,
        seconds,
        percent: roundedPercent(seconds, totalSeconds),
      };
    }),
    explanation: INTENSITY_EXPLANATION,
  };
}

export function buildTreffPolarizationWeek(
  input: TreffPolarizationWeekInput,
): TreffPolarizationWeek {
  const totalSeconds = input.z1Seconds + input.z2Seconds + input.z3Seconds;
  const zonePercentages = {
    z1: roundedPercent(input.z1Seconds, totalSeconds),
    z2: roundedPercent(input.z2Seconds, totalSeconds),
    z3: roundedPercent(input.z3Seconds, totalSeconds),
  };

  if (input.polarizationIndex === null) {
    return {
      ...input,
      totalSeconds,
      zonePercentages,
      status: "insufficient_data",
      statusLabel: "Insufficient data",
      explanation: "Polarization needs recorded cycling time in all three Treff heart-rate zones.",
    };
  }

  if (input.polarizationIndex > 2) {
    return {
      ...input,
      totalSeconds,
      zonePercentages,
      status: "polarized",
      statusLabel: "Polarized",
      explanation: "This cycling week is polarized: it has a Treff polarization index above 2.00.",
    };
  }

  return {
    ...input,
    totalSeconds,
    zonePercentages,
    status: "not_polarized",
    statusLabel: "Not polarized",
    explanation:
      "This cycling week is not polarized because its Treff polarization index is 2.00 or lower.",
  };
}
