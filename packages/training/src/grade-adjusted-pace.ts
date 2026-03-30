/**
 * Minetti cost factor model for grade-adjusted pace.
 *
 * Normalizes walking/hiking/trail-running pace to account for terrain grade,
 * allowing meaningful comparison between hilly and flat activities.
 *
 * Reference: Minetti et al. (2002) "Energy cost of walking and running at
 * extreme uphill and downhill slopes"
 */

/**
 * Compute the energy cost factor for a given terrain grade using a simplified
 * Minetti model.
 *
 * - Uphill (grade > 0): cost increases linearly at 3.5× the grade fraction.
 * - Downhill (grade < 0): cost decreases at 1.8× the grade fraction, floored
 *   at 0.5 (steep downhill is still effortful due to braking forces).
 * - Flat (grade = 0): cost factor is 1 (no adjustment).
 *
 * @param grade - Terrain grade as a decimal fraction (e.g. 0.10 = 10% grade).
 */
export function minettiCostFactor(grade: number): number {
  if (grade >= 0) {
    return 1 + grade * 3.5;
  }
  return Math.max(0.5, 1 - Math.abs(grade) * 1.8);
}

/**
 * Compute grade-adjusted pace by dividing actual pace by the Minetti cost factor.
 *
 * A steep uphill activity with a slow actual pace will produce a faster
 * grade-adjusted pace (the athlete was working harder than flat pace suggests).
 * Conversely, a fast downhill pace will adjust slower.
 *
 * @param actualPaceMinPerKm - Actual pace in minutes per kilometer.
 * @param grade - Terrain grade as a decimal fraction (e.g. 0.10 = 10% grade).
 * @returns Grade-adjusted pace in minutes per kilometer.
 */
export function computeGradeAdjustedPace(actualPaceMinPerKm: number, grade: number): number {
  return actualPaceMinPerKm / minettiCostFactor(grade);
}
