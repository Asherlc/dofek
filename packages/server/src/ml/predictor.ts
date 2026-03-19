/**
 * Prediction orchestrator.
 *
 * Trains both a linear regression and gradient-boosted tree model
 * on daily health data for a given target, then returns predictions,
 * feature importances, and model diagnostics.
 */

import type { DailyFeatureRow, ExtractedDataset, PredictionTarget } from "./features.ts";
import { buildDataset, PREDICTION_TARGETS } from "./features.ts";
import { GradientBoostedTrees } from "./gradient-boost.ts";
import { LinearRegression } from "./regression.ts";

export interface FeatureImportance {
  name: string;
  linearImportance: number;
  treeImportance: number;
  linearCoefficient: number;
}

export interface PredictionPoint {
  date: string;
  actual: number;
  linearPrediction: number;
  treePrediction: number;
}

export interface ModelDiagnostics {
  linearRSquared: number;
  linearAdjustedRSquared: number;
  treeRSquared: number;
  crossValidatedRSquared: number;
  sampleCount: number;
  featureCount: number;
  linearFallbackUsed: boolean;
}

export interface PredictionResult {
  targetId: string;
  targetLabel: string;
  targetUnit: string;
  featureImportances: FeatureImportance[];
  predictions: PredictionPoint[];
  diagnostics: ModelDiagnostics;
  tomorrowPrediction: {
    linear: number;
    tree: number;
  } | null;
}

/**
 * Train both models for a given target and return predictions + importances.
 *
 * Uses 5-fold cross-validation for the tree model to estimate
 * out-of-sample performance (guards against overfitting).
 */
export function trainPredictor(
  days: DailyFeatureRow[],
  target: PredictionTarget,
): PredictionResult | null {
  const dataset = buildDataset(days, target);
  if (!dataset) return null;

  const { featureNames, X, y, dates } = dataset;

  // Linear regression can fail on singular/underdetermined feature matrices.
  // When that happens, keep serving tree-based predictions instead of erroring.
  const linear = fitLinearSafely(X, y);

  // Train gradient-boosted trees
  const tree = new GradientBoostedTrees({
    nEstimators: 100,
    maxDepth: 4,
    learningRate: 0.05,
    minSamplesLeaf: Math.max(3, Math.floor(X.length * 0.05)),
  });
  tree.fit(X, y);

  // 5-fold cross-validation for tree model
  const cvRSquared = crossValidate(X, y, 5);

  // Feature importances (sorted by tree importance descending)
  const importances: FeatureImportance[] = featureNames.map((name, i) => ({
    name,
    linearImportance: linear?.featureImportances[i] ?? 0,
    treeImportance: tree.featureImportances[i] ?? 0,
    linearCoefficient: linear?.coefficients[i] ?? 0,
  }));
  importances.sort((a, b) => b.treeImportance - a.treeImportance);

  // Generate predictions for each data point
  const predictions: PredictionPoint[] = X.map((features, i) => ({
    date: dates[i] ?? "",
    actual: y[i] ?? 0,
    linearPrediction: round2(predictLinearOrFallback(linear, tree, features)),
    treePrediction: round2(tree.predict(features)),
  }));

  // Predict tomorrow using today's data (last row of input)
  let tomorrowPrediction: PredictionResult["tomorrowPrediction"] = null;
  if (X.length > 0) {
    const lastFeatures = X[X.length - 1];
    if (!lastFeatures) return null;
    tomorrowPrediction = {
      linear: round2(predictLinearOrFallback(linear, tree, lastFeatures)),
      tree: round2(tree.predict(lastFeatures)),
    };
  }

  return {
    targetId: target.id,
    targetLabel: target.label,
    targetUnit: target.unit,
    featureImportances: importances,
    predictions,
    diagnostics: {
      linearRSquared: round4(linear?.rSquared ?? 0),
      linearAdjustedRSquared: round4(linear?.adjustedRSquared ?? 0),
      treeRSquared: round4(tree.rSquared),
      crossValidatedRSquared: round4(cvRSquared),
      sampleCount: X.length,
      featureCount: featureNames.length,
      linearFallbackUsed: linear == null,
    },
    tomorrowPrediction,
  };
}

/**
 * Train both models from a pre-built dataset.
 * Used by activity-level predictions where the dataset is built by a
 * different pipeline than the daily feature builder.
 */
export function trainFromDataset(
  dataset: ExtractedDataset,
  targetId: string,
  targetLabel: string,
  targetUnit: string,
): PredictionResult {
  const { featureNames, X, y, dates } = dataset;

  // Activity datasets can be especially collinear (trailing aggregates + sparse
  // imputed columns). Fall back to tree-only predictions if linear fit fails.
  const linear = fitLinearSafely(X, y);

  const tree = new GradientBoostedTrees({
    nEstimators: 100,
    maxDepth: 4,
    learningRate: 0.05,
    minSamplesLeaf: Math.max(3, Math.floor(X.length * 0.05)),
  });
  tree.fit(X, y);

  const cvRSquared = crossValidate(X, y, 5);

  const importances: FeatureImportance[] = featureNames.map((name, i) => ({
    name,
    linearImportance: linear?.featureImportances[i] ?? 0,
    treeImportance: tree.featureImportances[i] ?? 0,
    linearCoefficient: linear?.coefficients[i] ?? 0,
  }));
  importances.sort((a, b) => b.treeImportance - a.treeImportance);

  const predictions: PredictionPoint[] = X.map((features, i) => ({
    date: dates[i] ?? "",
    actual: y[i] ?? 0,
    linearPrediction: round2(predictLinearOrFallback(linear, tree, features)),
    treePrediction: round2(tree.predict(features)),
  }));

  // Activity-level predictions include in-session features (e.g. duration,
  // avg HR, set count) that are only known *during* the workout, so we cannot
  // meaningfully predict the "next" session from the last row's feature vector.
  const tomorrowPrediction: PredictionResult["tomorrowPrediction"] = null;

  return {
    targetId,
    targetLabel,
    targetUnit,
    featureImportances: importances,
    predictions,
    diagnostics: {
      linearRSquared: round4(linear?.rSquared ?? 0),
      linearAdjustedRSquared: round4(linear?.adjustedRSquared ?? 0),
      treeRSquared: round4(tree.rSquared),
      crossValidatedRSquared: round4(cvRSquared),
      sampleCount: X.length,
      featureCount: featureNames.length,
      linearFallbackUsed: linear == null,
    },
    tomorrowPrediction,
  };
}

/** Convenience wrapper: train HRV predictor (default target) */
export function trainHrvPredictor(days: DailyFeatureRow[]): PredictionResult | null {
  const target = PREDICTION_TARGETS.find((t) => t.id === "hrv");
  if (!target) return null;
  return trainPredictor(days, target);
}

/**
 * K-fold cross-validation for gradient-boosted trees.
 * Returns average R² across folds.
 */
function crossValidate(X: number[][], y: number[], k: number): number {
  const n = X.length;
  if (n < k * 5) return 0; // Not enough data for meaningful CV

  const foldSize = Math.floor(n / k);
  let totalSsRes = 0;
  let totalSsTot = 0;

  for (let fold = 0; fold < k; fold++) {
    const testStart = fold * foldSize;
    const testEnd = fold === k - 1 ? n : testStart + foldSize;

    const trainX: number[][] = [];
    const trainY: number[] = [];
    const testX: number[][] = [];
    const testY: number[] = [];

    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      const yi = y[i]!;
      if (i >= testStart && i < testEnd) {
        testX.push(xi);
        testY.push(yi);
      } else {
        trainX.push(xi);
        trainY.push(yi);
      }
    }

    if (trainX.length < 10 || testX.length < 2) continue;

    const model = new GradientBoostedTrees({
      nEstimators: 100,
      maxDepth: 4,
      learningRate: 0.05,
      minSamplesLeaf: Math.max(3, Math.floor(trainX.length * 0.05)),
    });
    model.fit(trainX, trainY);

    const testMean = testY.reduce((a, b) => a + b, 0) / testY.length;
    for (let i = 0; i < testX.length; i++) {
      const testXi = testX[i]!;
      const testYi = testY[i]!;
      const pred = model.predict(testXi);
      totalSsRes += (testYi - pred) ** 2;
      totalSsTot += (testYi - testMean) ** 2;
    }
  }

  return totalSsTot === 0 ? 0 : 1 - totalSsRes / totalSsTot;
}

function fitLinearSafely(X: number[][], y: number[]): LinearRegression | null {
  const linear = new LinearRegression();
  try {
    linear.fit(X, y);
    return linear;
  } catch {}
  return null;
}

function predictLinearOrFallback(
  linear: LinearRegression | null,
  tree: GradientBoostedTrees,
  x: number[],
): number {
  return linear ? linear.predict(x) : tree.predict(x);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
