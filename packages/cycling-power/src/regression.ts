/** Simple linear regression: y = slope * x + intercept */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  if (xs.length !== ys.length) {
    throw new RangeError("Regression requires equal-length paired arrays");
  }
  for (let index = 0; index < xs.length; index++) {
    if (!Number.isFinite(xs[index]) || !Number.isFinite(ys[index])) {
      throw new RangeError("Regression pairs must contain finite values");
    }
  }
  const pointCount = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * (ys[i] ?? 0), 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);

  const denom = pointCount * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };

  const slope = (pointCount * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / pointCount;

  const yMean = sumY / pointCount;
  const ssTotal = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
  const ssResidual = ys.reduce((a, y, i) => a + (y - (slope * (xs[i] ?? 0) + intercept)) ** 2, 0);
  const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

  return { slope, intercept, r2 };
}
