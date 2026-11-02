# @dofek/cycling-power

Dependency-free TypeScript algorithms for elapsed cycling power, normalized
power, reference-curve estimation, intensity factor and training stress.
No database, application identifiers, providers, wire contracts, bundled
population coefficients, or application policy are part of this package.
Callers supply observations, reference curves and estimation/decay policy.

Install with `npm install @dofek/cycling-power`. The package is ESM, includes
TypeScript declarations and has no runtime dependencies.

```ts
import { normalizedPower, intensityFactor, powerTrainingStress } from "@dofek/cycling-power/power";
import { estimateThreshold } from "@dofek/cycling-power/threshold";

// Illustrative caller-selected coverage policy, in seconds.
const coveragePolicy = {
  maximumHoldSeconds: 10,
  minimumGapSeconds: 5,
  gapIntervalMultiplier: 2,
  maximumGapSeconds: 10,
};
const samples = Array.from({ length: 60 }, (_, elapsedSeconds) => ({
  elapsedSeconds,
  watts: 240,
}));
const np = normalizedPower(samples, 60, coveragePolicy); // 240 W

// Synthetic demonstration curves; supply your own independently justified bank.
const candidate = estimateThreshold(
  [{ durationSeconds: 600, watts: 240 }],
  [
    { criticalPowerWatts: 150, workCapacityJoules: 12000, timeOffsetSeconds: 60 },
    { criticalPowerWatts: 250, workCapacityJoules: 20000, timeOffsetSeconds: 60 },
  ],
  { minimumDurationSeconds: 300, maximumDurationSeconds: 1200, targetDurationSeconds: 3600 },
);
const threshold = candidate?.watts ?? null;
const intensity = intensityFactor(np, threshold);
const stress = powerTrainingStress(np, threshold, 60);
```

Public subpaths are `power`, `threshold`, `critical-power`, `regression` and
`resample-signal`. `threshold` also exports `projectThresholdHistory`, which
requires caller-selected comparison windows and decay policy. Curve matching
returns null outside the supplied reference bank or qualifying duration range.
A reference-curve prediction is a model estimate; this package supplies no
physiological validation, calibrated population bank or individual uncertainty.

The `critical-power` module fits the distinct critical-power model using an
explicit caller-supplied duration window. It uses the package's generic
`regression` module; neither module selects an FTP estimate. The model follows
[Monod and Scherrer's work-capacity relationship](https://doi.org/10.1080/00140136508930810).

Critical-power fitting returns CP and work capacity rounded to whole units.
Its diagnostic predictions, residuals and power-space RMSE use the full,
unrounded fit, with returned diagnostic values rounded to 0.1 watt. They are
not reconstructed from the rounded coefficients. The reported `r2` describes
the linearized **work-versus-time** regression, not observed-versus-predicted
power. Compare power-space residuals and RMSE when assessing power errors.
The generic regression function throws `RangeError` if finite inputs exceed
the arithmetic's finite range; critical-power fitting withholds such a model.

Normalized power uses complete 30-second windows, retaining zero power and
withholding results when elapsed coverage is incomplete. Its mathematical basis
is documented by [TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204071804-Normalized-Power).
Power TSS uses `(NP / eFTP)² × seconds / 36`, following the
[published definition](https://www.trainingpeaks.com/learn/articles/estimating-training-stress-score-tss/).

The `resample-signal` module returns sparse, complete one-second buckets with
elapsed-weighted values, native peaks and coverage. Both it and normalized power
require a nonnegative safe integer duration in seconds; fractional observation
offsets are supported. Callers choose hold and gap policy. Explicit nulls stop
coverage, including when a null shares a timestamp with a value. Conflicting
finite values at one timestamp raise a `RangeError` for the caller to resolve.
