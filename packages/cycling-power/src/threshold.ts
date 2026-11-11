import { intensityFactor, powerDose, powerTrainingStress } from "./power.ts";

export interface ReferenceCurve {
  criticalPowerWatts: number;
  workCapacityJoules: number;
  timeOffsetSeconds: number;
}
export interface PowerEffort {
  durationSeconds: number;
  watts: number;
}
export interface ThresholdCandidate {
  watts: number;
  effort: PowerEffort;
}
export interface ThresholdPolicy {
  minimumDurationSeconds: number;
  maximumDurationSeconds: number;
  targetDurationSeconds: number;
}
export interface PowerObservation {
  id: string;
  atSeconds: number;
  durationSeconds: number;
  normalizedPowerWatts: number | null;
  candidate: ThresholdCandidate | null;
}
export interface HistoryPolicy {
  comparisonWindowDays: number;
  minimumHistoryDays: number;
  maximumDailyDecayFraction: number;
}
export interface ThresholdEvidence {
  id: string;
  atSeconds: number;
  effort: PowerEffort;
}
export interface HistoryPoint {
  atSeconds: number;
  id: string | null;
  thresholdWatts: number | null;
  evidence: ThresholdEvidence | null;
  normalizedPowerWatts: number | null;
  intensityFactor: number | null;
  trainingStressScore: number | null;
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Morton's three-parameter power-duration equation. */
export function modelPower(curve: ReferenceCurve, durationSeconds: number): number {
  if (
    !positive(curve.criticalPowerWatts) ||
    !positive(curve.workCapacityJoules) ||
    !positive(curve.timeOffsetSeconds) ||
    !positive(durationSeconds)
  ) {
    throw new Error("Curve parameters and duration must be finite and positive");
  }
  return (
    curve.criticalPowerWatts +
    curve.workCapacityJoules / (durationSeconds + curve.timeOffsetSeconds)
  );
}

/** Match each effort to the supplied reference family; never extrapolate tails. */
export function estimateThreshold(
  efforts: readonly PowerEffort[],
  curves: readonly ReferenceCurve[],
  policy: ThresholdPolicy,
): ThresholdCandidate | null {
  if (
    !positive(policy.minimumDurationSeconds) ||
    !positive(policy.maximumDurationSeconds) ||
    policy.maximumDurationSeconds < policy.minimumDurationSeconds ||
    !positive(policy.targetDurationSeconds)
  )
    throw new Error("Invalid threshold duration policy");
  if (curves.length < 2) throw new Error("At least two reference curves are required");
  const targets = curves.map((curve) => modelPower(curve, policy.targetDurationSeconds));
  if (targets.some((value, i) => i > 0 && value <= (targets[i - 1] ?? 0)))
    throw new Error("Reference curves must be strictly ordered");
  let best: ThresholdCandidate | null = null;
  for (const effort of efforts) {
    if (
      !positive(effort.watts) ||
      !positive(effort.durationSeconds) ||
      effort.durationSeconds < policy.minimumDurationSeconds ||
      effort.durationSeconds > policy.maximumDurationSeconds
    )
      continue;
    const anchors = curves.map((curve) => modelPower(curve, effort.durationSeconds));
    if (anchors.some((value, i) => i > 0 && value <= (anchors[i - 1] ?? 0)))
      throw new Error("Reference curves must be strictly ordered throughout the qualifying range");
    const low = anchors[0];
    const high = anchors.at(-1);
    if (low === undefined || high === undefined || effort.watts < low || effort.watts > high)
      continue;
    let upper = anchors.findIndex((value) => value >= effort.watts);
    if (upper === 0) upper = 1;
    const lower = upper - 1;
    const lowerAnchor = anchors[lower];
    const upperAnchor = anchors[upper];
    const lowerTarget = targets[lower];
    const upperTarget = targets[upper];
    if (
      lowerAnchor === undefined ||
      upperAnchor === undefined ||
      lowerTarget === undefined ||
      upperTarget === undefined
    )
      continue;
    const fraction = (effort.watts - lowerAnchor) / (upperAnchor - lowerAnchor);
    const watts = lowerTarget + fraction * (upperTarget - lowerTarget);
    if (
      best === null ||
      watts > best.watts ||
      (watts === best.watts && effort.durationSeconds > best.effort.durationSeconds)
    )
      best = { watts, effort: { ...effort } };
  }
  return best;
}

/** Chronological recurrence. All numerical policy is provided by the caller. */
export function projectThresholdHistory(
  observations: readonly PowerObservation[],
  asOfSeconds: number,
  policy: HistoryPolicy,
): HistoryPoint[] {
  if (
    !Number.isInteger(policy.comparisonWindowDays) ||
    policy.comparisonWindowDays < 1 ||
    !Number.isInteger(policy.minimumHistoryDays) ||
    policy.minimumHistoryDays < 2 * policy.comparisonWindowDays
  )
    throw new Error("Invalid history comparison policy");
  if (
    !Number.isFinite(policy.maximumDailyDecayFraction) ||
    policy.maximumDailyDecayFraction < 0 ||
    policy.maximumDailyDecayFraction >= 1
  )
    throw new Error("Invalid daily decay fraction");
  if (!Number.isFinite(asOfSeconds)) throw new Error("Invalid history end time");
  const ids = new Set<string>();
  for (const observation of observations) {
    if (ids.has(observation.id)) throw new Error("Observation identifiers must be unique");
    ids.add(observation.id);
    if (
      !observation.id ||
      !Number.isFinite(observation.atSeconds) ||
      !positive(observation.durationSeconds)
    )
      throw new Error("Invalid power observation");
    if (
      observation.normalizedPowerWatts !== null &&
      (!Number.isFinite(observation.normalizedPowerWatts) || observation.normalizedPowerWatts < 0)
    )
      throw new Error("Invalid normalized power observation");
    if (
      observation.candidate !== null &&
      (!positive(observation.candidate.watts) ||
        !positive(observation.candidate.effort.durationSeconds) ||
        !positive(observation.candidate.effort.watts))
    )
      throw new Error("Invalid threshold candidate effort");
  }
  const ordered = observations
    .filter((point) => point.atSeconds <= asOfSeconds)
    .sort((a, b) => a.atSeconds - b.atSeconds || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const first = ordered[0];
  if (!first) return [];
  const daySeconds = 86400;
  const windowDays = 2 * policy.comparisonWindowDays;
  const doses = new Array<number>(windowDays).fill(0);
  const unknown = new Array<boolean>(windowDays).fill(false);
  let thresholdWatts: number | null = null;
  let evidence: ThresholdEvidence | null = null;
  let cursor = 0;
  const history: HistoryPoint[] = [];
  const firstDay = Math.floor(first.atSeconds / daySeconds);
  const finalDay = Math.floor(asOfSeconds / daySeconds);
  const append = (atSeconds: number, observation: PowerObservation | null) => {
    history.push({
      atSeconds,
      id: observation?.id ?? null,
      thresholdWatts,
      evidence: evidence ? { ...evidence, effort: { ...evidence.effort } } : null,
      normalizedPowerWatts: observation?.normalizedPowerWatts ?? null,
      intensityFactor: observation
        ? intensityFactor(observation.normalizedPowerWatts, thresholdWatts)
        : null,
      trainingStressScore: observation
        ? powerTrainingStress(
            observation.normalizedPowerWatts,
            thresholdWatts,
            observation.durationSeconds,
          )
        : null,
    });
  };
  for (let day = firstDay; day <= finalDay; day++) {
    // Compare completed days before considering this day's activity evidence.
    if (
      day - firstDay >= policy.minimumHistoryDays &&
      thresholdWatts !== null &&
      !unknown.some(Boolean)
    ) {
      const prior = doses.slice(0, policy.comparisonWindowDays).reduce((a, b) => a + b, 0);
      const recent = doses.slice(policy.comparisonWindowDays).reduce((a, b) => a + b, 0);
      const ratio = prior > 0 ? Math.min(1, recent / prior) : recent > 0 ? 1 : 0;
      thresholdWatts *= 1 - policy.maximumDailyDecayFraction * (1 - ratio);
    }
    doses.shift();
    doses.push(0);
    unknown.shift();
    unknown.push(false);
    append(day * daySeconds, null);
    while (cursor < ordered.length) {
      const observation = ordered[cursor];
      if (!observation || Math.floor(observation.atSeconds / daySeconds) !== day) break;
      if (
        observation.candidate !== null &&
        (thresholdWatts === null || observation.candidate.watts > thresholdWatts)
      ) {
        thresholdWatts = observation.candidate.watts;
        evidence = {
          id: observation.id,
          atSeconds: observation.atSeconds,
          effort: { ...observation.candidate.effort },
        };
      }
      const dose = powerDose(observation.normalizedPowerWatts, observation.durationSeconds);
      if (dose === null) unknown[windowDays - 1] = true;
      else doses[windowDays - 1] = (doses[windowDays - 1] ?? 0) + dose;
      append(observation.atSeconds, observation);
      cursor++;
    }
  }
  return history;
}
