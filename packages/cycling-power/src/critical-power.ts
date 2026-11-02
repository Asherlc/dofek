import { linearRegression } from "./regression.ts";

export interface CriticalPowerFitPolicy {
  minimumDurationSeconds: number;
  maximumDurationSeconds: number;
}

export interface CriticalPowerModel {
  cp: number;
  wPrime: number;
  r2: number;
}

export interface CriticalPowerModelDiagnostics extends CriticalPowerModel {
  rmse: number;
  points: Array<{
    durationSeconds: number;
    observedPower: number;
    predictedPower: number;
    residualPower: number;
  }>;
}

/**
 * Fit the two-parameter Critical Power model (Monod-Scherrer).
 *
 * Model: P(t) = CP + W'/t
 * Linearized: Work = P*t = CP*t + W'
 * Linear regression of Work vs Time gives slope=CP, intercept=W'.
 *
 * The caller supplies the duration interval used for the fit.
 */
export function fitCriticalPowerWithDiagnostics(
  points: { durationSeconds: number; bestPower: number }[],
  policy: CriticalPowerFitPolicy,
): CriticalPowerModelDiagnostics | null {
  if (
    !Number.isFinite(policy.minimumDurationSeconds) ||
    !Number.isFinite(policy.maximumDurationSeconds) ||
    policy.minimumDurationSeconds <= 0 ||
    policy.maximumDurationSeconds < policy.minimumDurationSeconds
  ) {
    throw new Error("Invalid critical-power duration policy");
  }
  const valid = points.filter(
    (p) =>
      Number.isFinite(p.durationSeconds) &&
      Number.isFinite(p.bestPower) &&
      p.durationSeconds >= policy.minimumDurationSeconds &&
      p.durationSeconds <= policy.maximumDurationSeconds &&
      p.bestPower > 0,
  );
  if (valid.length < 3) return null;

  const xs = valid.map((p) => p.durationSeconds);
  const ys = valid.map((p) => p.bestPower * p.durationSeconds);
  if (ys.some((work) => !Number.isFinite(work))) return null;

  const { slope: cp, intercept: wPrime, r2 } = linearRegression(xs, ys);

  if (
    !Number.isFinite(cp) ||
    !Number.isFinite(wPrime) ||
    !Number.isFinite(r2) ||
    cp <= 0 ||
    wPrime <= 0
  )
    return null;

  const fittedPoints = valid.map((point) => {
    const predictedPower = cp + wPrime / point.durationSeconds;
    return {
      durationSeconds: point.durationSeconds,
      observedPower: point.bestPower,
      predictedPower: Math.round(predictedPower * 10) / 10,
      residualPower: Math.round((point.bestPower - predictedPower) * 10) / 10,
    };
  });
  const rmse = Math.sqrt(
    fittedPoints.reduce((total, point) => total + point.residualPower ** 2, 0) /
      fittedPoints.length,
  );

  return {
    cp: Math.round(cp),
    wPrime: Math.round(wPrime),
    r2: Math.round(r2 * 1000) / 1000,
    rmse: Math.round(rmse * 10) / 10,
    points: fittedPoints,
  };
}

/** Fit the stable three-field CP model used by existing analytics responses. */
export function fitCriticalPower(
  points: { durationSeconds: number; bestPower: number }[],
  policy: CriticalPowerFitPolicy,
): CriticalPowerModel | null {
  const model = fitCriticalPowerWithDiagnostics(points, policy);
  return model ? { cp: model.cp, wPrime: model.wPrime, r2: model.r2 } : null;
}
