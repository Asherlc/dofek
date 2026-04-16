# @dofek/training

Core training science engine for workload analysis, workout recommendations, and activity normalization.

## Implementation Details

### Workout Recommendation Engine (`workout-recommendation.ts`)
The `recommendNextWorkout` function is a pure logic engine that generates evidence-based training advice.
- **Polarized Model**: Targets ≤20% high-intensity volume (Zones 4/5) per the 80/20 polarized training model.
- **Muscle Recovery**: Tracks individual muscle group freshness (e.g., `UPPER_PUSH`, `UPPER_PULL`) with a 48h recovery requirement.
- **HRV-Guided**: Gates intensity based on `readinessScore` (Rest < 33, Easy < 50).
- **Interval Protocols**: Defines standard high-intensity sessions like "Norwegian 4x4" and "Billat 30/30".

### Training Stress & Performance (`training-load.ts`, `pmc.ts`)
- **Bannister TRIMP**: Implements `computeTrimp` using the standard exponential model.
- **hrTSS Fallback**: `computeHrTss` normalizes TRIMP to 1hr at threshold (85% Max HR).
- **TSS Modeling**: `TrainingStressCalculator.buildTssModel` uses linear regression (`powerTss = slope * trimp + intercept`) to learn the user's individual HR-to-Power relationship.
- **FTP Estimation**: `estimateFtp` uses the highest 20-minute average power multiplied by 0.95, intentionally avoiding Normalized Power (NP) to prevent overestimation from interval efforts.

### Power & Curve Analysis (`power-analysis.ts`)
- **Normalized Power (NP)**: Calculated using the 4th-power averaging method over a 30-second rolling window.
- **Power Curve**: `computePowerCurve` uses prefix sums to efficiently find the best average power across 14 standard durations (5s to 2h) in $O(N \times D)$ time.
- **Critical Power (CP)**: Fits Morton's 2-parameter model (Monod-Scherrer) using best efforts in the 120s–600s range.

### Terrain Adjustment (`grade-adjusted-pace.ts`)
Implements the **Minetti Cost Factor** model to normalize pace for elevation.
- **Uphill**: Cost factor increases linearly (`1 + grade * 3.5`).
- **Downhill**: Cost factor decreases (`1 - grade * 1.8`), floored at 0.5.

### Activity Normalization (`training.ts`, `endurance-types.ts`)
- **Canonical Mapping**: Maps disparate provider types (Strava, Garmin, Wahoo, Apple Health) to a single set of `CANONICAL_ACTIVITY_TYPES`.
- **Endurance Filter**: `isEnduranceActivity` identifies sports that contribute to cardiovascular training load (cycling, running, swimming, etc.).
- **Weekly Volume**: `collapseWeeklyVolumeActivityTypes` groups infrequent sports into "Other" to keep chart legends readable.
