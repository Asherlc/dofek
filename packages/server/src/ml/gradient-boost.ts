/**
 * Gradient-boosted regression trees (GBRT).
 *
 * A minimal, pure TypeScript implementation:
 * - CART regression trees with MSE splits
 * - Gradient boosting with squared error loss
 * - Feature importance from split variance reduction
 */

// ── Types ───────────────────────────────────────────────────────────────────

interface TreeNode {
  featureIndex?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
  value?: number; // leaf prediction
}

interface TreeNodeJSON {
  f?: number; // featureIndex
  t?: number; // threshold
  l?: TreeNodeJSON; // left
  r?: TreeNodeJSON; // right
  v?: number; // value
}

export interface GradientBoostedTreesConfig {
  nEstimators: number;
  maxDepth: number;
  learningRate: number;
  minSamplesLeaf: number;
  subsampleRatio?: number;
}

export interface GradientBoostedTreesJSON {
  config: GradientBoostedTreesConfig;
  basePrediction: number;
  trees: TreeNodeJSON[];
  featureImportances: number[];
  rSquared: number;
  nFeatures: number;
}

const DEFAULT_CONFIG: GradientBoostedTreesConfig = {
  nEstimators: 100,
  maxDepth: 4,
  learningRate: 0.1,
  minSamplesLeaf: 5,
  subsampleRatio: 1.0,
};

// ── Gradient Boosted Trees ─────────────────────────────────────────────────

export class GradientBoostedTrees {
  #config: GradientBoostedTreesConfig;
  #basePrediction = 0;
  #trees: TreeNode[] = [];
  #featureImportances: number[] = [];
  #rSquared = 0;
  #nFeatures = 0;

  constructor(config?: Partial<GradientBoostedTreesConfig>) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  get featureImportances(): number[] {
    return this.#featureImportances;
  }

  get rSquared(): number {
    return this.#rSquared;
  }

  fit(X: number[][], y: number[]): void {
    const n = X.length;
    const p = X[0]?.length ?? 0;

    if (n !== y.length) {
      throw new Error(`X has ${n} rows but y has ${y.length} elements`);
    }

    this.#nFeatures = p;
    this.#basePrediction = mean(y);
    this.#trees = [];

    // Raw importances per feature (accumulated variance reduction)
    const rawImportances = new Array<number>(p).fill(0);

    // Initialize predictions to the base (mean)
    const predictions = new Array<number>(n).fill(this.#basePrediction);

    for (let iter = 0; iter < this.#config.nEstimators; iter++) {
      // Compute negative gradient (residuals for MSE loss)
      const residuals = y.map((yi, i) => (yi ?? 0) - (predictions[i] ?? 0));

      // Build a regression tree on residuals
      const indices = Array.from({ length: n }, (_, i) => i);
      const tree = this.#buildTree(X, residuals, indices, 0, rawImportances);
      this.#trees.push(tree);

      // Update predictions
      for (let i = 0; i < n; i++) {
        predictions[i] =
          (predictions[i] ?? 0) + this.#config.learningRate * predictNode(tree, X[i] ?? []);
      }
    }

    // Normalize feature importances to sum to 1
    const totalImportance = rawImportances.reduce((a, b) => a + b, 0);
    this.#featureImportances =
      totalImportance > 0 ? rawImportances.map((v) => v / totalImportance) : rawImportances;

    // Compute R² on training data
    const yMean = mean(y);
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < n; i++) {
      ssRes += ((y[i] ?? 0) - (predictions[i] ?? 0)) ** 2;
      ssTot += ((y[i] ?? 0) - yMean) ** 2;
    }
    this.#rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  }

  predict(x: number[]): number {
    let pred = this.#basePrediction;
    for (const tree of this.#trees) {
      pred += this.#config.learningRate * predictNode(tree, x);
    }
    return pred;
  }

  toJSON(): GradientBoostedTreesJSON {
    return {
      config: this.#config,
      basePrediction: this.#basePrediction,
      trees: this.#trees.map(serializeNode),
      featureImportances: this.#featureImportances,
      rSquared: this.#rSquared,
      nFeatures: this.#nFeatures,
    };
  }

  static fromJSON(json: GradientBoostedTreesJSON): GradientBoostedTrees {
    const model = new GradientBoostedTrees(json.config);
    model.#basePrediction = json.basePrediction;
    model.#trees = json.trees.map(deserializeNode);
    model.#featureImportances = json.featureImportances;
    model.#rSquared = json.rSquared;
    model.#nFeatures = json.nFeatures;
    return model;
  }

  // ── Tree building ──────────────────────────────────────────────────────

  #buildTree(
    X: number[][],
    y: number[],
    indices: number[],
    depth: number,
    importances: number[],
  ): TreeNode {
    // Leaf conditions
    if (depth >= this.#config.maxDepth || indices.length <= this.#config.minSamplesLeaf * 2) {
      return { value: meanOfIndices(y, indices) };
    }

    const best = this.#findBestSplit(X, y, indices);
    if (!best) {
      return { value: meanOfIndices(y, indices) };
    }

    // Accumulate feature importance (variance reduction * n samples)
    importances[best.featureIndex] =
      (importances[best.featureIndex] ?? 0) + best.gain * indices.length;

    const leftIndices: number[] = [];
    const rightIndices: number[] = [];
    for (const i of indices) {
      if ((X[i]?.[best.featureIndex] ?? 0) <= best.threshold) {
        leftIndices.push(i);
      } else {
        rightIndices.push(i);
      }
    }

    return {
      featureIndex: best.featureIndex,
      threshold: best.threshold,
      left: this.#buildTree(X, y, leftIndices, depth + 1, importances),
      right: this.#buildTree(X, y, rightIndices, depth + 1, importances),
    };
  }

  #findBestSplit(
    X: number[][],
    y: number[],
    indices: number[],
  ): { featureIndex: number; threshold: number; gain: number } | null {
    const n = indices.length;
    const nFeatures = X[0]?.length ?? 0;

    const parentMean = meanOfIndices(y, indices);
    let parentVariance = 0;
    for (const i of indices) {
      parentVariance += ((y[i] ?? 0) - parentMean) ** 2;
    }

    let bestGain = 0;
    let bestFeature = -1;
    let bestThreshold = 0;

    for (let f = 0; f < nFeatures; f++) {
      // Sort indices by this feature's value
      const sorted = [...indices].sort((a, b) => (X[a]?.[f] ?? 0) - (X[b]?.[f] ?? 0));

      // Running sums for O(n) split evaluation
      let leftSum = 0;
      let leftSumSq = 0;
      let leftCount = 0;
      let rightSum = 0;
      let rightSumSq = 0;
      let rightCount = n;

      for (const i of sorted) {
        const val = y[i] ?? 0;
        rightSum += val;
        rightSumSq += val * val;
      }

      for (let s = 0; s < n - 1; s++) {
        const i = sorted[s];
        if (i === undefined) continue;
        const val = y[i] ?? 0;

        leftSum += val;
        leftSumSq += val * val;
        leftCount++;
        rightSum -= val;
        rightSumSq -= val * val;
        rightCount--;

        // Skip if same feature value as next (can't split here)
        const nextI = sorted[s + 1];
        if (nextI === undefined) continue;
        if ((X[i]?.[f] ?? 0) === (X[nextI]?.[f] ?? 0)) continue;

        // Skip if either side would be too small
        if (leftCount < this.#config.minSamplesLeaf || rightCount < this.#config.minSamplesLeaf) {
          continue;
        }

        // Variance reduction
        const leftVar = leftSumSq / leftCount - (leftSum / leftCount) ** 2;
        const rightVar = rightSumSq / rightCount - (rightSum / rightCount) ** 2;
        const weightedVar = (leftCount * leftVar + rightCount * rightVar) / n;
        const gain = parentVariance / n - weightedVar;

        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = f;
          bestThreshold = ((X[i]?.[f] ?? 0) + (X[nextI]?.[f] ?? 0)) / 2;
        }
      }
    }

    if (bestFeature === -1) return null;
    return {
      featureIndex: bestFeature,
      threshold: bestThreshold,
      gain: bestGain,
    };
  }
}

// ── Tree traversal ──────────────────────────────────────────────────────────

function predictNode(node: TreeNode, x: number[]): number {
  if (node.value !== undefined) return node.value;
  if (node.featureIndex === undefined || node.threshold === undefined) return 0;
  const featureVal = x[node.featureIndex] ?? 0;
  if (featureVal <= node.threshold) {
    return node.left ? predictNode(node.left, x) : 0;
  }
  return node.right ? predictNode(node.right, x) : 0;
}

// ── Serialization ───────────────────────────────────────────────────────────

function serializeNode(node: TreeNode): TreeNodeJSON {
  if (node.value !== undefined) return { v: node.value };
  return {
    f: node.featureIndex,
    t: node.threshold,
    l: node.left ? serializeNode(node.left) : undefined,
    r: node.right ? serializeNode(node.right) : undefined,
  };
}

function deserializeNode(json: TreeNodeJSON): TreeNode {
  if (json.v !== undefined) return { value: json.v };
  return {
    featureIndex: json.f,
    threshold: json.t,
    left: json.l ? deserializeNode(json.l) : undefined,
    right: json.r ? deserializeNode(json.r) : undefined,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function meanOfIndices(arr: number[], indices: number[]): number {
  if (indices.length === 0) return 0;
  let sum = 0;
  for (const i of indices) {
    sum += arr[i] ?? 0;
  }
  return sum / indices.length;
}
