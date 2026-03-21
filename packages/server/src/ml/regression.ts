/**
 * Multiple linear regression via Ordinary Least Squares (OLS).
 *
 * Solves β = (X'X)^(-1) X'y using Gaussian elimination.
 * Pure TypeScript, no external dependencies.
 */

export interface LinearRegressionJSON {
  coefficients: number[];
  intercept: number;
  rSquared: number;
  adjustedRSquared: number;
  featureImportances: number[];
  featureStdDevs: number[];
  targetStdDev: number;
  nSamples: number;
  nFeatures: number;
}

export class LinearRegression {
  coefficients: number[] = [];
  intercept = 0;
  rSquared = 0;
  adjustedRSquared = 0;
  featureImportances: number[] = [];

  #featureStdDevs: number[] = [];
  #targetStdDev = 0;
  #nSamples = 0;
  #nFeatures = 0;

  fit(X: number[][], y: number[]): void {
    const n = X.length;
    const p = X[0]?.length ?? 0;

    if (n !== y.length) {
      throw new Error(`X has ${n} rows but y has ${y.length} elements`);
    }
    if (n <= p) {
      throw new Error(`Need more samples (${n}) than features (${p}) for OLS`);
    }

    this.#nSamples = n;
    this.#nFeatures = p;

    // Add intercept column (column of 1s prepended)
    const augmented = X.map((row) => [1, ...row]);
    const cols = p + 1;

    // Compute X'X (cols × cols)
    const xtx = newMatrix(cols, cols);
    for (let i = 0; i < cols; i++) {
      for (let j = i; j < cols; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum += (augmented[k]?.[i] ?? 0) * (augmented[k]?.[j] ?? 0);
        }
        const xtxRow_i = xtx[i];
        const xtxRow_j = xtx[j];
        if (xtxRow_i) xtxRow_i[j] = sum;
        if (xtxRow_j) xtxRow_j[i] = sum; // symmetric
      }
    }

    // Compute X'y (cols × 1)
    const xty = new Array<number>(cols).fill(0);
    for (let i = 0; i < cols; i++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += (augmented[k]?.[i] ?? 0) * (y[k] ?? 0);
      }
      xty[i] = sum;
    }

    // Solve (X'X)β = X'y via Gaussian elimination with partial pivoting
    const beta = solveLinearSystem(xtx, xty);

    this.intercept = beta[0] ?? 0;
    this.coefficients = beta.slice(1);

    // Compute R² and adjusted R²
    const yMean = y.reduce((a, b) => a + b, 0) / n;
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < n; i++) {
      const row = X[i];
      if (!row) continue;
      const predicted = this.predict(row);
      ssRes += ((y[i] ?? 0) - predicted) ** 2;
      ssTot += ((y[i] ?? 0) - yMean) ** 2;
    }
    this.rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    this.adjustedRSquared = ssTot === 0 ? 1 : 1 - ((1 - this.rSquared) * (n - 1)) / (n - p - 1);

    // Feature importances: standardized coefficients (|βᵢ * σ(xᵢ) / σ(y)|)
    this.#featureStdDevs = [];
    for (let j = 0; j < p; j++) {
      const col = X.map((row) => row[j] ?? 0);
      this.#featureStdDevs.push(stdDev(col));
    }
    this.#targetStdDev = stdDev(y);

    this.featureImportances = this.coefficients.map((coef, j) => {
      if (this.#targetStdDev === 0) return 0;
      return Math.abs((coef * (this.#featureStdDevs[j] ?? 0)) / this.#targetStdDev);
    });
  }

  predict(x: number[]): number {
    let result = this.intercept;
    for (let i = 0; i < this.coefficients.length; i++) {
      result += (this.coefficients[i] ?? 0) * (x[i] ?? 0);
    }
    return result;
  }

  toJSON(): LinearRegressionJSON {
    return {
      coefficients: this.coefficients,
      intercept: this.intercept,
      rSquared: this.rSquared,
      adjustedRSquared: this.adjustedRSquared,
      featureImportances: this.featureImportances,
      featureStdDevs: this.#featureStdDevs,
      targetStdDev: this.#targetStdDev,
      nSamples: this.#nSamples,
      nFeatures: this.#nFeatures,
    };
  }

  static fromJSON(json: LinearRegressionJSON): LinearRegression {
    const model = new LinearRegression();
    model.coefficients = json.coefficients;
    model.intercept = json.intercept;
    model.rSquared = json.rSquared;
    model.adjustedRSquared = json.adjustedRSquared;
    model.featureImportances = json.featureImportances;
    model.#featureStdDevs = json.featureStdDevs;
    model.#targetStdDev = json.targetStdDev;
    model.#nSamples = json.nSamples;
    model.#nFeatures = json.nFeatures;
    return model;
  }
}

// ── Matrix helpers ──────────────────────────────────────────────────────────

function newMatrix(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

function stdDev(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Solve Ax = b via Gaussian elimination with partial pivoting.
 * Modifies A and b in place.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;

  // Forward elimination
  for (let col = 0; col < n; col++) {
    // Partial pivoting: find row with largest absolute value in this column
    let maxVal = Math.abs(A[col]?.[col] ?? 0);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(A[row]?.[col] ?? 0);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }

    // Swap rows
    if (maxRow !== col) {
      const tmpA = A[maxRow] ?? [];
      A[maxRow] = A[col] ?? [];
      A[col] = tmpA;
      const tmpB = b[maxRow] ?? 0;
      b[maxRow] = b[col] ?? 0;
      b[col] = tmpB;
    }

    const pivot = A[col]?.[col] ?? 0;
    if (Math.abs(pivot) < 1e-12) {
      throw new Error("Singular matrix — features may be collinear");
    }

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const aRow = A[row];
      if (!aRow) continue;
      const factor = (aRow[col] ?? 0) / pivot;
      for (let j = col; j < n; j++) {
        aRow[j] = (aRow[j] ?? 0) - factor * (A[col]?.[j] ?? 0);
      }
      b[row] = (b[row] ?? 0) - factor * (b[col] ?? 0);
    }
  }

  // Back substitution
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i] ?? 0;
    for (let j = i + 1; j < n; j++) {
      sum -= (A[i]?.[j] ?? 0) * (x[j] ?? 0);
    }
    x[i] = sum / (A[i]?.[i] ?? 1);
  }

  return x;
}
