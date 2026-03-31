import { chartColors, statusColors } from "./colors.ts";

/**
 * Menstrual cycle phase computation.
 *
 * Four phases based on day within cycle:
 * 1. Menstrual (days 1-5): period bleeding
 * 2. Follicular (days 6 to ovulation-1): estrogen rises
 * 3. Ovulatory (around ovulation ±1 day): peak fertility
 * 4. Luteal (post-ovulation to end): progesterone dominant
 *
 * Ovulation is estimated at cycleLength - 14 (luteal phase is ~14 days).
 */

export type CyclePhase = "menstrual" | "follicular" | "ovulatory" | "luteal";

/**
 * Compute the cycle phase for a given day within a cycle.
 * @param dayOfCycle 1-based day number within the cycle
 * @param cycleLength Total cycle length in days (typically 21-35)
 */
export function computePhase(dayOfCycle: number, cycleLength: number): CyclePhase {
  // Menstrual phase: first 5 days
  if (dayOfCycle <= 5) {
    return "menstrual";
  }

  // Estimated ovulation day (luteal phase is roughly constant at 14 days)
  const ovulationDay = Math.max(6, cycleLength - 14);

  // Ovulatory window: ovulation day ± 1
  if (dayOfCycle >= ovulationDay - 1 && dayOfCycle <= ovulationDay + 1) {
    return "ovulatory";
  }

  // Follicular: between menstrual and ovulatory
  if (dayOfCycle < ovulationDay - 1) {
    return "follicular";
  }

  // Luteal: after ovulatory window
  return "luteal";
}

/** Display name and color for each phase */
export const PHASE_DISPLAY: Record<CyclePhase, { label: string; color: string }> = {
  menstrual: { label: "Menstrual", color: statusColors.danger },
  follicular: { label: "Follicular", color: statusColors.info },
  ovulatory: { label: "Ovulatory", color: chartColors.purple },
  luteal: { label: "Luteal", color: chartColors.amber },
};
