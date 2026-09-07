import { chartColors, statusColors } from "./colors.ts";

export type CyclePhase = "menstrual" | "follicular" | "ovulatory" | "luteal";

export const CYCLE_TRACKING_SAFETY_NOTICE =
  "Tracking estimates only. Do not use for birth control or diagnosis.";

/** Estimate a phase from a one-based cycle day and an observed average cycle length. */
export function computePhase(dayOfCycle: number, cycleLength: number): CyclePhase {
  if (dayOfCycle <= 5) return "menstrual";

  const ovulationDay = Math.max(6, cycleLength - 14);
  if (dayOfCycle >= ovulationDay - 1 && dayOfCycle <= ovulationDay + 1) {
    return "ovulatory";
  }
  if (dayOfCycle < ovulationDay - 1) return "follicular";
  return "luteal";
}

export const PHASE_DISPLAY: Record<CyclePhase, { label: string; color: string }> = {
  menstrual: { label: "Menstrual", color: statusColors.danger },
  follicular: { label: "Follicular", color: statusColors.info },
  ovulatory: { label: "Ovulatory", color: chartColors.purple },
  luteal: { label: "Luteal", color: chartColors.amber },
};
